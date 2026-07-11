import { NextResponse } from "next/server";
import { getCurrentVotingRound, getPublicClient } from "@/lib/server/fdc";

// Public, unauthenticated — just a read of the current FDC voting round, no secrets.
// Powers the "Auto-settlement in progress · round N" label on /policies.
// Forced dynamic: this handler takes no request-derived input, so without this Next
// would statically optimize it into a single build-time snapshot instead of a live read.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const roundId = await getCurrentVotingRound(getPublicClient());
    return NextResponse.json({ roundId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
