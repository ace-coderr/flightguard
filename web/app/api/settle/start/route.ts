import { NextRequest, NextResponse } from "next/server";
import { startSettleJob } from "@/lib/server/settle";

export async function POST(req: NextRequest) {
  let payload: { flightIata?: unknown; date?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof payload.flightIata !== "string" || typeof payload.date !== "string") {
    return NextResponse.json({ error: "flightIata and date are required" }, { status: 400 });
  }

  try {
    // Validates, builds the request, and submits the attestation to FdcHub — all
    // synchronous within this call. Nothing is left running in the background: the
    // response carries everything (roundId, abiEncodedRequest) /api/settle/status needs
    // to advance the job itself, one stateless step per call.
    const result = await startSettleJob(payload.flightIata, payload.date);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
