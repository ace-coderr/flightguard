import Link from "next/link";
import { ExplorerLink } from "@/components/ExplorerLink";
import { flightGuardAddress } from "@/lib/contracts";

const steps = [
  {
    n: "01",
    title: "Fund the pool",
    body: "Backers deposit USDT0 into the pool and earn a share of every premium paid.",
  },
  {
    n: "02",
    title: "Buy cover",
    body: "Travelers enter a flight, date, and cover amount, and pay a 10% premium.",
  },
  {
    n: "03",
    title: "Flare attests",
    body: "After scheduled arrival, the Flare Data Connector attests the flight's real status onchain.",
  },
  {
    n: "04",
    title: "The pool pays out",
    body: "Delayed 2+ hours or cancelled? settle() pays the cover amount automatically.",
  },
];

const trace = [
  "Request attested",
  "Round finalized",
  "Proof delivered",
  "settle() paid",
];

export default function Home() {
  return (
    <div className="flex flex-col">
      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="grid grid-cols-1 items-center gap-16 lg:min-h-[80vh] lg:grid-cols-2">
          <div className="flex flex-col items-start gap-6">
            <span className="inline-flex rounded-full border border-brand/30 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-brand">
              FDC · FTSO · COSTON2
            </span>
            <h1 className="text-balance font-display text-6xl uppercase leading-[0.9] tracking-tight sm:text-7xl lg:text-8xl">
              Insurance that pays itself out.
            </h1>
            <p className="max-w-md text-balance text-lg text-muted">
              Buy flight-delay cover in USDT0. When Flare&apos;s Data Connector attests a
              2+ hour delay or cancellation, the pool pays out automatically — no
              claims, no adjuster.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/cover"
                className="rounded-full bg-ink px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-ink/80"
              >
                Buy cover
              </Link>
              <Link
                href="/pool"
                className="rounded-full border border-ink/15 px-6 py-3 text-sm font-semibold text-ink transition-colors hover:border-ink/40"
              >
                Back the pool
              </Link>
            </div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              Live on Coston2 — Contract{" "}
              <ExplorerLink address={flightGuardAddress} />
            </p>
          </div>

          <div className="relative mx-auto h-[520px] w-full max-w-lg sm:h-[600px] lg:h-[660px]">
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 420 520"
              fill="none"
              aria-hidden
            >
              <path
                d="M30 480 C 100 360, 30 220, 190 150 S 350 70, 388 42"
                stroke="rgba(10,10,10,0.18)"
                strokeWidth="2"
                strokeDasharray="1 13"
                strokeLinecap="round"
              />
              <g transform="translate(225,115) rotate(-32)">
                <path d="M0 0 L22 6 L0 12 L5 6 Z" fill="rgba(10,10,10,0.3)" />
              </g>
              <circle cx="388" cy="42" r="15" fill="#E62058" fillOpacity="0.15" />
              <circle cx="388" cy="42" r="5" fill="#E62058" />
            </svg>

            <div className="absolute -top-3 right-4 z-30 inline-flex animate-fade-rise items-center gap-2 rounded-full bg-white px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted shadow-sm ring-1 ring-ink/5 [animation-delay:450ms] motion-reduce:animate-none sm:right-10">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
              FDC proof · Round 1391476
            </div>

            <div className="absolute left-1/2 top-1/2 w-full min-w-[420px] -translate-x-1/2 -translate-y-1/2">
              <div className="relative">
                <div className="absolute left-full top-full min-w-[340px] -translate-x-[9%] -translate-y-[12%] rotate-3">
                  <div className="animate-fade-rise rounded-2xl bg-ink p-8 text-white shadow-xl [animation-delay:200ms] motion-reduce:animate-none">
                    <div className="flex items-center justify-between font-mono text-xs uppercase tracking-widest text-white/40">
                      <span>Settled</span>
                      <span className="text-emerald-400">● Paid</span>
                    </div>
                    <div className="mt-6 font-mono text-4xl font-bold">AF128</div>
                    <div className="mt-2 font-mono text-2xl font-semibold text-brand">Delayed +148 min</div>
                    <div className="mt-6 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-white/70">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
                      Cover 50 → Paid out
                    </div>
                  </div>
                </div>

                <div className="-rotate-2">
                  <div className="animate-fade-rise rounded-2xl bg-ink p-8 text-white shadow-2xl motion-reduce:animate-none">
                    <div className="flex items-center justify-between font-mono text-xs uppercase tracking-widest text-white/50">
                      <span>Live · Sample</span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                        Coston2
                      </span>
                    </div>
                    <div className="mt-8 flex items-baseline justify-between font-mono">
                      <span className="text-4xl font-bold">BA75</span>
                      <span className="text-sm text-white/50">LHR → LOS</span>
                    </div>
                    <div className="mt-3 font-mono text-2xl font-semibold text-brand">LANDED +7 MIN</div>
                    <div className="mt-8 inline-flex rounded-full border border-white/15 px-4 py-2 font-mono text-xs uppercase tracking-wide text-white/70">
                      Cover 2 USDT0 · No payout
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Process
        </span>
        <h2 className="mt-4 max-w-2xl text-balance font-display text-4xl uppercase leading-[0.95] tracking-tight sm:text-5xl">
          How FlightGuard works
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <div key={step.n} className="flex flex-col gap-3 rounded-2xl border border-ink/10 bg-white p-6">
              <span className="font-mono text-2xl font-semibold text-brand">{step.n}</span>
              <h3 className="text-lg font-semibold">{step.title}</h3>
              <p className="text-sm text-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-ink text-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <span className="inline-flex rounded-full border border-white/15 px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-brand">
                The mechanic
              </span>
              <h2 className="mt-5 text-balance font-display text-5xl uppercase leading-[0.9] tracking-tight sm:text-6xl">
                This is not a claim form.
              </h2>
              <p className="mt-6 max-w-xl text-balance text-lg text-white/60">
                There is no adjuster reviewing your case and no form to fill in
                after you land. The Flare Data Connector fetches the
                flight-status API, attests the response through Flare&apos;s
                validator set, and delivers it onchain as a Merkle proof.
                FlightGuard&apos;s <span className="font-mono text-white">settle()</span>{" "}
                checks that proof against the policy and, if the flight was
                delayed 2+ hours or cancelled, pays the cover amount in the
                same transaction.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
              <span className="font-mono text-xs uppercase tracking-widest text-white/40">Settlement trace</span>
              <ol className="mt-5 flex flex-col gap-4">
                {trace.map((line) => (
                  <li key={line} className="flex items-center gap-3 font-mono text-sm">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-xs text-emerald-400">
                      ✓
                    </span>
                    <span className="text-white/80">{line}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="rounded-3xl border border-ink/10 bg-white p-10">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div>
              <h2 className="text-balance font-display text-3xl uppercase leading-[0.95] tracking-tight sm:text-4xl">
                Every transaction here is real.
              </h2>
              <p className="mt-3 max-w-lg text-sm text-muted">
                Not a demo dressed up as a product. FlightGuard is deployed and
                source-verified on Flare Coston2, and settlement runs on Flare&apos;s
                live Data Connector — real attestation requests, real voting
                rounds, real Merkle proofs.
              </p>
            </div>
            <ExplorerLink
              address={flightGuardAddress}
              label="0xd589...14E4B"
              className="inline-flex shrink-0 rounded-full bg-ink px-5 py-3 text-sm"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
