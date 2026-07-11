import { NextRequest, NextResponse } from "next/server";
import { startSettleJob } from "@/lib/server/settle";

const HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export async function POST(req: NextRequest) {
    let payload: { flightIata?: unknown; date?: unknown; requestHash?: unknown };
    try {
        payload = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof payload.flightIata !== "string" || typeof payload.date !== "string") {
        return NextResponse.json({ error: "flightIata and date are required" }, { status: 400 });
    }
    if (typeof payload.requestHash !== "string" || !HEX_RE.test(payload.requestHash)) {
        return NextResponse.json({ error: "requestHash must be a 32-byte 0x-prefixed hex string" }, { status: 400 });
    }

    try {
        // Validates, builds the request (current proxy scheme, or legacy fallback if
        // requestHash was locked in before the flight-proxy existed), and submits the
        // attestation to FdcHub — all synchronous within this call. Nothing is left running
        // in the background: the response carries everything (roundId, abiEncodedRequest)
        // /api/settle/status needs to advance the job itself, one stateless step per call.
        const result = await startSettleJob(payload.flightIata, payload.date, payload.requestHash as `0x${string}`);
        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
}
