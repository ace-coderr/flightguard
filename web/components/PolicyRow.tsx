"use client";

import { FormEvent, useEffect, useState } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { flightGuardConfig, POLICY_STATUS_LABEL, PolicyStatus } from "@/lib/contracts";
import { formatAmount, formatDate } from "@/lib/format";
import { getPolicyMeta } from "@/lib/policyMeta";

export type Policy = {
  id: number;
  holder: string;
  coverAmount: bigint;
  premium: bigint;
  scheduledArrival: number;
  requestHash: `0x${string}`;
  status: PolicyStatus;
};

type SettlePhase = "submitted" | "waiting_finalization" | "fetching_proof" | "ready" | "failed";

type JsonProof = {
  merkleProof: `0x${string}`[];
  data: {
    attestationType: `0x${string}`;
    sourceId: `0x${string}`;
    votingRound: string;
    lowestUsedTimestamp: string;
    requestBody: {
      url: string;
      httpMethod: string;
      headers: string;
      queryParams: string;
      body: string;
      postProcessJq: string;
      abiSignature: string;
    };
    responseBody: { abiEncodedData: `0x${string}` };
  };
};

// data.votingRound / lowestUsedTimestamp travel as strings over JSON (bigint doesn't
// serialize) — convert back before this goes into a writeContract call.
function toSettleArgs(proof: JsonProof) {
  return {
    merkleProof: proof.merkleProof,
    data: {
      attestationType: proof.data.attestationType,
      sourceId: proof.data.sourceId,
      votingRound: BigInt(proof.data.votingRound),
      lowestUsedTimestamp: BigInt(proof.data.lowestUsedTimestamp),
      requestBody: proof.data.requestBody,
      responseBody: proof.data.responseBody,
    },
  } as const;
}

const TRACE_STEPS = ["Request attested", "Round finalized", "Proof delivered", "settle() paid"];

const PHASE_STEP_INDEX: Record<SettlePhase, number> = {
  submitted: 0,
  waiting_finalization: 1,
  fetching_proof: 2,
  ready: 3,
  failed: -1,
};

