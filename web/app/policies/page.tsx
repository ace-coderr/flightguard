"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { flightGuardConfig, PolicyStatus } from "@/lib/contracts";
import { formatAmount } from "@/lib/format";
import { PolicyRow, type Policy } from "@/components/PolicyRow";

const ROW_GRID = "md:grid-cols-[1.4fr_1fr_1fr_1.4fr_0.6fr_auto]";

export default function PoliciesPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  const { data: policyCount } = useReadContract({
    ...flightGuardConfig,
    functionName: "policyCount",
  });

  const {
    data: policies,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["policies", address, policyCount?.toString()],
    queryFn: async () => {
      if (!publicClient || policyCount === undefined || !address) return [];
      const count = Number(policyCount);
      const results = await Promise.all(
        Array.from({ length: count }, (_, id) =>
          publicClient.readContract({
            ...flightGuardConfig,
            functionName: "policies",
            args: [BigInt(id)],
          }) as Promise<readonly [string, bigint, bigint, number, `0x${string}`, string, number]>
        )
      );
      return results
        .map(
          ([holder, coverAmount, premium, scheduledArrival, requestHash, flightRef, status], id): Policy => ({
            id,
            holder,
            coverAmount,
            premium,
            scheduledArrival: Number(scheduledArrival),
            requestHash,
            flightRef,
            status,
          })
        )
        .filter((p) => p.holder.toLowerCase() === address.toLowerCase())
        .reverse();
    },
    enabled: Boolean(publicClient) && policyCount !== undefined && Boolean(address),
    // Keeper-driven settlements happen without any browser interaction, so this page
    // must poll to notice status flips it didn't itself trigger.
    refetchInterval: 30_000,
  });

  const summary = useMemo(() => {
    if (!policies) return null;
    return policies.reduce(
      (acc, p) => ({
        totalCover: acc.totalCover + p.coverAmount,
        totalPremium: acc.totalPremium + p.premium,
        active: acc.active + (p.status === PolicyStatus.Active ? 1 : 0),
      }),
      { totalCover: 0n, totalPremium: 0n, active: 0 }
    );
  }, [policies]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Dashboard
        </span>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-balance font-display text-5xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
            My policies
          </h1>
          <a
            href="/cover"
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink/80"
          >
            Buy cover
          </a>
        </div>
        <p className="mt-3 text-sm text-muted">Every flight you&apos;ve bought cover for, and how it settled.</p>
      </div>

      {isConnected && summary && policies && policies.length > 0 && (
        <div className="mb-8 rounded-2xl bg-ink p-6 text-white sm:p-8">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-[1fr_auto]">
            <div>
              <div className="text-xs text-white/50">Total cover held</div>
              <div className="font-mono text-5xl font-semibold">
                {formatAmount(summary.totalCover)} <span className="text-lg text-white/50">USDT0</span>
              </div>
            </div>
            <div className="flex gap-8 sm:border-l sm:border-white/10 sm:pl-8">
              <div>
                <div className="text-xs text-white/50">Policies</div>
                <div className="font-mono text-lg font-medium">{policies.length}</div>
              </div>
              <div>
                <div className="text-xs text-white/50">Active</div>
                <div className="font-mono text-lg font-medium text-brand">{summary.active}</div>
              </div>
              <div>
                <div className="text-xs text-white/50">Premiums paid</div>
                <div className="font-mono text-lg font-medium">{formatAmount(summary.totalPremium)} USDT0</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isConnected && <p className="text-sm text-muted">Connect your wallet to see your policies.</p>}
      {isConnected && isLoading && <p className="text-sm text-muted">Loading policies...</p>}
      {error && <p className="text-sm text-brand">Failed to load policies.</p>}
      {isConnected && !isLoading && policies?.length === 0 && (
        <p className="text-sm text-muted">
          No policies yet.{" "}
          <a href="/cover" className="text-brand underline">
            Buy cover
          </a>{" "}
          for a flight to get started.
        </p>
      )}

      {policies && policies.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className={`hidden gap-4 px-6 font-mono text-xs uppercase tracking-widest text-muted md:grid ${ROW_GRID}`}>
            <span>Flight</span>
            <span>Cover</span>
            <span>Premium</span>
            <span>Scheduled arrival</span>
            <span>ID</span>
            <span className="text-right">Status</span>
          </div>
          {policies.map((policy) => (
            <PolicyRow key={policy.id} policy={policy} rowGridClass={ROW_GRID} onSettled={() => refetch()} />
          ))}
        </div>
      )}
    </div>
  );
}
