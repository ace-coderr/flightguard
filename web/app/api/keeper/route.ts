import { NextRequest, NextResponse } from "next/server";
import { runKeeperTick } from "@/lib/server/keeper";

// Vercel Cron (see vercel.json) triggers this every 10 minutes and automatically
// attaches `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set on the
// project — this checks that same header.
const TICK_BUDGET_MS = 280_000;

export const maxDuration = 290;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Server is missing CRON_SECRET" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runKeeperTick(Date.now() + TICK_BUDGET_MS);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
