"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { flightGuardConfig, usdt0Config, USDT0_DECIMALS } from "@/lib/contracts";
import { formatAmount, formatShares } from "@/lib/format";
import { ExplorerLink } from "@/components/ExplorerLink";

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-4">
      <div className="font-mono text-xs uppercase tracking-widest text-muted">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-brand">{value}</div>
    </div>
  );
}

const inputClass =
  "rounded-lg border border-ink/15 bg-canvas px-3 py-2 font-mono text-ink placeholder-muted outline-none transition-colors focus:border-ink";

const primaryButtonClass =
  "w-full rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink/80 disabled:cursor-not-allowed disabled:opacity-50";

export default function PoolPage() {
  const { address, isConnected } = useAccount();

  const { data: poolBalance, refetch: refetchPoolBalance } = useReadContract({
    ...flightGuardConfig,
    functionName: "poolBalance",
  });
  const { data: totalLocked, refetch: refetchTotalLocked } = useReadContract({
    ...flightGuardConfig,
    functionName: "totalLocked",
  });
  const { data: freeLiquidity, refetch: refetchFreeLiquidity } = useReadContract({
    ...flightGuardConfig,
    functionName: "freeLiquidity",
  });
  const { data: totalShares, refetch: refetchTotalShares } = useReadContract({
    ...flightGuardConfig,
    functionName: "totalShares",
  });
  const { data: userShares, refetch: refetchUserShares } = useReadContract({
    ...flightGuardConfig,
    functionName: "shares",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: usdt0Balance, refetch: refetchUsdt0Balance } = useReadContract({
    ...usdt0Config,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    ...usdt0Config,
    functionName: "allowance",
    args: address ? [address, flightGuardConfig.address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const refetchAll = () => {
    refetchPoolBalance();
    refetchTotalLocked();
    refetchFreeLiquidity();
    refetchTotalShares();
    refetchUserShares();
    refetchUsdt0Balance();
    refetchAllowance();
  };

  const userShareValue = useMemo(() => {
    if (!userShares || !totalShares || !poolBalance || totalShares === 0n) return 0n;
    return ((userShares as bigint) * (poolBalance as bigint)) / (totalShares as bigint);
  }, [userShares, totalShares, poolBalance]);

  const [depositInput, setDepositInput] = useState("");
  const depositAmount = useMemo(() => {
    try {
      return parseUnits(depositInput || "0", USDT0_DECIMALS);
    } catch {
      return 0n;
    }
  }, [depositInput]);
  const needsApproval = allowance === undefined || (allowance as bigint) < depositAmount;

  const { writeContract: writeApprove, data: approveHash, isPending: isApprovePending } = useWriteContract();
  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveHash,
    query: { enabled: Boolean(approveHash) },
  });

  const { writeContract: writeDeposit, data: depositHash, isPending: isDepositPending, error: depositError } =
    useWriteContract();
  const { isLoading: isDepositConfirming, isSuccess: isDepositConfirmed } = useWaitForTransactionReceipt({
    hash: depositHash,
    query: { enabled: Boolean(depositHash) },
  });
  const [lastDepositAmount, setLastDepositAmount] = useState<bigint | null>(null);
  const [depositSuccessMessage, setDepositSuccessMessage] = useState<string | null>(null);

  const [withdrawInput, setWithdrawInput] = useState("");
  const withdrawShareAmount = useMemo(() => {
    try {
      return parseUnits(withdrawInput || "0", USDT0_DECIMALS);
    } catch {
      return 0n;
    }
  }, [withdrawInput]);
  const { writeContract: writeWithdraw, data: withdrawHash, isPending: isWithdrawPending, error: withdrawError } =
    useWriteContract();
  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawHash,
    query: { enabled: Boolean(withdrawHash) },
  });
  const [lastWithdrawAmount, setLastWithdrawAmount] = useState<bigint | null>(null);
  const [withdrawSuccessMessage, setWithdrawSuccessMessage] = useState<string | null>(null);

  function handleApprove() {
    if (depositAmount <= 0n) return;
    writeApprove(
      { ...usdt0Config, functionName: "approve", args: [flightGuardConfig.address, depositAmount] },
      { onSuccess: () => setTimeout(refetchAll, 2000) }
    );
  }

  function handleDeposit() {
    if (depositAmount <= 0n) return;
    setDepositSuccessMessage(null);
    setLastDepositAmount(depositAmount);
    writeDeposit({ ...flightGuardConfig, functionName: "deposit", args: [depositAmount] });
  }

  function handleWithdraw() {
    if (withdrawShareAmount <= 0n) return;
    setWithdrawSuccessMessage(null);
    setLastWithdrawAmount(withdrawShareAmount);
    writeWithdraw({ ...flightGuardConfig, functionName: "withdraw", args: [withdrawShareAmount] });
  }

  // Success confirmations are driven off the tx receipt (isSuccess), not submission -
  // "confirmed" means it landed onchain, not just that the wallet accepted it.
  useEffect(() => {
    if (!isDepositConfirmed || lastDepositAmount === null) return;
    setDepositSuccessMessage(`Deposited ${formatAmount(lastDepositAmount)} USDT0`);
    setDepositInput("");
    refetchAll();
    const timer = setTimeout(() => setDepositSuccessMessage(null), 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDepositConfirmed]);

  useEffect(() => {
    if (!isWithdrawConfirmed || lastWithdrawAmount === null) return;
    setWithdrawSuccessMessage(`Withdrew ${formatAmount(lastWithdrawAmount)} USDT0`);
    setWithdrawInput("");
    refetchAll();
    const timer = setTimeout(() => setWithdrawSuccessMessage(null), 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWithdrawConfirmed]);

  const utilization = useMemo(() => {
    const balance = (poolBalance as bigint) ?? 0n;
    const locked = (totalLocked as bigint) ?? 0n;
    if (balance === 0n) return 0;
    return Number((locked * 10_000n) / balance) / 100;
  }, [poolBalance, totalLocked]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Pool
        </span>
        <h1 className="mt-4 text-balance font-display text-5xl uppercase leading-[0.95] tracking-tight sm:text-6xl">
          The pool
        </h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Deposit USDT0 to back policies and earn a share of every premium paid.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div className="rounded-2xl bg-ink p-6 text-white sm:p-8">
          <div className="text-xs text-white/50">Pool balance</div>
          <div className="font-mono text-5xl font-semibold">
            {formatAmount(poolBalance as bigint)} <span className="text-lg text-white/50">USDT0</span>
          </div>
          {isConnected && (
            <div className="mt-6 flex flex-wrap gap-x-8 gap-y-2 border-t border-white/10 pt-6 text-sm text-white/60">
              <span>
                Your position:{" "}
                <span className="font-mono text-white">{formatShares(userShares as bigint)} shares</span>{" "}
                (<span className="font-mono text-white">{formatAmount(userShareValue)} USDT0</span>)
              </span>
              <span>
                Wallet balance:{" "}
                <span className="font-mono text-white">{formatAmount(usdt0Balance as bigint)} USDT0</span>
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Locked in policies" value={`${formatAmount(totalLocked as bigint)} USDT0`} />
          <StatCard label="Free liquidity" value={`${formatAmount(freeLiquidity as bigint)} USDT0`} />
          <StatCard label="Total shares" value={formatShares(totalShares as bigint)} />
          <StatCard label="Utilization" value={`${utilization.toFixed(1)}%`} />
        </div>

        <p className="text-xs text-muted">
          Pool contract: <ExplorerLink address={flightGuardConfig.address} /> · USDT0 token:{" "}
          <ExplorerLink address={usdt0Config.address} />
        </p>
      </div>

      {!isConnected && (
        <p className="mt-6 rounded-2xl border border-ink/10 bg-white p-6 text-sm text-muted">
          Connect your wallet to deposit or withdraw.
        </p>
      )}

      {isConnected && (
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
            <h2 className="font-semibold">Deposit</h2>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount in USDT0"
              value={depositInput}
              onChange={(e) => setDepositInput(e.target.value)}
              className={inputClass}
            />
            {needsApproval ? (
              <button
                onClick={handleApprove}
                disabled={depositAmount <= 0n || isApprovePending || isApproveConfirming}
                className={primaryButtonClass}
              >
                {isApprovePending || isApproveConfirming ? "Approving..." : "Approve USDT0"}
              </button>
            ) : (
              <button
                onClick={handleDeposit}
                disabled={depositAmount <= 0n || isDepositPending || isDepositConfirming}
                className={primaryButtonClass}
              >
                {isDepositPending || isDepositConfirming ? "Depositing..." : "Deposit"}
              </button>
            )}
            {depositSuccessMessage && (
              <p className="text-sm font-medium text-brand">{depositSuccessMessage}</p>
            )}
            {depositError && <p className="text-sm text-brand">{depositError.message}</p>}
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-ink/10 bg-white p-6 sm:p-8">
            <h2 className="font-semibold">Withdraw</h2>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Shares to withdraw"
                value={withdrawInput}
                onChange={(e) => setWithdrawInput(e.target.value)}
                className={`flex-1 ${inputClass}`}
              />
              <button
                type="button"
                onClick={() => setWithdrawInput(formatUnits((userShares as bigint) ?? 0n, USDT0_DECIMALS))}
                className="rounded-lg border border-ink/15 px-3 py-2 text-sm text-muted transition-colors hover:border-ink/30 hover:text-ink"
              >
                Max
              </button>
            </div>
            <button
              onClick={handleWithdraw}
              disabled={withdrawShareAmount <= 0n || isWithdrawPending || isWithdrawConfirming}
              className={primaryButtonClass}
            >
              {isWithdrawPending || isWithdrawConfirming ? "Withdrawing..." : "Withdraw"}
            </button>
            {withdrawSuccessMessage && (
              <p className="text-sm font-medium text-brand">{withdrawSuccessMessage}</p>
            )}
            {withdrawError && <p className="text-sm text-brand">{withdrawError.message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
