import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

/**
 * Mirrors scripts/fdc-attest-flight.ts buildFlightRequestBody / computeRequestHash.
 * Must stay byte-for-byte identical or requestHash won't match what settle() expects
 * from the FDC proof's requestBody at claim time.
 */

const headers = `{"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}`;
const httpMethod = "GET";
const body = "{}";

// Current scheme: four fields, adding which source answered and whether a second one
// corroborated it, so a settlement's evidentiary basis is attested rather than assumed.
// Confirmed accepted by the live testnet verifier (including the `bool`) before adoption.
const abiSignature = `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"},{"internalType":"string","name":"source","type":"string"},{"internalType":"bool","name":"corroborated","type":"bool"}],"name":"dto","type":"tuple"}`;

// Pre-provenance scheme: two fields, read straight off the raw airlabs block. Policies
// bought before the multi-source proxy existed still settle under this, so the proxy keeps
// passing `.response` through untouched.
const legacyAbiSignature = `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"}],"name":"dto","type":"tuple"}`;

// The date-check is duplicated into every field rather than bound once via
// `EXPR as $match | ...`: the FDC Web2Json verifier's jq engine rejects `as $var` variable
// bindings outright (confirmed live against the testnet verifier - it returns "INVALID:
// INVALID JQ FILTER" for that syntax specifically, independent of the rest of the filter).
//
// The lock is on `.resolved.date`, the departure date (UTC) of the occurrence the proxy
// actually resolved across its sources. Checking it here rather than trusting the proxy is
// the point: the verifier itself refuses any reading that isn't about the attested date, so
// a proof about another day's occurrence of the same flight number degrades to a fixed
// ("EMPTY", 0, "none", false) - never a payout - instead of settling the wrong instance.
//
// Every field also carries a `//` default, so a proxy that returns no `.resolved` block at
// all (an older deployment, or an outage) degrades the same safe way rather than failing the
// attestation outright.
function buildPostProcessJq(date: string) {
    const matched = `(.resolved.date // "") == "${date}"`;
    return (
        `{flightStatus: (if ${matched} then (.resolved.flightStatus // "EMPTY") else "EMPTY" end), ` +
        `delayMinutes: (if ${matched} then (.resolved.delayMinutes // 0) else 0 end), ` +
        `source: (if ${matched} then (.resolved.source // "none") else "none" end), ` +
        `corroborated: (if ${matched} then (.resolved.corroborated // false) else false end)}`
    );
}

// dep_time_utc (scheduled departure, UTC) anchored the pre-provenance date-lock instead of
// arr_time_utc: it's stable across delays/cancellations, whereas arr_time_utc can be missing
// entirely for a cancelled flight and, for overnight flights, falls on the *next* UTC date -
// which would never match a lock keyed on the departure date.
function buildLegacyPostProcessJq(date: string) {
    const matched = `(.response.dep_time_utc // "" | startswith("${date}"))`;
    return `{flightStatus: (if ${matched} then (.response.status // .error.message // "EMPTY") else "EMPTY" end), delayMinutes: (if ${matched} then (.response.arr_delayed // 0) else 0 end)}`;
}

export type FlightRequestBody = ReturnType<typeof buildFlightRequestBody>;

export const FLIGHT_PROXY_PATH = "/api/flight-proxy";

function proxyBaseUrl(): string {
    const base = process.env.NEXT_PUBLIC_APP_URL;
    if (!base) throw new Error("Missing NEXT_PUBLIC_APP_URL");
    return base.replace(/\/$/, "");
}

/**
 * Current request scheme: attests our own GET /api/flight-proxy instead of airlabs.co
 * directly, so no api_key ever appears in FDC calldata (the proxy holds it server-side).
 * Must stay byte-for-byte identical to scripts/fdc-attest-flight.ts's buildFlightRequestBody.
 */
