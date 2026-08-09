import { NextRequest, NextResponse } from "next/server";
import { validateFlightInput } from "@/lib/server/flightRequest";
import {
    normalizeAirlabs,
    resolveFlightStatus,
    resolveFromObservations,
    type Observation,
} from "@/lib/server/flightSources";

/**
 * Public, unauthenticated pass-through to flight-status data - this is the URL
 * scripts/fdc-attest-flight.ts / web/lib/server/flightRequest.ts attest via FDC's
 * Web2Json attestation type, so an FDC verifier node (not our own frontend) must be able
 * to reach it with no credentials. Its job is to keep FLIGHT_API_KEY out of the attested
 * request's queryParams (and therefore off-chain-visible calldata). Everything else in
 * airlabs' payload is dropped (see stripUpstreamSecrets) - notably `.request.key.api_key`,
 * which airlabs echoes back in its own response and would otherwise leak our key to
 * anyone calling this public endpoint.
 *
 * The response carries two things:
 *  - `.response` - the raw primary (airlabs) block, byte-shape unchanged. Policies bought
 *    under the pre-provenance request scheme still settle off this, so it must stay.
 *  - `.resolved` - the multi-source resolution the current scheme attests, including which
 *    source answered and whether a second one corroborated it. See lib/server/flightSources.
 *
 * The secondary source is optional: with no AVIATIONSTACK_API_KEY set this degrades to
 * single-source and says so honestly in `.resolved.source` / `.resolved.corroborated`.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

// In-memory, per-server-instance limiter - good enough to blunt casual abuse/API-quota
// burn without a DB; a cold serverless instance just starts a fresh window (same
// trade-off web/lib/server/radar.ts already makes for its cache).
const hits = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > RATE_LIMIT_MAX;
}

function clientKey(req: NextRequest): string {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// Guards against airlabs silently changing its response shape out from under the jq
// filter every attested request (past and future) depends on: neither key existing
// means this isn't the flight object shape postProcessJq expects.
function hasExpectedShape(json: unknown): boolean {
    if (!json || typeof json !== "object") return false;
    const j = json as Record<string, unknown>;
    return typeof j.response === "object" || typeof j.error === "object";
}

// airlabs echoes the request it received - including api_key - back under `.request` in
// its own response body (see `.request.key.api_key`). postProcessJq never reads that
// field, but this route is public/unauthenticated, so passing it through verbatim would
// hand FLIGHT_API_KEY to anyone who calls this endpoint. Only forward what postProcessJq
// actually reads (`.response.*`, `.error.message`).
function stripUpstreamSecrets(json: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    if (typeof json.response === "object") out.response = json.response;
    if (typeof json.error === "object") out.error = json.error;
    return out;
}

export async function GET(req: NextRequest) {
    if (isRateLimited(clientKey(req))) {
        return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "Server is missing FLIGHT_API_KEY" }, { status: 500 });
    }

    const flightIataRaw = req.nextUrl.searchParams.get("flight_iata");
    const dateRaw = req.nextUrl.searchParams.get("date");
    if (typeof flightIataRaw !== "string" || typeof dateRaw !== "string") {
        return NextResponse.json({ error: "flight_iata and date are required" }, { status: 400 });
    }

    let flightIata: string;
    let date: string;
    try {
        // date isn't sent to airlabs (its /v9/flight endpoint isn't date-scoped), but it does
        // select which occurrence each source's reading has to be about, and the attested jq
        // independently re-checks it against `.resolved.date` - so the date-lock stays
        // verifier-enforced, not merely proxy-enforced.
        ({ flightIata, date } = validateFlightInput(flightIataRaw, dateRaw));
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }

    const url = `https://airlabs.co/api/v9/flight?${new URLSearchParams({
        api_key: apiKey,
        flight_iata: flightIata,
    })}`;

    let upstream: Response;
    try {
        upstream = await fetch(url);
    } catch {
        return NextResponse.json({ error: "Failed to reach upstream flight data provider" }, { status: 502 });
    }

    const json = await upstream.json().catch(() => null);
    if (!hasExpectedShape(json)) {
        return NextResponse.json({ error: "Unexpected upstream response shape" }, { status: 502 });
    }

    const primaryBlock = stripUpstreamSecrets(json as Record<string, unknown>);

    // Resolve across sources. The primary was already fetched above (its raw block has to be
    // passed through for the legacy request scheme), so it is handed in rather than fetched
    // twice; only the metered secondary is called here, and only when the primary has nothing
    // usable for this date - or when corroboration is explicitly switched on.
    const primary: Observation | null = normalizeAirlabs(primaryBlock);
    const fallbackKey = process.env.AVIATIONSTACK_API_KEY;
    const corroborate = process.env.FLIGHT_CORROBORATE === "true";

    const resolved = fallbackKey
        ? await resolveFlightStatus({
              flightIata,
              date,
              airlabsKey: apiKey,
              aviationstackKey: fallbackKey,
              corroborate,
              knownPrimary: primary,
          })
        : resolveFromObservations(primary, null, date);

    return NextResponse.json({ ...primaryBlock, resolved }, { status: upstream.status });
}
