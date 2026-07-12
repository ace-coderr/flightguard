import type { Metadata } from "next";
import Link from "next/link";
import { getDelayedFlights, type DelayedFlight } from "@/lib/server/radar";

export const metadata: Metadata = {
  title: "Delay radar — FlightGuard",
  description: "Flights delayed 2+ hours right now — every one of them would already be paid out under FlightGuard.",
};

// Matches the in-memory cache TTL in lib/server/radar.ts — ISR just saves re-invoking the
// server component (and therefore the cache-check) on every request in between.
export const revalidate = 600;

const ROW_GRID = "md:grid-cols-[1.2fr_1.4fr_0.8fr_0.8fr_1.2fr]";

// Current UTC date + 1 — the shown flight is already delayed (or landing imminently), so
// the CTA targets tomorrow's instance of the same flight number, which is still coverable.
function tomorrowUtcDate(): string {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString().slice(0, 10);
}

function RadarRow({ flight, tomorrow }: { flight: DelayedFlight; tomorrow: string }) {
  const route = flight.depIata && flight.arrIata ? `${flight.depIata} → ${flight.arrIata}` : "Route unknown";
  return (
    <div className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-ink/10 bg-white px-6 py-5 text-sm md:items-center ${ROW_GRID}`}>
      <span className="col-span-2 font-mono font-semibold md:col-span-1">
        {flight.airlineIata ? `${flight.airlineIata} ` : ""}
        {flight.flightIata}
      </span>
      <span className="font-mono text-muted">{route}</span>
      <span className="font-mono text-lg font-semibold text-brand">+{flight.delayMinutes}m</span>
      <span className="flex md:justify-start">
        <span className="rounded-full bg-brand px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-white">
          Would pay out
        </span>
      </span>
      <span className="col-span-2 flex md:col-span-1 md:justify-end">
        <Link
          href={`/cover?flight=${encodeURIComponent(flight.flightIata)}&date=${tomorrow}`}
          className="rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink hover:bg-ink hover:text-white"
        >
          Cover this route →
        </Link>
      </span>
    </div>
  );
}

export default async function RadarPage() {
  let flights: DelayedFlight[] = [];
  let error: string | null = null;
  try {
    ({ flights } = await getDelayedFlights());
  } catch (err) {
    error = (err as Error).message;
  }
  const tomorrow = tomorrowUtcDate();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
          Live
        </span>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-balance font-display text-5xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
            Delay radar
          </h1>
          <Link
            href="/cover"
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink/80"
          >
            Cover a future flight
          </Link>
        </div>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Every flight below is delayed 2+ hours right now, straight from live flight data. Under FlightGuard&apos;s
          rules, each one would already be paid out — no claim, no adjuster.
        </p>
        <p className="mt-2 max-w-xl text-sm text-muted">
          You cover a flight <em>before</em> it&apos;s delayed — tap &quot;Cover this route&quot; to quote tomorrow&apos;s
          departure of the same flight number.
        </p>
      </div>

      {error && <p className="text-sm text-brand">Failed to load live delays: {error}</p>}

      {!error && flights.length === 0 && (
        <p className="text-sm text-muted">No flights are delayed 2+ hours right now. Check back shortly.</p>
      )}

      {!error && flights.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className={`hidden gap-4 px-6 font-mono text-xs uppercase tracking-widest text-muted md:grid ${ROW_GRID}`}>
            <span>Flight</span>
            <span>Route</span>
            <span>Delay</span>
            <span>Status</span>
            <span className="text-right">Cover it</span>
          </div>
          {flights.map((flight) => (
            <RadarRow key={flight.flightIata} flight={flight} tomorrow={tomorrow} />
          ))}
        </div>
      )}
    </div>
  );
}
