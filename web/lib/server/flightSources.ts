/**
 * Multi-source flight-status resolution.
 *
 * FlightGuard settles on ONE FDC Web2Json attestation, and jq cannot make HTTP calls — so a
 * "try source A, fall back to source B" chain cannot live in postProcessJq. It lives here
 * instead, inside the first-party proxy that FDC actually attests: this module queries the
 * primary source, falls back to a secondary when the primary has nothing usable, and returns
 * a single pre-resolved block that the attested jq reads. From FDC's point of view that is
 * still one URL, one proof, one settlement.
 *
 * What this does and does not buy, stated plainly:
 *  - It buys AVAILABILITY. A flight the primary has no record of no longer silently settles
 *    as "no payout"; the secondary can answer instead.
 *  - It does NOT buy INTEGRITY. FDC attests "this URL returned these bytes"; this proxy is
 *    still the single trusted aggregator either way. Real integrity would require two
 *    independently attested URLs cross-checked onchain (two attestations).
 *
 * Because of that, the resolution reports its own provenance (`source`, `corroborated`)
 * into the attested payload, so the settlement's evidentiary basis is visible onchain
 * rather than assumed. See FlightGuard.Provenance.
 */

const SEVERE_DELAY_MIN = 120; // mirrors FlightGuard.DELAY_THRESHOLD_MIN

export type FlightSourceName = "airlabs" | "aviationstack" | "none";

/** One source's normalized reading of a flight. */
export type Observation = {
    source: FlightSourceName;
    depDateUtc: string; // YYYY-MM-DD, scheduled departure date in UTC
    status: string; // "landed" | "cancelled" | "active" | ...
    delayMinutes: number; // arrival delay, 0 when on time or unknown
};

export type ResolvedFlight = {
    date: string | null; // null when nothing usable resolved
    flightStatus: string;
    delayMinutes: number;
    source: FlightSourceName;
    corroborated: boolean;
};

export const UNRESOLVED: ResolvedFlight = {
    date: null,
    flightStatus: "EMPTY",
    delayMinutes: 0,
    source: "none",
    corroborated: false,
};

/**
 * The only thing the contract actually decides on. Two sources "agree" when they imply the
 * same payout outcome — not when every field matches, since sources legitimately differ on
 * status vocabulary ("en-route" vs "active") and on delay by a minute or two.
 */
export function payoutDecision(o: Pick<Observation, "status" | "delayMinutes">): boolean {
    return o.status === "cancelled" || o.delayMinutes >= SEVERE_DELAY_MIN;
}

// ---------- source adapters ----------

type AirlabsFlight = {
    dep_time_utc?: string;
    status?: string;
    arr_delayed?: number | null;
};

/** airlabs /v9/flight returns the flight's latest occurrence as a single object. */
export function normalizeAirlabs(json: unknown): Observation | null {
    const r = (json as { response?: AirlabsFlight } | null)?.response;
    if (!r || typeof r.dep_time_utc !== "string") return null;
    return {
        source: "airlabs",
        depDateUtc: r.dep_time_utc.slice(0, 10),
        status: typeof r.status === "string" ? r.status : "unknown",
        delayMinutes: typeof r.arr_delayed === "number" ? r.arr_delayed : 0,
    };
}

type AviationstackFlight = {
    flight_date?: string;
    flight_status?: string;
    departure?: { scheduled?: string };
    arrival?: { delay?: number | null };
};

/**
 * aviationstack /v1/flights returns an ARRAY of occurrences under .data, so the one matching
 * the requested departure date has to be picked out here — its free tier has no historical
 * (flight_date) filter, so the narrowing cannot be pushed upstream.
 */
export function normalizeAviationstack(json: unknown, date: string): Observation | null {
    const rows = (json as { data?: AviationstackFlight[] } | null)?.data;
    if (!Array.isArray(rows)) return null;

    for (const row of rows) {
        const rowDate =
            typeof row.flight_date === "string"
                ? row.flight_date
                : typeof row.departure?.scheduled === "string"
                  ? row.departure.scheduled.slice(0, 10)
                  : null;
        if (rowDate !== date) continue;

        return {
            source: "aviationstack",
            depDateUtc: rowDate,
            status: typeof row.flight_status === "string" ? row.flight_status : "unknown",
            delayMinutes: typeof row.arrival?.delay === "number" ? row.arrival.delay : 0,
        };
    }
    return null;
}

// ---------- fallback fetching (metered upstream, so guarded) ----------

const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;
const fallbackCache = new Map<string, { at: number; observation: Observation | null }>();

