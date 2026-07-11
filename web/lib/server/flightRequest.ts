import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

/**
 * Mirrors scripts/fdc-attest-flight.ts buildFlightRequestBody / computeRequestHash.
 * Must stay byte-for-byte identical or requestHash won't match what settle() expects
 * from the FDC proof's requestBody at claim time.
 */

const headers = `{"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}`;
const httpMethod = "GET";
const body = "{}";

const abiSignature = `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"}],"name":"dto","type":"tuple"}`;

// dep_time_utc (scheduled departure, UTC) anchors the date-lock instead of arr_time_utc:
// it's stable across delays/cancellations, whereas arr_time_utc can be missing entirely
// for a cancelled flight and, for overnight flights, falls on the *next* UTC date - which
// would never match a lock keyed on the departure date. If the attested response is about
// a different day's occurrence of this flight number, this degrades to a fixed "EMPTY"/0
// output (never a payout) instead of failing the attestation outright.
function buildPostProcessJq(date: string) {
  return `(.response.dep_time_utc // "" | startswith("${date}")) as $match | {flightStatus: (if $match then (.response.status // .error.message // "EMPTY") else "EMPTY" end), delayMinutes: (if $match then (.response.arr_delayed // 0) else 0 end)}`;
}

export type FlightRequestBody = ReturnType<typeof buildFlightRequestBody>;

export function buildFlightRequestBody(flightIata: string, date: string, apiKey: string) {
  return {
    url: `https://airlabs.co/api/v9/flight`,
    httpMethod,
    headers,
    queryParams: JSON.stringify({ api_key: apiKey, flight_iata: flightIata }),
    body,
    postProcessJq: buildPostProcessJq(date),
    abiSignature,
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

const IATA_FLIGHT_NUMBER_RE = /^[A-Z0-9]{2,3}[0-9]{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateFlightInput(flightIata: string, date: string) {
  const normalizedIata = flightIata.trim().toUpperCase();
  if (!IATA_FLIGHT_NUMBER_RE.test(normalizedIata)) {
    throw new Error("Invalid flight number. Expected IATA format, e.g. BA75.");
  }
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