function SettlementTrace({ completedCount }: { completedCount: number }) {
  return (
    <ol className="flex flex-col gap-2">
      {TRACE_STEPS.map((label, i) => {
        const done = i < completedCount;
        const active = i === completedCount;
        return (
          <li key={label} className="flex items-center gap-2 font-mono text-xs">
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                done
                  ? "bg-emerald-400/15 text-emerald-500"
                  : active
                    ? "animate-pulse bg-brand/15 text-brand"
                    : "bg-ink/5 text-muted"
              }`}
            >
              {done ? "✓" : active ? "…" : ""}
            </span>
            <span className={done || active ? "text-ink" : "text-muted"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const STATUS_STYLE: Record<PolicyStatus, string> = {
  [PolicyStatus.Active]: "bg-ink text-white",
  [PolicyStatus.PaidOut]: "bg-brand text-white",
  [PolicyStatus.Expired]: "bg-ink/10 text-muted",
  [PolicyStatus.NoPayout]: "bg-ink/10 text-muted",
};

export function StatusChip({ status }: { status: PolicyStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide ${STATUS_STYLE[status]}`}>
      {POLICY_STATUS_LABEL[status]}
    </span>
  );
}

const smallButtonClass =
  "rounded-full bg-ink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-ink/80 disabled:cursor-not-allowed disabled:opacity-50";

const smallBrandButtonClass =
  "rounded-full bg-brand px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50";

const inputClass =
  "rounded-lg border border-ink/15 bg-canvas px-3 py-1.5 text-xs text-ink placeholder-muted outline-none transition-colors focus:border-ink";

export function PolicyRow({ policy, rowGridClass, onSettled }: { policy: Policy; rowGridClass: string; onSettled: () => void }) {
  const meta = getPolicyMeta(policy.requestHash);

  const [jobId, setJobId] = useState<string | null>(null);
  const [roundId, setRoundId] = useState<number | null>(null);
  const [abiEncodedRequest, setAbiEncodedRequest] = useState<`0x${string}` | null>(null);
  const [phase, setPhase] = useState<SettlePhase | null>(null);
  const [maxPhaseIndex, setMaxPhaseIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<JsonProof | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualFlightIata, setManualFlightIata] = useState("");
  const [manualDate, setManualDate] = useState("");
  const [activeFlight, setActiveFlight] = useState<{ flightIata: string; date: string } | null>(null);

  const { writeContract: writeSettle, data: settleHash, isPending: isSettlePending, error: settleError } = useWriteContract();
  const { isLoading: isSettleConfirming, isSuccess: isSettleConfirmed } = useWaitForTransactionReceipt({ hash: settleHash });

  useEffect(() => {
    if (isSettleConfirmed) onSettled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettleConfirmed]);

  useEffect(() => {
    if (!jobId || roundId === null || !abiEncodedRequest) return;
    // Server holds no state — each poll must resend everything it needs to advance
    // (roundId, abiEncodedRequest) so a cold serverless instance can pick up right where
    // a warm one left off.
    const currentJobId = jobId;
    const currentRoundId = roundId;
    const currentAbiEncodedRequest = abiEncodedRequest;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const params = new URLSearchParams({
          jobId: currentJobId,
          roundId: String(currentRoundId),
          abiEncodedRequest: currentAbiEncodedRequest,
        });
        const res = await fetch(`/api/settle/status?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setPhase("failed");
          setError(data.error ?? "Failed to fetch settlement status");
          return;
        }
        setPhase(data.phase);
        setMaxPhaseIndex((m) => Math.max(m, PHASE_STEP_INDEX[data.phase as SettlePhase] ?? m));
        if (data.phase === "ready") {
          setProof(data.proof);
          return;
        }
        if (data.phase === "failed") {
          setError(data.error ?? "Settlement job failed");
          return;
        }
        timeoutId = setTimeout(poll, 5000);
      } catch {
        if (!cancelled) timeoutId = setTimeout(poll, 5000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [jobId, roundId, abiEncodedRequest]);

  async function startSettlement(flightIata: string, date: string) {
    setError(null);
    setProof(null);
    setMaxPhaseIndex(0);
    setPhase("submitted");
    setActiveFlight({ flightIata, date });
    setShowManualInput(false);
    // Clear any previous job's reconstruction key first so a stale poll can't fire mid-transition.
    setJobId(null);
    setRoundId(null);
    setAbiEncodedRequest(null);
    try {
      const res = await fetch("/api/settle/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flightIata, date }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start settlement");
      setRoundId(data.roundId);
      setAbiEncodedRequest(data.abiEncodedRequest);
      setJobId(data.jobId);
    } catch (err) {
      setPhase("failed");
      setError((err as Error).message);
    }
  }

  function handleSettleClick() {
    if (meta) {
      void startSettlement(meta.flightIata, meta.date);
    } else {
      setShowManualInput(true);
    }
  }

  function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    if (!manualFlightIata || !manualDate) return;
    void startSettlement(manualFlightIata.trim().toUpperCase(), manualDate);
  }

  function handleRetry() {
    if (!activeFlight) return;
    void startSettlement(activeFlight.flightIata, activeFlight.date);
  }

  function handleSubmitSettlement() {
    if (!proof) return;
    writeSettle({
      ...flightGuardConfig,
      functionName: "settle",
      args: [BigInt(policy.id), toSettleArgs(proof)],
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isSettleEligible = policy.status === PolicyStatus.Active && nowSec >= policy.scheduledArrival;
  // phase (not just jobId) so the trace panel doesn't flicker back to the "Settle now"
  // button during the brief window between clicking retry and the new job's response.
  const inProgress = jobId !== null || phase !== null;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-ink/10 bg-white px-6 py-5 text-sm">
      <div className={`grid grid-cols-2 gap-x-4 gap-y-2 md:items-center ${rowGridClass}`}>
        <span className="col-span-2 font-semibold md:col-span-1">
          {meta ? `${meta.flightIata} · ${meta.date}` : `Policy #${policy.id}`}
        </span>
        <span className="font-mono">{formatAmount(policy.coverAmount)} USDT0</span>
        <span className="font-mono">{formatAmount(policy.premium)} USDT0</span>
        <span className="font-mono text-muted">{formatDate(policy.scheduledArrival)}</span>
        <span className="font-mono text-muted">#{policy.id}</span>
        <span className="flex items-center gap-2 md:justify-end">
          <StatusChip status={policy.status} />
        </span>
      </div>

      {isSettleEligible && !inProgress && !showManualInput && (
        <div className="flex justify-end border-t border-ink/10 pt-4">
          <button onClick={handleSettleClick} className={smallButtonClass}>
            Settle now
          </button>
        </div>
      )}

      {isSettleEligible && !inProgress && showManualInput && (
        <form onSubmit={handleManualSubmit} className="flex flex-wrap items-end gap-3 border-t border-ink/10 pt-4">
          <p className="w-full text-xs text-muted">
            No saved flight info for this policy (different browser/device?). Enter it again — it must match what you bought cover for.
          </p>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Flight number
            <input
              required
              placeholder="BA75"
              value={manualFlightIata}
              onChange={(e) => setManualFlightIata(e.target.value)}
              className={`${inputClass} font-mono uppercase placeholder:normal-case`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Flight date
            <input
              required
              type="date"
              value={manualDate}
              onChange={(e) => setManualDate(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </label>
          <button type="submit" className={smallButtonClass}>
            Start settlement
          </button>
          <button type="button" onClick={() => setShowManualInput(false)} className="text-xs text-muted underline">
            Cancel
          </button>
        </form>
      )}

      {inProgress && (
        <div className="flex flex-col gap-4 border-t border-ink/10 pt-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="font-mono text-xs uppercase tracking-widest text-muted">Settlement trace</span>
            <div className="mt-3">
              <SettlementTrace completedCount={phase === "failed" ? maxPhaseIndex : PHASE_STEP_INDEX[phase ?? "submitted"]} />
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
            {phase === "failed" && (
              <>
                <p className="max-w-xs text-right text-xs text-brand">{error}</p>
                <button onClick={handleRetry} className={smallButtonClass}>
                  Retry
                </button>
              </>
            )}

            {phase === "ready" && !isSettleConfirmed && (
              <>
                <button
                  onClick={handleSubmitSettlement}
                  disabled={isSettlePending || isSettleConfirming}
                  className={smallBrandButtonClass}
                >
                  {isSettlePending || isSettleConfirming ? "Submitting..." : "Submit settlement"}
                </button>
                {settleError && <p className="max-w-xs text-right text-xs text-brand">{settleError.message}</p>}
              </>
            )}

            {isSettleConfirmed && <p className="text-xs text-muted">Settled — status updated above.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