export function buildFlightRequestBody(flightIata: string, date: string) {
    return {
        url: `${proxyBaseUrl()}${FLIGHT_PROXY_PATH}`,
        httpMethod,
        headers,
        queryParams: JSON.stringify({ flight_iata: flightIata, date }),
        body,
        postProcessJq: buildPostProcessJq(date),
        abiSignature,
    };
}

/**
 * Pre-provenance scheme: same proxy URL, but the two-field DTO read straight off `.response`.
 * Policies bought before the multi-source resolver existed carry this requestHash.
 */
export function buildPreProvenanceRequestBody(flightIata: string, date: string) {
    return {
        url: `${proxyBaseUrl()}${FLIGHT_PROXY_PATH}`,
        httpMethod,
        headers,
        queryParams: JSON.stringify({ flight_iata: flightIata, date }),
        body,
        postProcessJq: buildLegacyPostProcessJq(date),
        abiSignature: legacyAbiSignature,
    };
}

/**
 * Pre-proxy request scheme (api_key in queryParams, hitting airlabs.co directly). Kept
 * only so the keeper/settle flow can still recognise policies bought before the
 * flight-proxy existed - remove once those policies have aged past CLAIM_WINDOW.
 */
export function buildLegacyFlightRequestBody(flightIata: string, date: string, apiKey: string) {
    return {
        url: `https://airlabs.co/api/v9/flight`,
        httpMethod,
        headers,
        queryParams: JSON.stringify({ api_key: apiKey, flight_iata: flightIata }),
        body,
        postProcessJq: buildLegacyPostProcessJq(date),
        abiSignature: legacyAbiSignature,
    };
}

export function computeRequestHash(requestBody: {
    url: string;
    headers: string;
    queryParams: string;
    postProcessJq: string;
    abiSignature: string;
}) {
    return keccak256(
        encodeAbiParameters(parseAbiParameters("string, string, string, string, string"), [
            requestBody.url,
            requestBody.headers,
            requestBody.queryParams,
            requestBody.postProcessJq,
            requestBody.abiSignature,
        ])
    );
}

export type RequestScheme = "provenance" | "pre-provenance" | "legacy";
export type ResolvedFlightRequest = { requestBody: FlightRequestBody; scheme: RequestScheme };

/**
 * Picks whichever request scheme hashes to `expectedRequestHash`. Returns null if none
 * matches (e.g. a malformed/foreign requestHash), so callers can skip instead of wasting an
 * on-chain attestation submission on a request that could never settle it.
 *
 * Only "provenance" is settleable by the current contract: the older schemes attest a
 * two-field DTO, and `abi.decode`-ing those bytes into the current four-field FlightDto
 * reverts on bounds. They're still recognised here so a caller can report *why* a policy is
 * unsettleable rather than reporting an opaque hash mismatch.
 */
export function resolveFlightRequestBody(
    flightIata: string,
    date: string,
    expectedRequestHash: `0x${string}`,
    legacyApiKey: string
): ResolvedFlightRequest | null {
    const proxyBody = buildFlightRequestBody(flightIata, date);
    if (computeRequestHash(proxyBody) === expectedRequestHash) {
        return { requestBody: proxyBody, scheme: "provenance" };
    }
    const preProvenanceBody = buildPreProvenanceRequestBody(flightIata, date);
    if (computeRequestHash(preProvenanceBody) === expectedRequestHash) {
        return { requestBody: preProvenanceBody, scheme: "pre-provenance" };
    }
    const legacyBody = buildLegacyFlightRequestBody(flightIata, date, legacyApiKey);
    if (computeRequestHash(legacyBody) === expectedRequestHash) {
        return { requestBody: legacyBody, scheme: "legacy" };
    }
    return null;
}

