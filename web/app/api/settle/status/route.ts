import { NextRequest, NextResponse } from "next/server";
import { getSettleStatus } from "@/lib/server/settle";

// The proof struct carries uint64 fields (votingRound, lowestUsedTimestamp) as bigint —
// JSON.stringify can't serialize those directly, so stringify them for the wire; the
// client converts back to bigint before passing the proof to writeContract.
function toJsonSafe<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map(toJsonSafe) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)])) as unknown as T;
  }
  return value;
}

const HEX_RE = /^0x[0-9a-fA-F]+$/;

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  const roundIdRaw = req.nextUrl.searchParams.get("roundId");
  const abiEncodedRequest = req.nextUrl.searchParams.get("abiEncodedRequest");

  if (!roundIdRaw || !abiEncodedRequest) {
    return NextResponse.json({ error: "roundId and abiEncodedRequest are required" }, { status: 400 });
  }
  const roundId = Number(roundIdRaw);
  if (!Number.isInteger(roundId)) {
    return NextResponse.json({ error: "roundId must be an integer" }, { status: 400 });
  }
  if (!HEX_RE.test(abiEncodedRequest)) {
    return NextResponse.json({ error: "abiEncodedRequest must be 0x-prefixed hex" }, { status: 400 });
  }

  // Stateless: everything needed to advance is in the query string, so there's nothing
  // to look up and nothing that can go missing on a cold serverless instance.
  try {
    const result = await getSettleStatus(roundId, abiEncodedRequest as `0x${string}`);
    return NextResponse.json({ jobId, ...toJsonSafe(result) });
  } catch (err) {
    return NextResponse.json({ jobId, phase: "failed", roundId, error: (err as Error).message });
  }
}
