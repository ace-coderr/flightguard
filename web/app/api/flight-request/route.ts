import { NextRequest, NextResponse } from "next/server";
import {
  buildFlightRef,
  buildFlightRequestBody,
  computeRequestHash,
  fetchFlight,
  scheduledArrivalFromFlight,
  utcDateOnly,
  validateFlightInput,
} from "@/lib/server/flightRequest";

export async function POST(req: NextRequest) {
  const apiKey = process.env.FLIGHT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing FLIGHT_API_KEY" }, { status: 500 });
  }

  let payload: { flightIata?: unknown; date?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof payload.flightIata !== "string" || typeof payload.date !== "string") {
    return NextResponse.json({ error: "flightIata and date are required" }, { status: 400 });
  }

  let flightIata: string;
  try {
    ({ flightIata } = validateFlightInput(payload.flightIata, payload.date));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // Built server-side only: apiKey never leaves this handler, so it never reaches the
  // client bundle or the browser network tab.
  const flight = await fetchFlight(flightIata, apiKey);
  if (!flight) {
    return NextResponse.json(
      { error: `Flight ${flightIata} not found. Check the flight number and try again.` },
      { status: 404 }
    );
  }

  const scheduledArrival = scheduledArrivalFromFlight(flight);
  if (scheduledArrival === null) {
    return NextResponse.json(
      { error: `${flightIata} has no scheduled arrival time yet. Try again closer to departure.` },
      { status: 422 }
    );
  }
  if (scheduledArrival <= Math.floor(Date.now() / 1000)) {
    return NextResponse.json({ error: `${flightIata}'s scheduled arrival has already passed.` }, { status: 400 });
  }

  // The date-lock and flightRef key off the flight's REAL departure date (from airlabs),
  // not whatever the buyer typed - this is what the keeper's proof at settle time will
  // also be checked against, so it must be the ground truth, not user input.
  const date = utcDateOnly(flight.depTimeUtc);
  const requestBody = buildFlightRequestBody(flightIata, date, apiKey);
  const requestHash = computeRequestHash(requestBody);
  const flightRef = buildFlightRef(flightIata, date);

  return NextResponse.json({
    flightIata,
    date,
    depIata: flight.depIata,
    arrIata: flight.arrIata,
    depTimeUtc: flight.depTimeUtc,
    arrTimeUtc: flight.arrTimeUtc,
    status: flight.status,
    scheduledArrival,
    requestHash,
    flightRef,
  });
}
