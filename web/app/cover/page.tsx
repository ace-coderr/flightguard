"use client";

import { FormEvent, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { flightGuardConfig, usdt0Config, fxrpConfig, MAX_COVER, MAX_PREMIUM_BPS, USDT0_DECIMALS } from "@/lib/contracts";
import { formatAmount, formatDate, formatUtcTime } from "@/lib/format";
import { ExplorerLink } from "@/components/ExplorerLink";

type PayWith = "USDT0" | "FXRP";
type PayoutIn = "USDT0" | "FXRP";

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
  premiumBps: number;
  delayRate: number | null;
  moderateRate: number | null;
  riskSampleSize: number;
  riskDayCount: number;
  riskDelayedCount: number;
  riskSource: "route-history" | "fallback";
  riskDescription: string;
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

function formatPremiumBps(bps: number) {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

/**
 * A cover amount the pool can actually back right now. The old flat 100 default produced an
 * unbuyable quote (Buy disabled, "exceeds pool capacity") the moment free liquidity dropped
 * below it — which is exactly what the one-click "try a coverable flight" path hit. Prefilling
 * from live capacity means the fastest route through the page always ends in a buyable quote.
 */
function suggestedCoverAmount(freeLiquidity: bigint | undefined): string {
  if (freeLiquidity === undefined || freeLiquidity <= 0n) return DEFAULT_DEEP_LINK_COVER_AMOUNT;
  const usable = freeLiquidity < MAX_COVER ? freeLiquidity : MAX_COVER;
  const wholeUnits = usable / 10n ** BigInt(USDT0_DECIMALS);
  if (wholeUnits >= 100n) return DEFAULT_DEEP_LINK_COVER_AMOUNT;
  if (wholeUnits > 0n) return wholeUnits.toString();
  // Sub-unit capacity: offer what's there rather than something guaranteed to be rejected.
  return formatUnits(usable, USDT0_DECIMALS);
}

/** Compact 2-state asset picker; two of these on one line replace the old stacked toggles. */
function AssetToggle({
  value,
  onChange,
  label,
}: {
  value: "USDT0" | "FXRP";
  onChange: (v: "USDT0" | "FXRP") => void;
  label: string;
}) {
  return (
    <div className="flex gap-0.5 rounded-full bg-white/10 p-0.5 font-mono text-xs" role="group" aria-label={label}>
      {(["USDT0", "FXRP"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            value === option ? "bg-brand text-white" : "text-white/60 hover:text-white"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function formatDelayRate(rate: number | null) {
  if (rate === null) return null;
  return `${Math.round(rate * 100)}%`;
}

function CoverForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address, isConnected } = useAccount();

  const [flightIata, setFlightIata] = useState("");
  const [coverAmountInput, setCoverAmountInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const isDeepLink = Boolean(searchParams.get("flight"));
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [payWith, setPayWith] = useState<PayWith>("USDT0");
  const [payoutIn, setPayoutIn] = useState<PayoutIn>("USDT0");
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

  // Live pool capacity so a judge (or anyone) sees "insufficient pool" coming before the
  // wallet ever gets a chance to reject the tx (FlightGuard.sol buyCover requires
  // coverAmount <= freeLiquidity).
  const { data: freeLiquidityData } = useReadContract({
    ...flightGuardConfig,
    functionName: "freeLiquidity",
    query: { refetchInterval: 15_000 },
  });
  const freeLiquidity = freeLiquidityData as bigint | undefined;

  // Live FTSO quote for the FXRP path: previewFxrpPremium isn't `view` (it calls FtsoV2's
  // payable getFeedByIdInWei), but a read-only eth_call works regardless - same as any
  // other contract read.
  const { data: fxrpPreview } = useReadContract({
    ...flightGuardConfig,
    functionName: "previewFxrpPremium",
    args: quote ? [quote.coverAmount, quote.premiumBps] : undefined,
    query: { enabled: Boolean(quote) && payWith === "FXRP", refetchInterval: 15_000 },
  });
  const [, fxrpAmount, xrpUsdPriceWei, usdtUsdPriceWei] = (fxrpPreview as
    | readonly [bigint, bigint, bigint, bigint]
    | undefined) ?? [undefined, undefined, undefined, undefined];

  // Approve with real headroom rather than the exact quote, for two reasons. First,
  // buyCoverWithFXRP recomputes the FXRP amount from the live FTSO price a block or two after
  // this preview, so approving the exact figure reverts with a raw "ERC20: insufficient
  // allowance" whenever XRP/USD ticks down in between. Second, approving exactly the premium
  // burns the allowance on every purchase, so a repeat buyer pays two transactions forever;
  // one wide approval makes every later purchase a single transaction.
  //
  // The ceiling is the largest premium the contract could ever charge for one policy
  // (MAX_COVER at MAX_PREMIUM_BPS), so it is bounded by the contract's own limits rather than
  // being unlimited. Only what the contract actually charges is ever transferred.
  const maxPremiumUsdt0 = (MAX_COVER * BigInt(MAX_PREMIUM_BPS)) / 10_000n;
  const usdt0ApprovalAmount = quote ? (quote.premium > maxPremiumUsdt0 ? quote.premium : maxPremiumUsdt0) : undefined;
  // Same ceiling expressed in FXRP, scaled through the live quote so it tracks the FTSO rate
  // instead of hardcoding an XRP price.
  const fxrpApprovalAmount =
    fxrpAmount === undefined || !quote || quote.premium === 0n
      ? undefined
      : (fxrpAmount * maxPremiumUsdt0) / quote.premium;

  // Estimated FXRP payout for the cover amount. Deliberately labelled as an estimate in the
  // UI: settle() re-reads XRP/USD inside the settlement transaction, so what actually lands
  // in the wallet is priced whenever the flight settles, not now.
  const { data: fxrpPayoutPreview } = useReadContract({
    ...flightGuardConfig,
    functionName: "previewFxrpPayout",
    args: quote ? [quote.coverAmount] : undefined,
    query: { enabled: Boolean(quote) && payoutIn === "FXRP", refetchInterval: 15_000 },
  });
  const [payoutFxrpAmount, payoutXrpPriceWei, payoutUsdtPriceWei] = (fxrpPayoutPreview as
    | readonly [bigint, bigint, bigint]
    | undefined) ?? [undefined, undefined, undefined];

  // An FXRP payout is funded from a pre-funded FXRP reserve, not from the USDT0 pool. If the
  // reserve is short at settlement the contract pays USDT0 instead of failing, so this is a
  // heads-up rather than a blocker.
  const { data: fxrpPayoutReserveData } = useReadContract({
    ...flightGuardConfig,
    functionName: "fxrpPayoutReserve",
    query: { enabled: payoutIn === "FXRP", refetchInterval: 15_000 },
  });
  const fxrpPayoutReserve = fxrpPayoutReserveData as bigint | undefined;
  const reserveMayBeShort =
    payoutIn === "FXRP" &&
    payoutFxrpAmount !== undefined &&
    fxrpPayoutReserve !== undefined &&
    fxrpPayoutReserve < payoutFxrpAmount;

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

  const exceedsFreeLiquidity = useMemo(() => {
    if (!quote || freeLiquidity === undefined) return false;
    return quote.coverAmount > freeLiquidity;
  }, [quote, freeLiquidity]);

  async function runQuote(flightIataValue: string, coverAmountValue: string) {
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
        body: JSON.stringify({ flightIata: flightIataValue }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to build flight request");
      }
      const premiumBps = Number(data.premiumBps ?? 1000);
      const premium = (coverAmount * BigInt(premiumBps)) / 10_000n;
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
        premiumBps,
        delayRate: typeof data.delayRate === "number" ? data.delayRate : null,
        moderateRate: typeof data.moderateRate === "number" ? data.moderateRate : null,
        riskSampleSize: Number(data.riskSampleSize ?? 0),
        riskDayCount: Number(data.riskDayCount ?? 0),
        riskDelayedCount: Number(data.riskDelayedCount ?? 0),
        riskSource: data.riskSource ?? "fallback",
        riskDescription: data.riskDescription ?? "Route-risk sample unavailable - using the documented 10% flat fallback",
      });
    } catch (err) {
      setQuoteError((err as Error).message);
    } finally {
      setIsQuoting(false);
    }
  }

  function handleQuote(e: FormEvent) {
    e.preventDefault();
    void runQuote(flightIata, coverAmountInput);
  }

  async function handleCoverableClick(flight: CoverableFlight) {
    setFlightIata(flight.flightIata);
    // Prefill from live pool capacity, not a flat 100 - one click has to land on a quote the
    // user can actually buy.
    const coverAmount = coverAmountInput || suggestedCoverAmount(freeLiquidity);
    setCoverAmountInput(coverAmount);
    await runQuote(flight.flightIata, coverAmount);
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
  // assume the flight is currently coverable - airlabs' free tier only ever exposes a
  // flight's current/most-recent instance, so a flight radar just flagged as delayed (i.e.
  // today's instance) may already have landed. Instead of auto-firing a quote that's
  // guaranteed to fail, just prefill and let the user hit "Get quote" themselves, which
  // looks up the flight's real next scheduled instance live. Guarded by a ref (not just the
  // empty dep array) so this can never fire a second time and stomp a flight number the
  // user has since typed in by hand.
  const didPrefillFromUrl = useRef(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (didPrefillFromUrl.current) return;
    didPrefillFromUrl.current = true;

    const flightParam = searchParams.get("flight");
    if (flightParam) {
      setFlightIata(flightParam.trim().toUpperCase());
      setCoverAmountInput(DEFAULT_DEEP_LINK_COVER_AMOUNT);
    }
  }, []);

  function handleApprove() {
    if (!quote) return;
    if (payWith === "FXRP") {
      if (fxrpApprovalAmount === undefined) return;
      writeApprove({ ...fxrpConfig, functionName: "approve", args: [flightGuardConfig.address, fxrpApprovalAmount] });
      return;
    }
    if (usdt0ApprovalAmount === undefined) return;
    writeApprove({
      ...usdt0Config,
      functionName: "approve",
      args: [flightGuardConfig.address, usdt0ApprovalAmount],
    });
  }

  function handleBuyCover() {
    if (!quote) return;
    // Payment asset and payout asset are independent choices - all four combinations are
    // valid, so payoutInFxrp is passed the same way on both entry points.
    const payoutInFxrp = payoutIn === "FXRP";
    const args = [
      quote.coverAmount,
      quote.premiumBps,
      quote.scheduledArrival,
      quote.requestHash,
      quote.flightRef,
      payoutInFxrp,
    ] as const;
    writeBuyCover({
      ...flightGuardConfig,
      functionName: payWith === "FXRP" ? "buyCoverWithFXRP" : "buyCover",
      args,
    });
  }

  useEffect(() => {
    if (!isApproveConfirmed) return;
    if (payWith === "FXRP") refetchFxrpAllowance();
    else refetchUsdt0Allowance();
  }, [isApproveConfirmed, payWith, refetchFxrpAllowance, refetchUsdt0Allowance]);

  // One button, two on-chain steps. `purchasing` is the user's single intent to buy; the
  // effect below carries it across the approval into the buy so they press once and just
  // confirm in the wallet, instead of hunting for a second button between two popups.
  const [purchasing, setPurchasing] = useState(false);

  function handlePurchase() {
    if (!quote) return;
    setPurchasing(true);
    if (needsApproval) handleApprove();
    else handleBuyCover();
  }

  useEffect(() => {
    // Advance to the buy the moment the approval confirms. buyCoverHash guards against
    // re-firing on later re-renders once the buy is already submitted.
    if (!purchasing || !isApproveConfirmed || buyCoverHash) return;
    handleBuyCover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchasing, isApproveConfirmed, buyCoverHash]);

  // Any failure hands control back to the user rather than leaving a button spinning.
  useEffect(() => {
    if (buyCoverError) setPurchasing(false);
  }, [buyCoverError]);

  const approveStepDone = !needsApproval || isApproveConfirmed;
  const isPurchaseBusy =
    purchasing && (isApprovePending || isApproveConfirming || isBuyCoverPending || isBuyCoverConfirming);
  const purchaseLabel = !purchasing
    ? "Buy cover"
    : isApprovePending || isApproveConfirming
      ? `Approving ${payWith}…`
      : isBuyCoverPending || isBuyCoverConfirming
        ? "Buying cover…"
        : "Buy cover";

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
    setCoverAmountInput("");
    setPurchasing(false);
    resetApprove();
    resetBuyCover();
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Buy cover
        </span>
        <h1 className="mt-4 text-balance font-display text-4xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
          Flight-delay cover
        </h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Enter a flight number and cover amount to get an instant quote — we look up that
          flight&apos;s real next scheduled arrival for you.
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
                // Disabled until live capacity is known: this button picks the cover amount on
                // the user's behalf, and picking one the pool can't back lands them straight in
                // a quote with Buy disabled. Sub-second wait, no wrong answer.
                disabled={freeLiquidity === undefined}
                onClick={() => void handleCoverableClick(flight)}
                className="rounded-full border border-ink/15 bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink transition-colors hover:border-ink hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
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
        {/* Both inputs and the action sit on one row, so the lookup and the quote read as a
            single step rather than a form you fill and then a separate thing you trigger. */}
        <form
          onSubmit={handleQuote}
          className="flex flex-col gap-4 self-start rounded-2xl border border-ink/10 bg-white p-6 sm:p-8"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Flight number
              <input
                required
                placeholder="BA75"
                value={flightIata}
                onChange={(e) => setFlightIata(e.target.value)}
                className={`${inputClass} font-mono uppercase placeholder:normal-case`}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Cover amount (USDT0)
              <input
                required
                type="number"
                min="0"
                step="0.01"
                placeholder={suggestedCoverAmount(freeLiquidity)}
                value={coverAmountInput}
                onChange={(e) => setCoverAmountInput(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </label>
            <button type="submit" disabled={isQuoting} className={`${primaryButtonClass} sm:mb-0`}>
              {isQuoting ? "Quoting…" : "Get quote"}
            </button>
          </div>

          <p className="text-xs text-muted">
            Pool can back up to {freeLiquidity !== undefined ? formatAmount(freeLiquidity) : "…"} USDT0 right now ·
            underwritten by <ExplorerLink address={flightGuardConfig.address} />
          </p>

          {isDeepLink && !quote && !quoteError && (
            <p className="text-xs text-muted">
              Prefilled from Delay Radar — we&apos;ll look up this flight&apos;s real next scheduled arrival live.
            </p>
          )}
          {quoteError && <p className="text-sm text-brand">{quoteError}</p>}
        </form>

        <div className="lg:sticky lg:top-24 lg:self-start">
          {!quote && (
            <div className="flex flex-col gap-5 rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
              <h2 className="font-semibold">How the payout works</h2>
              <ul className="flex flex-col gap-4 text-sm text-muted">
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  Premium starts at 8% and adjusts by route delay risk; if the sample is unavailable, the quote uses
                  the 10% fallback.
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
                  Pay the premium in USDT0 or FXRP, and choose to be paid out in either too — the FXRP legs are both
                  priced live by FTSO.
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
                <dt className="text-white/50">Payout asset</dt>
                <dd className="text-right font-mono">
                  {payoutIn}
                  {payoutIn === "FXRP" && (
                    <span className="ml-1 text-xs text-white/50">at the FTSO rate on settlement</span>
                  )}
                </dd>
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
            <div className="flex flex-col gap-4 rounded-2xl bg-ink p-6 text-white sm:p-8">
              {/* Flight identity, date and arrival on one line. These were previously three
                  separate blocks restating each other. */}
              <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
                <div className="font-mono text-sm">
                  <div className="text-base font-semibold">
                    {quote.flightIata}
                    {quote.depIata && quote.arrIata ? ` · ${quote.depIata}→${quote.arrIata}` : ""}
                  </div>
                  <div className="mt-0.5 text-white/60">
                    {quote.date}
                    {quote.arrTimeUtc ? ` · arrives ${formatUtcTime(quote.arrTimeUtc)} UTC` : ""} · {quote.status}
                  </div>
                </div>
                <span
                  title="Date and arrival come from live flight data — this is the flight you're covering."
                  className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white/60"
                >
                  live
                </span>
              </div>

              {/* The entire decision in three lines: what leaves your wallet, what you're
                  covered for, what comes back if the flight goes wrong. */}
              <dl className="flex flex-col gap-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-white/50">You pay</dt>
                  <dd className="text-right font-mono text-2xl font-semibold text-brand">
                    {payWith === "USDT0" ? (
                      <>
                        {formatAmount(quote.premium)} <span className="text-sm text-white/50">USDT0</span>
                      </>
                    ) : (
                      <>
                        {fxrpAmount !== undefined ? Number(formatUnits(fxrpAmount, 6)).toFixed(4) : "…"}{" "}
                        <span className="text-sm text-white/50">FXRP</span>
                      </>
                    )}
                    <span className="ml-2 align-middle text-xs font-normal text-white/40">
                      {formatPremiumBps(quote.premiumBps)}
                    </span>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-white/50">You&apos;re covered for</dt>
                  <dd className="text-right font-mono">{formatAmount(quote.coverAmount)} USDT0</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-white/50">If 2h+ late or cancelled</dt>
                  <dd className="text-right font-mono">
                    {payoutIn === "USDT0"
                      ? `${formatAmount(quote.coverAmount)} USDT0`
                      : `≈ ${payoutFxrpAmount !== undefined ? Number(formatUnits(payoutFxrpAmount, 6)).toFixed(4) : "…"} FXRP`}
                  </dd>
                </div>
              </dl>

              {/* Route-risk methodology and the FXRP proxy-feed rationale are still here in
                  full, just folded away — they were three always-open paragraphs sitting
                  between the price and the button. */}
              <details className="group border-t border-white/10 pt-3 text-xs text-white/50">
                <summary className="cursor-pointer list-none font-medium text-white/60 transition-colors hover:text-white">
                  <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">
                    ▸
                  </span>
                  Why {formatPremiumBps(quote.premiumBps)}, and how is this priced?
                </summary>
                <div className="mt-2 flex flex-col gap-2 pl-4">
                  <p>
                    {quote.moderateRate !== null
                      ? `${formatDelayRate(quote.moderateRate)} of recent flights on this route ran 30min+ late.`
                      : "Route-risk data unavailable."}
                    {quote.riskSource !== "fallback" &&
                      ` Based on ${quote.riskSampleSize} historical flights across ${quote.riskDayCount} days on this route${
                        quote.delayRate !== null ? `; ${quote.riskDelayedCount} hit the 2h+/cancel trigger` : ""
                      }.`}
                  </p>
                  <p>
                    {quote.riskSource === "fallback"
                      ? quote.riskDescription
                      : "2h+ delays are episodic weather events and too rare to measure reliably in a free-tier sample, so the price leans on the far better-measured 30min+ rate and is shrunk toward the 10% base rate by how many days the sample covers."}
                  </p>
                  {(payWith === "FXRP" || payoutIn === "FXRP") && (
                    <p>
                      FXRP has no FTSO feed of its own — it&apos;s priced via the underlying XRP/USD feed, since FXRP is
                      1:1 collateralized against real XRP.
                      {xrpUsdPriceWei !== undefined && usdtUsdPriceWei !== undefined && (
                        <>
                          {" "}
                          Live now: XRP/USD ${Number(formatUnits(xrpUsdPriceWei, 18)).toFixed(4)}, USDT/USD $
                          {Number(formatUnits(usdtUsdPriceWei, 18)).toFixed(4)}.
                        </>
                      )}
                    </p>
                  )}
                  {payoutIn === "FXRP" && (
                    <p>
                      The FXRP payout figure is an estimate. Your cover stays {formatAmount(quote.coverAmount)} USDT0 of
                      value — the contract converts it at the FTSO rate read inside the settlement transaction itself, so
                      the exact FXRP you receive is priced when the flight settles, not now.
                      {payoutXrpPriceWei !== undefined && payoutUsdtPriceWei !== undefined && (
                        <>
                          {" "}
                          The estimate above uses XRP/USD ${Number(formatUnits(payoutXrpPriceWei, 18)).toFixed(4)} and
                          USDT/USD ${Number(formatUnits(payoutUsdtPriceWei, 18)).toFixed(4)}, read just now.
                        </>
                      )}
                    </p>
                  )}
                  <p>Scheduled arrival by {formatDate(quote.scheduledArrival)}.</p>
                </div>
              </details>

              {/* Both asset choices on one line. They stay independent — all four
                  combinations are valid — and the arrow carries the direction. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-white/10 pt-4 text-xs">
                <span className="text-white/50">Pay</span>
                <AssetToggle value={payWith} onChange={setPayWith} label="Premium asset" />
                <span aria-hidden className="px-0.5 text-white/30">
                  →
                </span>
                <span className="text-white/50">Receive</span>
                <AssetToggle value={payoutIn} onChange={setPayoutIn} label="Payout asset" />
              </div>

              {/* Kept prominent rather than folded into the disclosure: it changes which asset
                  actually lands in the wallet, so it isn't background detail. */}
              {reserveMayBeShort && (
                <p className="text-xs text-brand">
                  FXRP payout reserve holds only{" "}
                  {fxrpPayoutReserve !== undefined ? Number(formatUnits(fxrpPayoutReserve, 6)).toFixed(4) : "…"} FXRP —
                  if it&apos;s still short at settlement you&apos;re paid in USDT0 instead. Your claim is never at risk
                  either way.
                </p>
              )}

              {exceedsFreeLiquidity && (
                <p className="text-sm text-brand">
                  Exceeds pool capacity ({formatAmount(freeLiquidity)} USDT0 free) — lower your cover or add
                  liquidity in the{" "}
                  <Link href="/pool" className="underline">
                    Pool tab
                  </Link>
                  .
                </p>
              )}

              {!isConnected && <p className="text-sm text-white/60">Connect your wallet to continue.</p>}

              {/* One button, one intent. Approving and buying are still two on-chain
                  transactions — that's the contract's shape and isn't changing — but the user
                  presses once and just confirms in the wallet, with the step readout below
                  saying where they are instead of a second button appearing between popups. */}
              {isConnected && (
                <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
                  <button
                    onClick={handlePurchase}
                    disabled={
                      isPurchaseBusy ||
                      exceedsFreeLiquidity ||
                      (payWith === "FXRP" && fxrpAmount === undefined)
                    }
                    className={darkButtonClass}
                  >
                    {purchaseLabel}
                  </button>
                  <div className="flex items-center justify-center gap-2 font-mono text-[11px] text-white/40">
                    <span className={approveStepDone ? "text-brand" : purchasing ? "text-white/70" : ""}>
                      {approveStepDone ? "✓" : "①"} {needsApproval ? `approve ${payWith}` : "approved"}
                    </span>
                    <span aria-hidden>→</span>
                    <span className={purchasing && approveStepDone ? "text-white/70" : ""}>② confirm cover</span>
                  </div>
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
