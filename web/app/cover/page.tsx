"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import { flightGuardConfig, usdt0Config, MAX_COVER, PREMIUM_BPS, USDT0_DECIMALS } from "@/lib/contracts";
import { formatAmount, formatDate, formatUtcTime } from "@/lib/format";
import { ExplorerLink } from "@/components/ExplorerLink";

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

export default function CoverPage() {
  const { address, isConnected } = useAccount();

  const [flightIata, setFlightIata] = useState("");
  const [date, setDate] = useState("");
  const [coverAmountInput, setCoverAmountInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    ...usdt0Config,
    functionName: "allowance",
    args: address ? [address, flightGuardConfig.address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { writeContract: writeApprove, data: approveHash, isPending: isApprovePending } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  const {
    writeContract: writeBuyCover,
    data: buyCoverHash,
    isPending: isBuyCoverPending,
    error: buyCoverError,
  } = useWriteContract();
  const { isLoading: isBuyCoverConfirming, isSuccess: isBuyCoverConfirmed } = useWaitForTransactionReceipt({
    hash: buyCoverHash,
  });

  const needsApproval = useMemo(() => {
    if (!quote) return false;
    if (allowance === undefined) return true;
    return (allowance as bigint) < quote.premium;
  }, [allowance, quote]);

  async function handleQuote(e: FormEvent) {
    e.preventDefault();
    setQuoteError(null);
    setQuote(null);

    let coverAmount: bigint;
    try {
      coverAmount = parseUnits(coverAmountInput || "0", USDT0_DECIMALS);
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
        body: JSON.stringify({ flightIata, date }),
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

  function handleApprove() {
    if (!quote) return;
    writeApprove({
      ...usdt0Config,
      functionName: "approve",
      args: [flightGuardConfig.address, quote.premium],
    });
  }

  function handleBuyCover() {
    if (!quote) return;
    writeBuyCover({
      ...flightGuardConfig,
      functionName: "buyCover",
      args: [quote.coverAmount, quote.scheduledArrival, quote.requestHash, quote.flightRef],
    });
  }

  useEffect(() => {
    if (isApproveConfirmed) refetchAllowance();
  }, [isApproveConfirmed, refetchAllowance]);

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

          {quote && (
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
                <div className="text-xs text-white/50">Premium (10%)</div>
                <div className="font-mono text-4xl font-semibold text-brand">
                  {formatAmount(quote.premium)} <span className="text-lg text-white/50">USDT0</span>
                </div>
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
                      disabled={isApprovePending || isApproveConfirming}
                      className={darkButtonClass}
                    >
                      {isApprovePending || isApproveConfirming ? "Approving..." : "Approve USDT0"}
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
                  {isBuyCoverConfirmed && (
                    <p className="text-sm text-white/80">
                      Cover bought! View it on the{" "}
                      <a href="/policies" className="text-brand underline">
                        policies page
                      </a>
                      .
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
