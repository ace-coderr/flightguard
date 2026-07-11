import { NextRequest, NextResponse } from "next/server";
import { validateFlightInput } from "@/lib/server/flightRequest";

/**
 * Public, unauthenticated pass-through to airlabs.co/v9/flight - this is the URL
 * scripts/fdc-attest-flight.ts / web/lib/server/flightRequest.ts attest via FDC's
 * Web2Json attestation type, so an FDC verifier node (not our own frontend) must be able
 * to reach it with no credentials. Its only job is to keep FLIGHT_API_KEY out of the
 * attested request's queryParams (and therefore off-chain-visible calldata) while
 * returning byte-for-byte the same {response: {...}}/{error: {...}} shape airlabs.co
 * itself returns, so postProcessJq (see buildPostProcessJq) doesn't need to change.
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
    try {
        // date isn't sent to airlabs (its /v9/flight endpoint isn't date-scoped - the
        // date-lock is enforced downstream by postProcessJq), but is still shape-validated
        // here since it's part of the attested queryParams and must match what the FDC
        // verifier fetched byte-for-byte.
        ({ flightIata } = validateFlightInput(flightIataRaw, dateRaw));
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

    return NextResponse.json(json, { status: upstream.status });
}
