"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { flightGuardConfig, usdt0Config, fxrpConfig, MAX_COVER, PREMIUM_BPS, USDT0_DECIMALS } from "@/lib/contracts";
import { formatAmount, formatDate, formatUtcTime } from "@/lib/format";
import { ExplorerLink } from "@/components/ExplorerLink";

type PayWith = "USDT0" | "FXRP";

type CoverableFlight = {
  flightIata: string;
  depIata: string | null;
  arrIata: string | null;
  date: string;
  scheduledArrival: number;
};

type Quote = {
  flightIata: string;
  date: string;
  depIata: string | null;
  arrIata: string | null;
  arrTimeUtc: string | null;
  status: string;
  scheduledArrival: number;
  requestHash: `0x${string}`;
  flightRef: string;
  coverAmount: bigint;
  premium: bigint;
};

const inputClass =
  "rounded-lg border border-ink/15 bg-canvas px-3 py-2 text-ink placeholder-muted outline-none transition-colors focus:border-ink";

const primaryButtonClass =
  "rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink/80 disabled:cursor-not-allowed disabled:opacity-50";

const darkButtonClass =
  "rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50";

const secondaryDarkButtonClass =
  "rounded-full border border-white/20 px-4 py-2.5 text-sm font-semibold text-white/80 transition-colors hover:border-white/40 hover:text-white";

const DEFAULT_DEEP_LINK_COVER_AMOUNT = "100";

function CoverForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address, isConnected } = useAccount();

  const [flightIata, setFlightIata] = useState("");
  const [date, setDate] = useState("");
  const [coverAmountInput, setCoverAmountInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const isDeepLink = Boolean(searchParams.get("flight"));
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [payWith, setPayWith] = useState<PayWith>("USDT0");
  const [coverableFlights, setCoverableFlights] = useState<CoverableFlight[]>([]);
  const [coverableLoading, setCoverableLoading] = useState(true);

  const { data: usdt0Allowance, refetch: refetchUsdt0Allowance } = useReadContract({
    ...usdt0Config,
    functionName: "allowance",
    args: address ? [address, flightGuardConfig.address] : undefined,
    query: { enabled: Boolean(address) && payWith === "USDT0" },
  });

  const { data: fxrpAllowance, refetch: refetchFxrpAllowance } = useReadContract({
    ...fxrpConfig,
    functionName: "allowance",
    args: address ? [address, flightGuardConfig.address] : undefined,
    query: { enabled: Boolean(address) && payWith === "FXRP" },
  });

  // Live FTSO quote for the FXRP path: previewFxrpPremium isn't `view` (it calls FtsoV2's
  // payable getFeedByIdInWei), but a read-only eth_call works regardless - same as any
  // other contract read.
  const { data: fxrpPreview } = useReadContract({
    ...flightGuardConfig,
    functionName: "previewFxrpPremium",
    args: quote ? [quote.coverAmount] : undefined,
    query: { enabled: Boolean(quote) && payWith === "FXRP", refetchInterval: 15_000 },
  });
  const [, fxrpAmount, xrpUsdPriceWei, usdtUsdPriceWei] = (fxrpPreview as
    | readonly [bigint, bigint, bigint, bigint]
    | undefined) ?? [undefined, undefined, undefined, undefined];

  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: isApprovePending,
    reset: resetApprove,
  } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  const {
    writeContract: writeBuyCover,
    data: buyCoverHash,
    isPending: isBuyCoverPending,
    error: buyCoverError,
    reset: resetBuyCover,
  } = useWriteContract();
  const { isLoading: isBuyCoverConfirming, isSuccess: isBuyCoverConfirmed } = useWaitForTransactionReceipt({
    hash: buyCoverHash,
  });

  const needsApproval = useMemo(() => {
    if (!quote) return false;
    if (payWith === "FXRP") {
      if (fxrpAmount === undefined) return true;
      if (fxrpAllowance === undefined) return true;
      return (fxrpAllowance as bigint) < fxrpAmount;
    }
    if (usdt0Allowance === undefined) return true;
    return (usdt0Allowance as bigint) < quote.premium;
  }, [usdt0Allowance, fxrpAllowance, fxrpAmount, payWith, quote]);

  async function runQuote(flightIataValue: string, dateValue: string, coverAmountValue: string) {
    setQuoteError(null);
    setQuote(null);

    let coverAmount: bigint;
    try {
      coverAmount = parseUnits(coverAmountValue || "0", USDT0_DECIMALS);
    } catch {
      setQuoteError("Enter a valid cover amount.");
      return;
    }
    if (coverAmount <= 0n || coverAmount > MAX_COVER) {
      setQuoteError(`Cover amount must be between 0 and ${formatAmount(MAX_COVER)} USDT0.`);
      return;
    }

    setIsQuoting(true);
    try {
      const res = await fetch("/api/flight-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flightIata: flightIataValue, date: dateValue }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to build flight request");
      }
      const premium = (coverAmount * PREMIUM_BPS) / 10_000n;
      setQuote({
        flightIata: data.flightIata,
        date: data.date,
        depIata: data.depIata,
        arrIata: data.arrIata,
        arrTimeUtc: data.arrTimeUtc,
        status: data.status,
        scheduledArrival: data.scheduledArrival,
        requestHash: data.requestHash,
        flightRef: data.flightRef,
        coverAmount,
        premium,
      });
    } catch (err) {
      setQuoteError((err as Error).message);
    } finally {
      setIsQuoting(false);
    }
  }

  function handleQuote(e: FormEvent) {
    e.preventDefault();
    void runQuote(flightIata, date, coverAmountInput);
  }

  async function handleCoverableClick(flight: CoverableFlight) {
    setFlightIata(flight.flightIata);
    setDate(flight.date);
    const coverAmount = coverAmountInput || DEFAULT_DEEP_LINK_COVER_AMOUNT;
    setCoverAmountInput(coverAmount);
    await runQuote(flight.flightIata, flight.date, coverAmount);
  }

  // Suggested "known good" flight numbers so a judge with no idea which real-world flights
  // are currently airborne always has a one-click working path to a quote.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/coverable-flights");
        const data = await res.json();
        if (!cancelled && res.ok) setCoverableFlights(data.flights ?? []);
      } catch {
        // ignore - falls back to the "try again shortly" hint
      } finally {
        if (!cancelled) setCoverableLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep link from /radar ("Cover this route"): prefill the flight number only. We can't
  // assume "tomorrow" is coverable - airlabs' free tier only ever exposes a flight's
  // current/most-recent instance, not a future date's occurrence, so a flight radar just
  // flagged as delayed (i.e. today's instance) always resolves to an already-passed
  // arrival. Instead of auto-firing a quote that's guaranteed to fail, just prefill and let
  // the user pick a date and validate for themselves via the normal "Get quote" flow.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const flightParam = searchParams.get("flight");
    if (!flightParam) return;

    setFlightIata(flightParam.trim().toUpperCase());
    setCoverAmountInput(DEFAULT_DEEP_LINK_COVER_AMOUNT);
  }, []);

  function handleApprove() {
    if (!quote) return;
    if (payWith === "FXRP") {
      if (fxrpAmount === undefined) return;
      writeApprove({ ...fxrpConfig, functionName: "approve", args: [flightGuardConfig.address, fxrpAmount] });
      return;
    }
    writeApprove({
      ...usdt0Config,
      functionName: "approve",
      args: [flightGuardConfig.address, quote.premium],
    });
  }

  function handleBuyCover() {
    if (!quote) return;
    if (payWith === "FXRP") {
      writeBuyCover({
        ...flightGuardConfig,
        functionName: "buyCoverWithFXRP",
        args: [quote.coverAmount, quote.scheduledArrival, quote.requestHash, quote.flightRef],
      });
      return;
    }
    writeBuyCover({
      ...flightGuardConfig,
      functionName: "buyCover",
      args: [quote.coverAmount, quote.scheduledArrival, quote.requestHash, quote.flightRef],
    });
  }

  useEffect(() => {
    if (!isApproveConfirmed) return;
    if (payWith === "FXRP") refetchFxrpAllowance();
    else refetchUsdt0Allowance();
  }, [isApproveConfirmed, payWith, refetchFxrpAllowance, refetchUsdt0Allowance]);

  // Gentle auto-redirect to My Policies once the buyCover tx is confirmed onchain -
  // the "View in My Policies" button is available immediately for anyone who doesn't
  // want to wait.
  useEffect(() => {
    if (!isBuyCoverConfirmed) return;
    const timer = setTimeout(() => router.push("/policies"), 3000);
    return () => clearTimeout(timer);
  }, [isBuyCoverConfirmed, router]);

  function handleBuyAnother() {
    setQuote(null);
    setQuoteError(null);
    setFlightIata("");
    setDate("");
    setCoverAmountInput("");
    resetApprove();
    resetBuyCover();
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Buy cover
        </span>
        <h1 className="mt-4 text-balance font-display text-5xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
          Flight-delay cover
        </h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Enter a flight, date, and cover amount to get an instant quote.
        </p>

        {coverableFlights.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-widest text-muted">
              Try a coverable flight
            </span>
            {coverableFlights.map((flight) => (
              <button
                key={flight.flightIata}
                type="button"
                onClick={() => void handleCoverableClick(flight)}
                className="rounded-full border border-ink/15 bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink transition-colors hover:border-ink hover:bg-ink hover:text-white"
              >
                {flight.flightIata}
                {flight.depIata && flight.arrIata ? ` · ${flight.depIata}→${flight.arrIata}` : ""}
              </button>
            ))}
          </div>
        )}
        {!coverableLoading && coverableFlights.length === 0 && (
          <p className="mt-6 text-xs text-muted">
            Flights refresh constantly — try again shortly, or enter any flight that hasn&apos;t landed yet.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <form
          onSubmit={handleQuote}
          className="flex flex-col gap-5 self-start rounded-2xl border border-ink/10 bg-white p-6 sm:p-8"
        >
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Flight number (IATA)
            <input
              required
              placeholder="BA75"
              value={flightIata}
              onChange={(e) => setFlightIata(e.target.value)}
              className={`${inputClass} font-mono uppercase placeholder:normal-case`}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Flight date
            <input
              required
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </label>
          {isDeepLink && !quote && !quoteError && (
            <p className="text-xs text-muted">
              Prefilled from Delay Radar. Pick the date you want to fly — we&apos;ll only let you buy once we can
              confirm that flight&apos;s scheduled arrival with live data.
            </p>
          )}
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Cover amount (USDT0)
            <input
              required
              type="number"
              min="0"
              step="0.01"
              placeholder="100"
              value={coverAmountInput}
              onChange={(e) => setCoverAmountInput(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </label>
          {quoteError && <p className="text-sm text-brand">{quoteError}</p>}
          <button type="submit" disabled={isQuoting} className={primaryButtonClass}>
            {isQuoting ? "Getting quote..." : "Get quote"}
          </button>

          <p className="mt-2 border-t border-ink/10 pt-5 text-xs text-muted">
            Cover is underwritten by the FlightGuard pool contract:{" "}
            <ExplorerLink address={flightGuardConfig.address} />
          </p>
        </form>

        <div className="lg:sticky lg:top-24 lg:self-start">
          {!quote && (
            <div className="flex flex-col gap-5 rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
              <h2 className="font-semibold">How the payout works</h2>
              <ul className="flex flex-col gap-4 text-sm text-muted">
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  Premium is a flat 10% of your cover amount, paid once when you buy.
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  Cover is capped at {formatAmount(MAX_COVER)} USDT0 per policy.
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  A 2+ hour delay or cancellation pays your full cover amount automatically.
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  Anyone can trigger settlement after scheduled arrival with a valid FDC proof.
                </li>
              </ul>
            </div>
          )}

          {quote && isBuyCoverConfirmed && (
            <div className="flex flex-col gap-5 rounded-2xl bg-ink p-6 text-white sm:p-8">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Cover active!</h2>
                <span className="font-mono text-xs text-white/50">
                  {quote.flightIata} · {quote.date}
                </span>
              </div>

              <p className="text-sm text-white/70">Your policy is live onchain.</p>

              <div className="rounded-lg bg-white/5 px-3 py-2 font-mono text-sm">
                {quote.flightIata}
                {quote.depIata && quote.arrIata ? ` · ${quote.depIata}→${quote.arrIata}` : ""}
                {quote.arrTimeUtc ? ` · arrives ${formatUtcTime(quote.arrTimeUtc)}` : ""}
              </div>

              <dl className="grid grid-cols-2 gap-y-2 border-t border-white/10 pt-4 text-sm">
                <dt className="text-white/50">Cover amount</dt>
                <dd className="text-right font-mono">{formatAmount(quote.coverAmount)} USDT0</dd>
                <dt className="text-white/50">Scheduled arrival by</dt>
                <dd className="text-right font-mono">{formatDate(quote.scheduledArrival)}</dd>
              </dl>

              <div className="flex flex-col gap-3 border-t border-white/10 pt-5">
                <Link href="/policies" className={`${darkButtonClass} text-center`}>
                  View in My Policies →
                </Link>
                <button type="button" onClick={handleBuyAnother} className={secondaryDarkButtonClass}>
                  Buy another
                </button>
                <p className="text-center text-xs text-white/40">Redirecting you to My Policies…</p>
              </div>
            </div>
          )}

          {quote && !isBuyCoverConfirmed && (
            <div className="flex flex-col gap-5 rounded-2xl bg-ink p-6 text-white sm:p-8">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Quote</h2>
                <span className="font-mono text-xs text-white/50">
                  {quote.flightIata} · {quote.date}
                </span>
              </div>

              <div className="rounded-lg bg-white/5 px-3 py-2 font-mono text-sm">
                {quote.flightIata}
                {quote.depIata && quote.arrIata ? ` · ${quote.depIata}→${quote.arrIata}` : ""}
                {quote.arrTimeUtc ? ` · arrives ${formatUtcTime(quote.arrTimeUtc)}` : ""}
                <div className="mt-1 text-xs uppercase tracking-wide text-white/50">
                  Confirm this is your flight before buying · status: {quote.status}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-white/50">Pay premium in</span>
                  <div className="flex gap-1 rounded-full bg-white/10 p-1 font-mono text-xs">
                    {(["USDT0", "FXRP"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setPayWith(option)}
                        className={`rounded-full px-3 py-1 transition-colors ${
                          payWith === option ? "bg-brand text-white" : "text-white/60 hover:text-white"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-white/50">Premium (10%)</div>
                {payWith === "USDT0" ? (
                  <div className="font-mono text-4xl font-semibold text-brand">
                    {formatAmount(quote.premium)} <span className="text-lg text-white/50">USDT0</span>
                  </div>
                ) : (
                  <>
                    <div className="font-mono text-4xl font-semibold text-brand">
                      {fxrpAmount !== undefined ? Number(formatUnits(fxrpAmount, 6)).toFixed(4) : "..."}{" "}
                      <span className="text-lg text-white/50">FXRP</span>
                    </div>
                    <div className="mt-1 font-mono text-xs text-white/50">
                      ≈ {formatAmount(quote.premium)} USDT0
                      {xrpUsdPriceWei !== undefined && usdtUsdPriceWei !== undefined && (
                        <>
                          {" "}
                          @ FTSO rate (XRP/USD ${Number(formatUnits(xrpUsdPriceWei, 18)).toFixed(4)}, USDT/USD $
                          {Number(formatUnits(usdtUsdPriceWei, 18)).toFixed(4)})
                        </>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-white/40">
                      FXRP has no FTSO feed of its own - priced via the underlying XRP/USD feed, since FXRP is 1:1
                      collateralized against real XRP.
                    </p>
                  </>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-y-2 border-t border-white/10 pt-4 text-sm">
                <dt className="text-white/50">Cover amount</dt>
                <dd className="text-right font-mono">{formatAmount(quote.coverAmount)} USDT0</dd>
                <dt className="text-white/50">Scheduled arrival by</dt>
                <dd className="text-right font-mono">{formatDate(quote.scheduledArrival)}</dd>
              </dl>

              {!isConnected && <p className="text-sm text-white/60">Connect your wallet to continue.</p>}

              {isConnected && (
                <div className="flex flex-col gap-3">
                  {needsApproval ? (
                    <button
                      onClick={handleApprove}
                      disabled={
                        isApprovePending || isApproveConfirming || (payWith === "FXRP" && fxrpAmount === undefined)
                      }
                      className={darkButtonClass}
                    >
                      {isApprovePending || isApproveConfirming ? "Approving..." : `Approve ${payWith}`}
                    </button>
                  ) : (
                    <button
                      onClick={handleBuyCover}
                      disabled={isBuyCoverPending || isBuyCoverConfirming}
                      className={darkButtonClass}
                    >
                      {isBuyCoverPending || isBuyCoverConfirming ? "Buying cover..." : "Buy cover"}
                    </button>
                  )}
                  {buyCoverError && <p className="text-sm text-brand">{buyCoverError.message}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CoverPage() {
  return (
    <Suspense fallback={null}>
      <CoverForm />
    </Suspense>
  );
}
