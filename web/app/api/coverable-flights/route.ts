import { NextResponse } from "next/server";
import { getCoverableFlights } from "@/lib/server/coverableFlights";

export async function GET() {
    try {
        const { flights, fetchedAt } = await getCoverableFlights();
        return NextResponse.json({ flights, fetchedAt });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}
