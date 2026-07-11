import {
  createPublicClient,
  createWalletClient,
  http,
  decodeAbiParameters,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "@/lib/chain";
import type { FlightRequestBody } from "./flightRequest";

/**
 * Server-side mirror of scripts/utils/fdc.ts + scripts/fdc-attest-flight.ts, using viem
 * instead of hardhat/truffle so it can run inside a Next.js API route / background job.
 */

const FLARE_CONTRACT_REGISTRY_ADDRESS = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const registryAbi = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ name: "_name", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const fdcRequestFeeConfigurationsAbi = [
  {
    type: "function",
    name: "getRequestFee",
    stateMutability: "view",
    inputs: [{ name: "_data", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const fdcHubAbi = [
  {
    type: "function",
    name: "requestAttestation",
    stateMutability: "payable",
    inputs: [{ name: "_data", type: "bytes" }],
    outputs: [],
  },
] as const;

const flareSystemsManagerAbi = [
  {
    type: "function",
    name: "firstVotingRoundStartTs",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "votingEpochDurationSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;

const relayAbi = [
  {
    type: "function",
    name: "isFinalized",
    stateMutability: "view",
    inputs: [
      { name: "_protocolId", type: "uint256" },
      { name: "_votingRoundId", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const fdcVerificationAbi = [
  {
    type: "function",
    name: "fdcProtocolId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

// Same shape as IWeb2JsonVerification's verifyWeb2Json(Proof) -> Proof.data, i.e. the
// exact type settle()'s IWeb2Json.Proof.data expects. Used to decode the DA layer's
// raw response_hex, and the decoded object is passed straight through as viem writeContract args.
const web2JsonResponseAbiParameter = {
  type: "tuple",
  components: [
    { name: "attestationType", type: "bytes32" },
    { name: "sourceId", type: "bytes32" },
    { name: "votingRound", type: "uint64" },
    { name: "lowestUsedTimestamp", type: "uint64" },
    {
      name: "requestBody",
      type: "tuple",
      components: [
        { name: "url", type: "string" },
        { name: "httpMethod", type: "string" },
        { name: "headers", type: "string" },
        { name: "queryParams", type: "string" },
        { name: "body", type: "string" },
        { name: "postProcessJq", type: "string" },
        { name: "abiSignature", type: "string" },
      ],
    },
    {
      name: "responseBody",
      type: "tuple",
      components: [{ name: "abiEncodedData", type: "bytes" }],
    },
  ],
} as const;

export type Web2JsonResponse = ReturnType<typeof decodeWeb2JsonResponse>;

export type SettleProof = {
  merkleProof: readonly `0x${string}`[];
  data: Web2JsonResponse;
};

function toUtf8HexString(value: string): `0x${string}` {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return `0x${hex.padEnd(64, "0")}` as `0x${string}`;
}

export function getPublicClient(): PublicClient {
  return createPublicClient({ chain: coston2, transport: http() });
}

export function getSettlerWalletClient(): WalletClient {
  const key = process.env.SETTLER_PRIVATE_KEY;
  if (!key) {
    throw new Error("Server is missing SETTLER_PRIVATE_KEY");
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return createWalletClient({ account, chain: coston2, transport: http() });
}

// Registry addresses are static per network — cache them to cut down on RPC round trips
// across a job's several lookups (FdcHub, FdcRequestFeeConfigurations, FlareSystemsManager, Relay, FdcVerification).
const registryCache = new Map<string, Address>();

async function getContractAddressByName(publicClient: PublicClient, name: string): Promise<Address> {
  const cached = registryCache.get(name);
  if (cached) return cached;
  const address = await publicClient.readContract({
    address: FLARE_CONTRACT_REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: [name],
  });
  registryCache.set(name, address);
  return address;
}

/** POST prepareRequest to the Web2Json verifier server -> abiEncodedRequest. */
export async function prepareWeb2JsonRequest(requestBody: FlightRequestBody): Promise<`0x${string}`> {
  const verifierUrl = process.env.VERIFIER_URL_TESTNET;
  const apiKey = process.env.VERIFIER_API_KEY_TESTNET;
  if (!verifierUrl) throw new Error("Server is missing VERIFIER_URL_TESTNET");
  if (!apiKey) throw new Error("Server is missing VERIFIER_API_KEY_TESTNET");

  const request = {
    attestationType: toUtf8HexString("Web2Json"),
    sourceId: toUtf8HexString("PublicWeb2"),
    requestBody,
  };

  const response = await fetch(`${verifierUrl}/verifier/web2/Web2Json/prepareRequest`, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status !== 200) {
    throw new Error(`Verifier responded ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (data.status !== "VALID" || !data.abiEncodedRequest) {
    throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
  }
  return data.abiEncodedRequest as `0x${string}`;
}

async function getFdcRequestFee(publicClient: PublicClient, abiEncodedRequest: `0x${string}`) {
  const address = await getContractAddressByName(publicClient, "FdcRequestFeeConfigurations");
  return publicClient.readContract({
    address,
    abi: fdcRequestFeeConfigurationsAbi,
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });
}

/** The FDC voting round covering a given chain timestamp (defaults to now). Public,
 *  stateless chain math — same formula FlareSystemsManager/the FDC protocol use to
 *  bucket attestation requests into rounds. */
export async function getCurrentVotingRound(publicClient: PublicClient, atTimestamp?: bigint): Promise<number> {
  const flareSystemsManagerAddress = await getContractAddressByName(publicClient, "FlareSystemsManager");
  const [firstVotingRoundStartTs, votingEpochDurationSeconds] = await Promise.all([
    publicClient.readContract({
      address: flareSystemsManagerAddress,
      abi: flareSystemsManagerAbi,
      functionName: "firstVotingRoundStartTs",
    }),
    publicClient.readContract({
      address: flareSystemsManagerAddress,
      abi: flareSystemsManagerAbi,
      functionName: "votingEpochDurationSeconds",
    }),
  ]);

  const timestamp = atTimestamp ?? BigInt(Math.floor(Date.now() / 1000));
  return Number((timestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds);
}

/** Submit to FdcHub.requestAttestation{value: fee}(abiEncodedRequest) and derive the voting round it lands in. */
export async function submitAttestationRequest(
  publicClient: PublicClient,
  walletClient: WalletClient,
  abiEncodedRequest: `0x${string}`
): Promise<{ roundId: number; txHash: `0x${string}` }> {
  if (!walletClient.account) throw new Error("Settler wallet client has no account");

  const [fdcHubAddress, requestFee] = await Promise.all([
    getContractAddressByName(publicClient, "FdcHub"),
    getFdcRequestFee(publicClient, abiEncodedRequest),
  ]);

  const txHash = await walletClient.writeContract({
    address: fdcHubAddress,
    abi: fdcHubAbi,
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: requestFee,
    chain: coston2,
    account: walletClient.account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

  const roundId = await getCurrentVotingRound(publicClient, block.timestamp);
  return { roundId, txHash };
}

export async function isRoundFinalized(publicClient: PublicClient, roundId: number): Promise<boolean> {
  const [relayAddress, fdcVerificationAddress] = await Promise.all([
    getContractAddressByName(publicClient, "Relay"),
    getContractAddressByName(publicClient, "FdcVerification"),
  ]);
  const protocolId = await publicClient.readContract({
    address: fdcVerificationAddress,
    abi: fdcVerificationAbi,
    functionName: "fdcProtocolId",
  });
  return publicClient.readContract({
    address: relayAddress,
    abi: relayAbi,
    functionName: "isFinalized",
    args: [BigInt(protocolId), BigInt(roundId)],
  });
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

/**
 * Single, non-blocking attempt to fetch the raw proof from the DA layer. No internal
 * sleeps/retries — this is called once per /api/settle/status invocation, so the retry
 * loop lives in the client's poll cadence instead of a server-side timer, which is what
 * makes each call safe to run as a short-lived, stateless serverless invocation.
 * Returns undefined (not yet available) rather than throwing, so callers can distinguish
 * "still generating" from a genuine fetch error.
 */
export async function tryFetchProof(
  daLayerUrl: string,
  abiEncodedRequest: `0x${string}`,
  roundId: number
): Promise<{ response_hex: `0x${string}`; proof: readonly `0x${string}`[] } | undefined> {
  const url = `${daLayerUrl}/api/v1/fdc/proof-by-request-round-raw`;
  const request = { votingRoundId: roundId, requestBytes: abiEncodedRequest };
  const proof = await postJson(url, request);
  return proof?.response_hex !== undefined ? proof : undefined;
}

function decodeWeb2JsonResponse(responseHex: `0x${string}`) {
  const [decoded] = decodeAbiParameters([web2JsonResponseAbiParameter], responseHex);
  return decoded;
}

/** Decode the DA layer's raw proof into the exact struct FlightGuard.settle(policyId, proof) expects. */
export function buildSettleProof(daProof: {
  response_hex: `0x${string}`;
  proof: readonly `0x${string}`[];
}): SettleProof {
  return {
    merkleProof: daProof.proof,
    data: decodeWeb2JsonResponse(daProof.response_hex),
  };
}
