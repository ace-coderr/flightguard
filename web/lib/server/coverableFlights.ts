/**
 * Suggested "known good" flight numbers a judge can click straight into a working quote,
 * without having to already know which real-world flights are still airborne. airlabs' free
 * tier has no forward-schedule endpoint, so "coverable" can only be determined by looking up
 * each candidate's current/most-recent instance live and keeping the ones whose scheduled
 * arrival hasn't happened yet - the same live lookup /api/flight-request itself relies on.
 */
import { fetchFlight, scheduledArrivalFromFlight, utcDateOnly } from "./flightRequest";

const CANDIDATE_FLIGHT_NUMBERS = ["SQ23", "SQ21", "QF9", "QR920", "QR921", "CZ8031", "EK1", "EK2", "UA1", "NZ2"];
const CACHE_TTL_MS = 10 * 60 * 1000;

export type CoverableFlight = {
    flightIata: string;
    depIata: string | null;
    arrIata: string | null;
    date: string;
    scheduledArrival: number;
};

let cache: { fetchedAt: number; flights: CoverableFlight[] } | null = null;
let inFlight: Promise<CoverableFlight[]> | null = null;

async function fetchCoverableFlights(): Promise<CoverableFlight[]> {
    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) throw new Error("Server is missing FLIGHT_API_KEY");

    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.allSettled(
        CANDIDATE_FLIGHT_NUMBERS.map((flightIata) => fetchFlight(flightIata, apiKey))
    );

    const flights: CoverableFlight[] = [];
    results.forEach((result, i) => {
        if (result.status !== "fulfilled" || !result.value) return;
        const flight = result.value;
        const scheduledArrival = scheduledArrivalFromFlight(flight);
        if (scheduledArrival === null || scheduledArrival <= now) return;
        flights.push({
            flightIata: CANDIDATE_FLIGHT_NUMBERS[i],
            depIata: flight.depIata,
            arrIata: flight.arrIata,
            date: utcDateOnly(flight.depTimeUtc),
            scheduledArrival,
        });
    });

    return flights.sort((a, b) => a.scheduledArrival - b.scheduledArrival);
}

/** Same in-memory cache/inFlight-dedup pattern as lib/server/radar.ts. */
export async function getCoverableFlights(): Promise<{ flights: CoverableFlight[]; fetchedAt: number }> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return cache;
    }
    if (!inFlight) {
        inFlight = fetchCoverableFlights().finally(() => {
            inFlight = null;
        });
    }
    const flights = await inFlight;
    cache = { fetchedAt: now, flights };
    return cache;
}
