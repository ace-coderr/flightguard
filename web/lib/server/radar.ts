/**
 * Live delay radar: airlabs.co's Flight Delays endpoint (v9/delays), filtered to the same
 * >=120min threshold FlightGuard.settle() pays out on — "would this have paid out" framing
 * only makes sense next to the contract's actual DELAY_THRESHOLD_MIN.
 */

const DELAY_THRESHOLD_MIN = 120; // mirrors FlightGuard.DELAY_THRESHOLD_MIN
const CACHE_TTL_MS = 10 * 60 * 1000;
const RESULT_LIMIT = 30;

export type DelayedFlight = {
  flightIata: string;
  airlineIata: string | null;
  depIata: string | null;
  arrIata: string | null;
  delayMinutes: number;
  status: string;
};

type AirlabsDelayEntry = {
  flight_iata?: string;
  airline_iata?: string;
  dep_iata?: string;
  arr_iata?: string;
  delayed?: number;
  status?: string;
};

let cache: { fetchedAt: number; flights: DelayedFlight[] } | null = null;
let inFlight: Promise<DelayedFlight[]> | null = null;

async function fetchDelayedFlights(): Promise<DelayedFlight[]> {
  const apiKey = process.env.FLIGHT_API_KEY;
  if (!apiKey) throw new Error("Server is missing FLIGHT_API_KEY");

  const url = `https://airlabs.co/api/v9/delays?${new URLSearchParams({
    api_key: apiKey,
    delay: String(DELAY_THRESHOLD_MIN),
    type: "arrivals",
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`airlabs responded ${res.status} ${res.statusText}`);

  const json = (await res.json()) as { response?: AirlabsDelayEntry[] };
  const entries = json.response ?? [];

  return entries
    .map((e): DelayedFlight | null => {
      if (!e.flight_iata || typeof e.delayed !== "number") return null;
      return {
        flightIata: e.flight_iata,
        airlineIata: e.airline_iata ?? null,
        depIata: e.dep_iata ?? null,
        arrIata: e.arr_iata ?? null,
        delayMinutes: e.delayed,
        status: e.status ?? "unknown",
      };
    })
    .filter((f): f is DelayedFlight => f !== null && f.delayMinutes >= DELAY_THRESHOLD_MIN)
    .sort((a, b) => b.delayMinutes - a.delayMinutes)
    .slice(0, RESULT_LIMIT);
}

/** In-memory, per-server-instance cache — good enough for a 10min-freshness radar without
 *  standing up a DB. inFlight dedupes concurrent cache-miss requests into one airlabs call. */
export async function getDelayedFlights(): Promise<{ flights: DelayedFlight[]; fetchedAt: number }> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (!inFlight) {
    inFlight = fetchDelayedFlights().finally(() => {
      inFlight = null;
    });
  }
  const flights = await inFlight;
  cache = { fetchedAt: now, flights };
  return cache;
}
