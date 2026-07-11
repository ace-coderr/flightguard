import { NextResponse } from "next/server";
import { getDelayedFlights } from "@/lib/server/radar";

export async function GET() {
  try {
    const { flights, fetchedAt } = await getDelayedFlights();
    return NextResponse.json({ flights, fetchedAt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