const IATA_FLIGHT_NUMBER_RE = /^[A-Z0-9]{2,3}[0-9]{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateFlightIata(flightIata: string): string {
    const normalizedIata = flightIata.trim().toUpperCase();
    if (!IATA_FLIGHT_NUMBER_RE.test(normalizedIata)) {
        throw new Error("Invalid flight number. Expected IATA format, e.g. BA75.");
    }
    return normalizedIata;
}

export function validateFlightInput(flightIata: string, date: string) {
    const normalizedIata = validateFlightIata(flightIata);
    if (!DATE_RE.test(date)) {
        throw new Error("Invalid date. Expected YYYY-MM-DD.");
    }
    return { flightIata: normalizedIata, date };
}

/** Onchain-storable flight identity for a policy, e.g. "BA75|2026-07-11" — lets the
 *  keeper rebuild a policy's exact FDC request without any offchain/browser state. Must
 *  hold the departure date used by the jq date-lock (see buildPostProcessJq), not
 *  whatever date the buyer originally typed. */
export function buildFlightRef(flightIata: string, date: string): string {
    return `${flightIata}|${date}`;
}

export function parseFlightRef(flightRef: string): { flightIata: string; date: string } {
    const [flightIata, date] = flightRef.split("|");
    if (!flightIata || !date) {
        throw new Error(`Malformed flightRef: ${flightRef}`);
    }
    return validateFlightInput(flightIata, date);
}

/** The airlabs.co /v9/flight fields this app relies on (subset of the real response). */
type AirlabsFlightResponse = {
    status?: string;
    dep_iata?: string;
    arr_iata?: string;
    dep_time_utc?: string;
    arr_time_utc?: string;
};

export type FlightLookup = {
    status: string;
    depIata: string | null;
    arrIata: string | null;
    depTimeUtc: string;
    arrTimeUtc: string | null;
};

/**
 * Looks up a flight's current schedule from airlabs.co /v9/flight (same endpoint the FDC
 * attestation itself hits, minus the User-Agent header, which is FDC-verifier-specific).
 * Returns null when the API has no record for this flight number, or is missing
 * dep_time_utc - the one field we require, since it anchors both the jq date-lock and the
 * policy's flightRef and is always present for a real, scheduled flight.
 */
export async function fetchFlight(flightIata: string, apiKey: string): Promise<FlightLookup | null> {
    const url = `https://airlabs.co/api/v9/flight?${new URLSearchParams({
        api_key: apiKey,
        flight_iata: flightIata,
    })}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = (await res.json()) as { response?: AirlabsFlightResponse };
    const r = json.response;
    if (!r || typeof r.dep_time_utc !== "string") return null;

    return {
        status: r.status ?? "unknown",
        depIata: r.dep_iata ?? null,
        arrIata: r.arr_iata ?? null,
        depTimeUtc: r.dep_time_utc,
        arrTimeUtc: typeof r.arr_time_utc === "string" ? r.arr_time_utc : null,
    };
}

/** "YYYY-MM-DD HH:MM" (airlabs' UTC timestamp format) -> "YYYY-MM-DD". */
export function utcDateOnly(timeUtc: string): string {
    return timeUtc.slice(0, 10);
}

const SETTLEMENT_BUFFER_SEC = 30 * 60;

/**
 * Real scheduled-arrival unix timestamp (+30 min settlement buffer) from a flight lookup,
 * replacing the old end-of-UTC-day placeholder that delayed settlement by hours. Requires
 * arrTimeUtc: a flight with no scheduled arrival yet can't be quoted, since buyCover needs
 * a concrete deadline to gate settle()/expire() on. Returns null in that case so the caller
 * can reject the quote instead of guessing.
 */
export function scheduledArrivalFromFlight(flight: FlightLookup): number | null {
    if (!flight.arrTimeUtc) return null;
    const ts = Date.parse(`${flight.arrTimeUtc.replace(" ", "T")}Z`);
    if (Number.isNaN(ts)) return null;
    return Math.floor(ts / 1000) + SETTLEMENT_BUFFER_SEC;
}
