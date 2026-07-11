import { flightGuardAddress } from "@/lib/contracts";

/**
 * The Settled event carries only (policyId, result, delayMinutes, cancelled) — no roundId
 * or txHash (see FlightGuard.sol). Both are recoverable after the fact without any contract
 * change, but NOT via raw eth_getLogs: Coston2's public RPC caps eth_getLogs at a 30-block
 * range ("requested too many blocks... maximum is set to 30"), so scanning history that way
 * is infeasible. Coston2's Blockscout explorer has already indexed every log/tx though, and
 * — since FlightGuard is source-verified — decodes calldata for us, so this reads from its
 * public v2 API instead: one call for the address's logs (find the Settled log's tx hash),
 * one for that tx's decoded input (settle()'s proof.data.votingRound = roundId; expire()
 * has no proof at all, so roundId stays null for policies that merely expired).
 */
export type SettlementEvidence = {
  txHash: `0x${string}`;
  roundId: number | null;
};

const EXPLORER_API = "https://coston2-explorer.flare.network/api/v2";

type BlockscoutLogItem = {
  transaction_hash: string;
  decoded?: {
    method_call?: string;
    parameters?: { name: string; value: unknown }[];
  };
};

type BlockscoutLogsResponse = {
  items: BlockscoutLogItem[];
  next_page_params?: Record<string, string | number> | null;
};

type BlockscoutTxResponse = {
  decoded_input?: {
    method_call?: string;
    parameters?: { name: string; value: unknown }[];
  };
};

const MAX_LOG_PAGES = 10;

async function findSettledTxHash(policyId: number): Promise<`0x${string}` | null> {
  let url = `${EXPLORER_API}/addresses/${flightGuardAddress}/logs`;

  for (let page = 0; page < MAX_LOG_PAGES; page++) {
    const res = await fetch(url, { next: { revalidate: 120 } });
    if (!res.ok) return null;
    const data = (await res.json()) as BlockscoutLogsResponse;

    const match = data.items.find((item) => {
      if (!item.decoded?.method_call?.startsWith("Settled(")) return false;
      const policyParam = item.decoded.parameters?.find((p) => p.name === "policyId");
      return String(policyParam?.value) === String(policyId);
    });
    if (match) return match.transaction_hash as `0x${string}`;

    if (!data.next_page_params) return null;
    url = `${EXPLORER_API}/addresses/${flightGuardAddress}/logs?${new URLSearchParams(
      data.next_page_params as Record<string, string>
    )}`;
  }
  return null;
}

async function findVotingRound(txHash: `0x${string}`): Promise<number | null> {
  try {
    const res = await fetch(`${EXPLORER_API}/transactions/${txHash}`, { next: { revalidate: 120 } });
    if (!res.ok) return null;
    const tx = (await res.json()) as BlockscoutTxResponse;
    if (!tx.decoded_input?.method_call?.startsWith("settle(")) return null; // expire() has no proof

    const proofValue = tx.decoded_input.parameters?.find((p) => p.name === "proof")?.value as
      | unknown[]
      | undefined;
    // proof = (merkleProof, data); data = (attestationType, sourceId, votingRound, ...)
    const votingRound = (proofValue?.[1] as unknown[] | undefined)?.[2];
    return typeof votingRound === "string" || typeof votingRound === "number" ? Number(votingRound) : null;
  } catch {
    return null;
  }
}

export async function findSettlementEvidence(policyId: number): Promise<SettlementEvidence | null> {
  const txHash = await findSettledTxHash(policyId);
  if (!txHash) return null;
  const roundId = await findVotingRound(txHash);
  return { txHash, roundId };
}
