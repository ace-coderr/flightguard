import { NextRequest, NextResponse } from "next/server";
import {
  buildFlightRequestBody,
  computeRequestHash,
  scheduledArrivalForDate,
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
  let date: string;
  try {
    ({ flightIata, date } = validateFlightInput(payload.flightIata, payload.date));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const scheduledArrival = scheduledArrivalForDate(date);
  if (scheduledArrival <= Math.floor(Date.now() / 1000)) {
    return NextResponse.json({ error: "Flight date must be today or later" }, { status: 400 });
  }

  // Built server-side only: apiKey never leaves this handler, so it never reaches the
  // client bundle or the browser network tab. Only the resulting hash is returned.
  const requestBody = buildFlightRequestBody(flightIata, apiKey);
  const requestHash = computeRequestHash(requestBody);

  return NextResponse.json({ flightIata, date, scheduledArrival, requestHash });
}
