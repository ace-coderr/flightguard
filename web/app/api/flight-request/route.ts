import { NextRequest, NextResponse } from "next/server";
import {
    buildFlightRef,
    buildFlightRequestBody,
    computeRequestHash,
    fetchFlight,
    scheduledArrivalFromFlight,
    utcDateOnly,
    validateFlightIata,
} from "@/lib/server/flightRequest";

export async function POST(req: NextRequest) {
    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "Server is missing FLIGHT_API_KEY" }, { status: 500 });
    }

    let payload: { flightIata?: unknown };
    try {
        payload = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof payload.flightIata !== "string") {
        return NextResponse.json({ error: "flightIata is required" }, { status: 400 });
    }

    // No date input from the client anymore - the date-lock and flightRef are always
    // derived below from the flight's real scheduled departure (from airlabs), never from
    // user input.
    let flightIata: string;
    try {
        flightIata = validateFlightIata(payload.flightIata);
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }

    // Built server-side only: apiKey never leaves this handler, so it never reaches the
    // client bundle or the browser network tab.
    const flight = await fetchFlight(flightIata, apiKey);
    if (!flight) {
        return NextResponse.json(
            {
                error: `No upcoming flight found for ${flightIata}. Check the flight number and try again, or try one of the coverable flights above.`,
            },
            { status: 404 }
        );
    }

    const scheduledArrival = scheduledArrivalFromFlight(flight);
    if (scheduledArrival === null) {
        return NextResponse.json(
            {
                error: `No upcoming flight found for ${flightIata} — it has no scheduled arrival time yet. Try again closer to departure.`,
            },
            { status: 422 }
        );
    }
    if (scheduledArrival <= Math.floor(Date.now() / 1000)) {
        return NextResponse.json(
            {
                error: `No upcoming flight found for ${flightIata} — its next known instance has already arrived. Try one of the coverable flights above, or check back later.`,
            },
            { status: 400 }
        );
    }

    // The date-lock and flightRef key off the flight's REAL departure date (from airlabs),
    // not whatever the buyer typed - this is what the keeper's proof at settle time will
    // also be checked against, so it must be the ground truth, not user input.
    const date = utcDateOnly(flight.depTimeUtc);
    const requestBody = buildFlightRequestBody(flightIata, date);
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
