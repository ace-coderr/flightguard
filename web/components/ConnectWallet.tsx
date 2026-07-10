"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { coston2 } from "@/lib/chain";
import { ExplorerLink } from "./ExplorerLink";

export function ConnectWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    const wrongNetwork = chainId !== coston2.id;
    return (
      <div className="flex items-center gap-2">
        {wrongNetwork && (
          <span className="rounded-full bg-brand px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white">
            Wrong network
          </span>
        )}
        <span className="flex items-center gap-2 rounded-full bg-ink px-4 py-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
          <ExplorerLink address={address} className="text-sm" />
        </span>
        <button
          onClick={() => disconnect()}
          className="hidden rounded-full border border-ink/15 px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-ink/30 hover:text-ink sm:block"
        >
          Disconnect
        </button>
      </div>
    );
  }

  const injectedConnector = connectors.find((c) => c.id === "injected") ?? connectors[0];

  return (
    <button
      onClick={() => injectedConnector && connect({ connector: injectedConnector })}
      disabled={isPending || !injectedConnector}
      className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink/80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isPending ? "Connecting..." : "Connect wallet"}
    </button>
  );
}
