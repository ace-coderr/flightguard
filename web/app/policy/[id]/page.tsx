import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExplorerLink, explorerUrl } from "@/components/ExplorerLink";
import { StatusChip } from "@/components/PolicyRow";
import { flightGuardAddress, flightGuardConfig, POLICY_STATUS_LABEL, PolicyStatus } from "@/lib/contracts";
import { formatAmount, formatDate, parsePolicyFlightRef } from "@/lib/format";
import { getPublicClient } from "@/lib/server/fdc";
import { findSettlementEvidence, type SettlementEvidence } from "@/lib/server/receipts";

// A settled policy's evidence never changes, and even an Active one only needs to notice
// its own settlement within minutes, not seconds — ISR avoids re-running the chunked
// getLogs scan (see lib/server/receipts.ts) on every single receipt view.
export const revalidate = 120;

type RawPolicy = readonly [string, bigint, bigint, number, `0x${string}`, string, number];

const getPolicy = cache(async (id: number) => {
  const publicClient = getPublicClient();
  try {
    const raw = (await publicClient.readContract({
      ...flightGuardConfig,
      functionName: "policies",
      args: [BigInt(id)],
    })) as RawPolicy;
    const [holder, coverAmount, premium, scheduledArrival, requestHash, flightRef, status] = raw;
    if (holder === "0x0000000000000000000000000000000000000000") return null;
    return {
      id,
      holder,
      coverAmount,
      premium,
      scheduledArrival: Number(scheduledArrival),
      requestHash,
      flightRef,
      status: status as PolicyStatus,
    };
  } catch {
    return null;
  }
});

const getEvidence = cache(async (id: number, status: PolicyStatus): Promise<SettlementEvidence | null> => {
  if (status === PolicyStatus.Active) return null;
  return findSettlementEvidence(id);
});

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 0) return { title: "Policy not found — FlightGuard" };

  const policy = await getPolicy(id);
  if (!policy) return { title: "Policy not found — FlightGuard" };

  const meta = parsePolicyFlightRef(policy.flightRef);
  const title = `${meta ? meta.flightIata : `Policy #${id}`} — FlightGuard settlement receipt`;
  const description = `${formatAmount(policy.coverAmount)} USDT0 cover · ${POLICY_STATUS_LABEL[policy.status]} · verifiable onchain on Flare Coston2.`;

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

const TIMELINE_STEPS = ["Bought", "Flight", "Attested", "Settled"] as const;

function timelineStates(
  status: PolicyStatus,
  scheduledArrival: number
): ("done" | "active" | "pending" | "skipped")[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const flightHappened = nowSec >= scheduledArrival;

  if (status === PolicyStatus.Active) {
    return ["done", flightHappened ? "done" : "active", flightHappened ? "active" : "pending", "pending"];
  }
  if (status === PolicyStatus.Expired) {
    // expire() never requests or waits on an FDC proof, so nothing was ever attested.
    return ["done", "done", "skipped", "done"];
  }
  return ["done", "done", "done", "done"]; // PaidOut / NoPayout both settled via a real FDC proof
}

function Timeline({ status, scheduledArrival }: { status: PolicyStatus; scheduledArrival: number }) {
  const states = timelineStates(status, scheduledArrival);
  return (
    <ol className="flex flex-col gap-3">
      {TIMELINE_STEPS.map((label, i) => {
        const state = states[i];
        return (
          <li key={label} className="flex items-center gap-3 font-mono text-sm">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                state === "done"
                  ? "bg-emerald-400/15 text-emerald-500"
                  : state === "active"
                    ? "animate-pulse bg-brand/15 text-brand"
                    : state === "skipped"
                      ? "bg-ink/5 text-muted"
                      : "bg-ink/5 text-muted"
              }`}
            >
              {state === "done" ? "✓" : state === "active" ? "…" : state === "skipped" ? "–" : ""}
            </span>
            <span className={state === "done" || state === "active" ? "text-ink" : "text-muted"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-white/10 py-3 first:border-t-0 first:pt-0">
      <span className="font-mono text-xs uppercase tracking-widest text-white/40">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-sm text-brand underline-offset-4 hover:text-brand-hover hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="truncate font-mono text-sm text-white/80">{value}</span>
      )}
    </div>
  );
}

export default async function PolicyReceiptPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 0) notFound();

  const policy = await getPolicy(id);
  if (!policy) notFound();

  const evidence = await getEvidence(id, policy.status);
  const meta = parsePolicyFlightRef(policy.flightRef);
  const hasEvidence = policy.status !== PolicyStatus.Active && evidence !== null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Settlement receipt
        </span>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-balance font-display text-5xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
            {meta ? meta.flightIata : `Policy #${policy.id}`}
          </h1>
          <StatusChip status={policy.status} />
        </div>
        <p className="mt-3 font-mono text-sm text-muted">
          {meta ? `Scheduled ${meta.date}` : `Policy #${policy.id}`} · Held by{" "}
          <ExplorerLink address={policy.holder} />
        </p>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl bg-ink p-6 text-white sm:p-8">
          <div className="text-xs text-white/50">Cover</div>
          <div className="font-mono text-4xl font-semibold">
            {formatAmount(policy.coverAmount)} <span className="text-base text-white/50">USDT0</span>
          </div>
          <div className="mt-4 text-xs text-white/50">Premium</div>
          <div className="font-mono text-lg font-medium">{formatAmount(policy.premium)} USDT0</div>
          <div className="mt-4 text-xs text-white/50">Scheduled arrival</div>
          <div className="font-mono text-lg font-medium">{formatDate(policy.scheduledArrival)}</div>
        </div>

        <div className="rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">Timeline</span>
          <div className="mt-4">
            <Timeline status={policy.status} scheduledArrival={policy.scheduledArrival} />
          </div>
        </div>
      </div>

      {hasEvidence && evidence && (
        <div className="mb-8 rounded-2xl border border-white/10 bg-ink p-6 sm:p-8">
          <span className="font-mono text-xs uppercase tracking-widest text-white/40">Evidence</span>
          <div className="mt-3">
            <EvidenceRow
              label="FDC voting round"
              value={evidence.roundId !== null ? `Round ${evidence.roundId}` : "—"}
              href={evidence.roundId !== null ? explorerUrl(evidence.txHash, "tx") : undefined}
            />
            <EvidenceRow label="Settle tx" value={`${evidence.txHash.slice(0, 10)}...${evidence.txHash.slice(-8)}`} href={explorerUrl(evidence.txHash, "tx")} />
            <EvidenceRow
              label="Request hash"
              value={`${policy.requestHash.slice(0, 10)}...${policy.requestHash.slice(-8)}`}
              href={explorerUrl(flightGuardAddress, "address")}
            />
            <EvidenceRow
              label="Contract"
              value={`${flightGuardAddress.slice(0, 10)}...${flightGuardAddress.slice(-8)}`}
              href={explorerUrl(flightGuardAddress, "address")}
            />
          </div>
        </div>
      )}

      {policy.status === PolicyStatus.Active && (
        <p className="mb-8 text-sm text-muted">
          This policy is still active. Once its flight&apos;s scheduled arrival passes, Flare&apos;s Data Connector
          attests the real outcome and this receipt fills in with the settlement evidence.
        </p>
      )}

      <Link href="/policies" className="text-sm text-brand underline underline-offset-4">
        ← Back to policies
      </Link>
    </div>
  );
}
