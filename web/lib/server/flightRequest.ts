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

function buildPostProcessJq() {
  return `{flightStatus: (.response.status // .error.message // "EMPTY"), delayMinutes: (.response.arr_delayed // 0)}`;
}

export type FlightRequestBody = ReturnType<typeof buildFlightRequestBody>;

export function buildFlightRequestBody(flightIata: string, apiKey: string) {
  return {
    url: `https://airlabs.co/api/v9/flight`,
    httpMethod,
    headers,
    queryParams: JSON.stringify({ api_key: apiKey, flight_iata: flightIata }),
    body,
    postProcessJq: buildPostProcessJq(),
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

/** End of the given UTC calendar day — the deadline buyCover locks in as scheduledArrival. */
export function scheduledArrivalForDate(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000);
}
