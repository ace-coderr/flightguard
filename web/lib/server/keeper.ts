import type { PublicClient, WalletClient } from "viem";
import { coston2 } from "@/lib/chain";
import { flightGuardConfig, PolicyStatus } from "@/lib/contracts";
import { getPublicClient, getSettlerWalletClient, type SettleProof } from "./fdc";
import { parseFlightRef, resolveFlightRequestBody } from "./flightRequest";
import { getSettleStatus, startSettleJob } from "./settle";

/**
 * Autonomous settlement keeper. Reused primitives: the FDC job steps in ./settle.ts
 * (originally designed for a browser to poll one step at a time) are driven here to
 * completion inside a single invocation instead — there is no cross-invocation job
 * store. Idempotency comes entirely from onchain state: a policy is only ever touched
 * while status == Active, so a stray double-settle (e.g. an overlapping run, or the
 * user's manual "Settle now" fallback beating the keeper to it) reverts harmlessly and
 * is logged as a skip, not treated as a failure.
 */

type RawPolicy = readonly [string, bigint, bigint, number, `0x${string}`, string, number, boolean];

type DuePolicy = {
    id: number;
    scheduledArrival: number;
    requestHash: `0x${string}`;
    flightRef: string;
};

function log(policyId: number, message: string) {
    console.log(`[keeper] policy ${policyId}: ${message}`);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDuePolicies(publicClient: PublicClient): Promise<DuePolicy[]> {
    const [policyCount, claimWindow] = (await Promise.all([
        publicClient.readContract({ ...flightGuardConfig, functionName: "policyCount" }),
        publicClient.readContract({ ...flightGuardConfig, functionName: "CLAIM_WINDOW" }),
    ])) as [bigint, bigint];

    const count = Number(policyCount);
    const nowSec = Math.floor(Date.now() / 1000);

    const rawPolicies = await Promise.all(
        Array.from(
            { length: count },
            (_, id) =>
                publicClient.readContract({
                    ...flightGuardConfig,
                    functionName: "policies",
                    args: [BigInt(id)],
                }) as Promise<RawPolicy>
        )
    );

    return rawPolicies
        .map(([, , , scheduledArrival, requestHash, flightRef, status], id): DuePolicy & { status: PolicyStatus } => ({
            id,
            scheduledArrival: Number(scheduledArrival),
            requestHash,
            flightRef,
            status,
        }))
        .filter(
            (p) =>
                p.status === PolicyStatus.Active &&
                nowSec >= p.scheduledArrival &&
                nowSec <= p.scheduledArrival + Number(claimWindow)
        );
}

type SettleOutcome =
    | { policyId: number; outcome: "processed"; txHash: `0x${string}` }
    | { policyId: number; outcome: "skipped"; reason: string }
    | { policyId: number; outcome: "error"; error: string };

async function settleOnePolicy(
    policy: DuePolicy,
    publicClient: PublicClient,
    walletClient: WalletClient,
    deadline: number
): Promise<SettleOutcome> {
    const policyId = policy.id;
    try {
        if (!walletClient.account) throw new Error("Settler wallet client has no account");

        let flightIata: string;
        let date: string;
        try {
            ({ flightIata, date } = parseFlightRef(policy.flightRef));
        } catch (err) {
            log(policyId, `malformed flightRef "${policy.flightRef}": ${(err as Error).message}`);
            return { policyId, outcome: "skipped", reason: "malformed flightRef" };
        }

        const apiKey = process.env.FLIGHT_API_KEY;
        if (!apiKey) throw new Error("Server is missing FLIGHT_API_KEY");

        // Checked here (cheap, local hash math) before startSettleJob so a policy whose
        // requestHash matches neither scheme is skipped without wasting a paid FDC
        // attestation submission on a request that could never settle it.
        const resolved = resolveFlightRequestBody(flightIata, date, policy.requestHash, apiKey);
        if (!resolved) {
            log(policyId, `requestHash mismatch for flightRef "${policy.flightRef}" — skipping`);
            return { policyId, outcome: "skipped", reason: "requestHash mismatch" };
        }
        if (resolved.scheme === "legacy") {
            log(policyId, "requestHash matches the legacy (pre-proxy) request scheme");
        }

        log(policyId, `submitting attestation for ${flightIata} on ${date}`);
        const { roundId, abiEncodedRequest } = await startSettleJob(flightIata, date, policy.requestHash);
        log(policyId, `attestation submitted, round ${roundId}`);

        let proof: SettleProof | undefined;
        while (!proof) {
            if (Date.now() >= deadline) {
                log(policyId, "timed out waiting for finalization/proof, will retry next run");
                return { policyId, outcome: "skipped", reason: "timed out waiting for finalization/proof" };
            }
            const status = await getSettleStatus(roundId, abiEncodedRequest);
            if (status.phase === "failed") throw new Error("settlement job failed");
            if (status.phase === "ready") {
                proof = status.proof;
                break;
            }
            log(policyId, `phase: ${status.phase}`);
            await sleep(5000);
        }

        log(policyId, "proof ready, submitting settle()");
        const txHash = await walletClient.writeContract({
            ...flightGuardConfig,
            functionName: "settle",
            args: [BigInt(policyId), proof],
            chain: coston2,
            account: walletClient.account,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        log(policyId, `settled in tx ${txHash}`);
        return { policyId, outcome: "processed", txHash };
    } catch (err) {
        // Most commonly: someone else (an overlapping run, or the manual fallback) already
        // settled this policy first, so settle() reverts "not active" — harmless.
        const message = (err as Error).message ?? String(err);
        log(policyId, `settle() failed: ${message}`);
        return { policyId, outcome: "error", error: message };
    }
}

export type KeeperTickResult = {
    processed: { policyId: number; txHash: `0x${string}` }[];
    skipped: { policyId: number; reason: string }[];
    errors: { policyId: number; error: string }[];
};

/** Processes every past-due Active policy to completion, bounded by `deadline`
 *  (epoch ms). Due policies are driven concurrently so their ~90-180s finalization
 *  waits overlap instead of serializing against the shared deadline. */
export async function runKeeperTick(deadline: number): Promise<KeeperTickResult> {
    const publicClient = getPublicClient();
    const walletClient = getSettlerWalletClient();

    const due = await getDuePolicies(publicClient);
    if (due.length === 0) {
        console.log("[keeper] no due policies");
        return { processed: [], skipped: [], errors: [] };
    }
    console.log(
        `[keeper] ${due.length} due polic${due.length === 1 ? "y" : "ies"}: ${due.map((p) => p.id).join(", ")}`
    );

    const results = await Promise.all(due.map((p) => settleOnePolicy(p, publicClient, walletClient, deadline)));

    const result: KeeperTickResult = { processed: [], skipped: [], errors: [] };
    for (const r of results) {
        if (r.outcome === "processed") result.processed.push({ policyId: r.policyId, txHash: r.txHash });
        else if (r.outcome === "skipped") result.skipped.push({ policyId: r.policyId, reason: r.reason });
        else result.errors.push({ policyId: r.policyId, error: r.error });
    }
    return result;
}
