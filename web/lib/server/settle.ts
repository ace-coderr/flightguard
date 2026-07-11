import { buildFlightRequestBody, computeRequestHash, validateFlightInput } from "./flightRequest";
import {
  buildSettleProof,
  getPublicClient,
  getSettlerWalletClient,
  isRoundFinalized,
  prepareWeb2JsonRequest,
  submitAttestationRequest,
  tryFetchProof,
  type SettleProof,
} from "./fdc";

/**
 * Stateless settlement flow: nothing is persisted server-side. Serverless-safe by
 * construction — POST /start does the one-time on-chain submission and hands the client
 * everything (roundId, abiEncodedRequest) needed to reconstruct progress; every
 * GET /status call is a fresh, self-contained advance-by-one-step, so a cold instance
 * behind a new invocation works identically to a warm one. The client's poll cadence
 * (every 5s) is what used to be the background loop's retry timer.
 */

export type SettlePhase = "submitted" | "waiting_finalization" | "fetching_proof" | "ready" | "failed";

export type StartSettleResult = {
  jobId: string;
  flightIata: string;
  date: string;
  roundId: number;
  abiEncodedRequest: `0x${string}`;
};

// Cosmetic/debug label only — (roundId, abiEncodedRequest) are the real reconstruction
// key and travel with every status call, since abiEncodedRequest bakes in a
// messageIntegrityCode from the live API fetch at prepare time and can't be re-derived.
function deterministicJobId(flightIata: string, date: string, roundId: number): string {
  return `${flightIata}_${date}_${roundId}`;
}

export async function startSettleJob(flightIataInput: string, dateInput: string): Promise<StartSettleResult> {
  const { flightIata, date } = validateFlightInput(flightIataInput, dateInput);

  const apiKey = process.env.FLIGHT_API_KEY;
  if (!apiKey) throw new Error("Server is missing FLIGHT_API_KEY");

  // Same builder as /api/flight-request, so this produces byte-for-byte the same
  // requestBody (and therefore requestHash) as the one the policy was bought against.
  const requestBody = buildFlightRequestBody(flightIata, date, apiKey);
  computeRequestHash(requestBody); // sanity: throws if requestBody is malformed

  const abiEncodedRequest = await prepareWeb2JsonRequest(requestBody);

  const publicClient = getPublicClient();
  const walletClient = getSettlerWalletClient();
  const { roundId } = await submitAttestationRequest(publicClient, walletClient, abiEncodedRequest);

  return { jobId: deterministicJobId(flightIata, date, roundId), flightIata, date, roundId, abiEncodedRequest };
}

export type SettleStatusResult = {
  phase: SettlePhase;
  roundId: number;
  proof?: SettleProof;
};

/** Advances by exactly one step: check finalization, then (if finalized) try once for the
 * DA proof. No internal sleeps — callers re-invoke this every ~5s until phase is terminal. */
export async function getSettleStatus(roundId: number, abiEncodedRequest: `0x${string}`): Promise<SettleStatusResult> {
  const daLayerUrl = process.env.COSTON2_DA_LAYER_URL;
  if (!daLayerUrl) throw new Error("Server is missing COSTON2_DA_LAYER_URL");

  const publicClient = getPublicClient();

  const finalized = await isRoundFinalized(publicClient, roundId);
  if (!finalized) {
    return { phase: "waiting_finalization", roundId };
  }

  const daProof = await tryFetchProof(daLayerUrl, abiEncodedRequest, roundId);
  if (!daProof) {
    return { phase: "fetching_proof", roundId };
  }

  return { phase: "ready", roundId, proof: buildSettleProof(daProof) };
}