/**
 * A single FDC attestation is fetched independently by several verifier nodes, so one
 * settlement means several hits on this proxy. aviationstack's free tier is 100 requests a
 * month and bills overage beyond it, so those hits are collapsed onto one upstream call.
 * Consistency is the second win: verifiers within the TTL all see the same reading, which is
 * what the round needs to reach consensus. Per-instance and in-memory, same trade-off
 * radar.ts already documents.
 */
async function fetchAviationstack(flightIata: string, date: string, apiKey: string): Promise<Observation | null> {
    const key = `${flightIata}|${date}`;
    const hit = fallbackCache.get(key);
    if (hit && Date.now() - hit.at < FALLBACK_CACHE_TTL_MS) return hit.observation;

    let observation: Observation | null = null;
    try {
        const url = `https://api.aviationstack.com/v1/flights?${new URLSearchParams({
            access_key: apiKey,
            flight_iata: flightIata,
        })}`;
        const res = await fetch(url);
        if (res.ok) observation = normalizeAviationstack(await res.json(), date);
    } catch {
        observation = null; // a dead fallback must never break the primary path
    }

    fallbackCache.set(key, { at: Date.now(), observation });
    return observation;
}

async function fetchAirlabs(flightIata: string, apiKey: string): Promise<Observation | null> {
    try {
        const url = `https://airlabs.co/api/v9/flight?${new URLSearchParams({
            api_key: apiKey,
            flight_iata: flightIata,
        })}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return normalizeAirlabs(await res.json());
    } catch {
        return null;
    }
}

// ---------- resolution ----------

/** Usable == this source is talking about the flight-date we asked about. */
function usable(o: Observation | null, date: string): o is Observation {
    return o !== null && o.depDateUtc === date;
}

/**
 * Combines the two sources into the block the attested jq reads.
 *
 * `corroborated` means strictly: a second, independent source produced the SAME payout
 * decision. Absence of a second source and disagreement between sources both yield false —
 * in neither case has the reading actually been corroborated, and conflating "unavailable"
 * with "contradicted" would overclaim. Which of the two it was is logged server-side and,
 * for disagreement, is the more interesting signal.
 */
export function resolveFromObservations(
    primary: Observation | null,
    fallback: Observation | null,
    date: string
): ResolvedFlight {
    const primaryOk = usable(primary, date);
    const fallbackOk = usable(fallback, date);

    if (!primaryOk && !fallbackOk) return UNRESOLVED;

    // The primary is authoritative when usable; the fallback only ever substitutes for it or
    // corroborates it, so a disagreement never silently flips the payout either way.
    const chosen = primaryOk ? primary : (fallback as Observation);
    const other = primaryOk && fallbackOk ? fallback : null;
    const corroborated = other !== null && payoutDecision(other) === payoutDecision(chosen);

    return {
        date: chosen.depDateUtc,
        flightStatus: chosen.status,
        delayMinutes: chosen.delayMinutes,
        source: chosen.source,
        corroborated,
    };
}

export type ResolveOptions = {
    flightIata: string;
    date: string;
    airlabsKey: string;
    aviationstackKey?: string;
    /** Query the secondary even when the primary answered, to corroborate rather than just
     *  substitute. Off by default: the secondary is metered, and this would call it on every
     *  settlement instead of only on primary outages. */
    corroborate?: boolean;
    /** Primary reading the caller already has (the proxy fetches airlabs itself to preserve
     *  the raw `.response` passthrough); skips re-fetching it. Pass null to mean "already
     *  tried, nothing usable" - undefined means "not tried yet". */
    knownPrimary?: Observation | null;
};

export async function resolveFlightStatus(opts: ResolveOptions): Promise<ResolvedFlight> {
    const { flightIata, date, airlabsKey, aviationstackKey, corroborate = false, knownPrimary } = opts;

    const primary = knownPrimary !== undefined ? knownPrimary : await fetchAirlabs(flightIata, airlabsKey);
    const primaryOk = usable(primary, date);

    let fallback: Observation | null = null;
    if (aviationstackKey && (!primaryOk || corroborate)) {
        fallback = await fetchAviationstack(flightIata, date, aviationstackKey);
    }

    const resolved = resolveFromObservations(primary, fallback, date);

    if (primaryOk && usable(fallback, date) && !resolved.corroborated) {
        console.warn(
            `[flight-sources] ${flightIata} ${date}: sources disagree on the payout decision — ` +
                `airlabs(${primary.status}, ${primary.delayMinutes}min) vs ` +
                `aviationstack(${fallback.status}, ${fallback.delayMinutes}min); using airlabs, not corroborated`
        );
    }
    if (!primaryOk && resolved.source === "aviationstack") {
        console.warn(
            `[flight-sources] ${flightIata} ${date}: primary had no usable record, fell back to aviationstack`
        );
    }

    return resolved;
}
