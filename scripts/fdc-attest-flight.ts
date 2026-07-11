import { ethers } from "hardhat";
import {
    prepareAttestationRequestBase,
    submitAttestationRequest,
    retrieveDataAndProofBaseWithRetry,
} from "./utils/fdc";

/**
 * DAY 1-2 GOAL: get ONE successful Web2Json attestation of flight data on Coston2.
 * This is the highest-risk piece of the whole project. Kill it first.
 *
 * Flow (per dev.flare.network FDC Web2Json guide, same pattern as
 * scripts/fdcExample/Web2Json.ts and scripts/weatherInsurance/minTemp/resolvePolicy.ts):
 *  1. POST prepareRequest to the Web2Json verifier server -> abiEncodedRequest
 *  2. Submit to FdcHub.requestAttestation{value: fee}(abiEncodedRequest)
 *  3. Wait for voting round to finalize (~90-180s)
 *  4. Fetch proof from DA layer: POST /api/v1/fdc/proof-by-request-round-raw
 *
 * Env needed: COSTON2_RPC_URL, PRIVATE_KEY, VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET,
 * COSTON2_DA_LAYER_URL, NEXT_PUBLIC_APP_URL (FLIGHT_API_KEY is only needed by the deployed
 * flight-proxy this script attests, not by this script itself)
 */

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL, NEXT_PUBLIC_APP_URL } = process.env;

// yarn hardhat run scripts/fdc-attest-flight.ts --network coston2

// EDIT ME: flight to attest. IATA flight number + YYYY-MM-DD date (must be today on free plan).
const flightIata = "BA75";
const flightDate = "2026-07-11";

const httpMethod = "GET";
// Defaults to "Content-Type": "application/json"
const headers = `{"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}`;
const queryParams = "{}";
const body = "{}";

const abiSignature = `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"}],"name":"dto","type":"tuple"}`;

// Configuration constants
const attestationTypeBase = "Web2Json";
const sourceIdBase = "PublicWeb2";
const verifierUrlBase = VERIFIER_URL_TESTNET;

// airlabs.co /v9/flight returns the latest occurrence of the flight as a single
// object under .response, with status ("landed"/"cancelled"/...) and arr_delayed
// (arrival delay in minutes, null when on time -> `// 0` fallback).
// dep_time_utc (scheduled departure, UTC) anchors the date-lock instead of arr_time_utc:
// it's stable across delays/cancellations, whereas arr_time_utc can be missing entirely
// for a cancelled flight and, for overnight flights, falls on the *next* UTC date - which
// would never match a lock keyed on the departure date. If the attested response is about
// a different day's occurrence of this flight number, this degrades to a fixed "EMPTY"/0
// output (never a payout) instead of failing the attestation outright.
// MUST stay byte-for-byte identical to web/lib/server/flightRequest.ts's buildPostProcessJq.
//
// The date-check is duplicated into both fields rather than bound once via
// `EXPR as $match | ...`: the FDC Web2Json verifier's jq engine rejects `as $var` variable
// bindings outright (confirmed live against the testnet verifier - it returns "INVALID:
// INVALID JQ FILTER" for that syntax specifically, independent of the rest of the filter).
function buildPostProcessJq(date: string) {
    const matched = `(.response.dep_time_utc // "" | startswith("${date}"))`;
    return `{flightStatus: (if ${matched} then (.response.status // .error.message // "EMPTY") else "EMPTY" end), delayMinutes: (if ${matched} then (.response.arr_delayed // 0) else 0 end)}`;
}

function proxyBaseUrl(): string {
    if (!NEXT_PUBLIC_APP_URL) throw new Error("NEXT_PUBLIC_APP_URL not set in .env");
    return NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
}

// The exact request we attest. IMPORTANT: this same (url, postProcessJq, abiSignature)
// tuple is hashed into requestHash at buyCover time.
// Attests our own GET /api/flight-proxy (see web/app/api/flight-proxy/route.ts) instead
// of airlabs.co directly, so no api_key ever appears in FDC calldata - the proxy holds it
// server-side. MUST stay byte-for-byte identical to
// web/lib/server/flightRequest.ts's buildFlightRequestBody.
export function buildFlightRequestBody(flightIataCode: string, date: string) {
    return {
        url: `${proxyBaseUrl()}/api/flight-proxy`,
        httpMethod,
        headers,
        queryParams: JSON.stringify({ flight_iata: flightIataCode, date }),
        body,
        postProcessJq: buildPostProcessJq(date),
        abiSignature,
    };
}

// Pre-proxy request scheme (api_key in queryParams, hitting airlabs.co directly). Kept
// only so the keeper/settle flow can still attest+settle policies bought before the
// flight-proxy existed. MUST stay byte-for-byte identical to
// web/lib/server/flightRequest.ts's buildLegacyFlightRequestBody.
export function buildLegacyFlightRequestBody(flightIataCode: string, date: string, apiKey: string) {
    return {
        url: `https://airlabs.co/api/v9/flight`,
        httpMethod,
        headers,
        queryParams: JSON.stringify({ api_key: apiKey, flight_iata: flightIataCode }),
        body,
        postProcessJq: buildPostProcessJq(date),
        abiSignature,
    };
}

// requestHash used by FlightGuard.buyCover/settle:
// keccak256(abi.encode(url, headers, queryParams, postProcessJq, abiSignature))
// headers/queryParams are included because the flight identity (flight_iata) lives in
// queryParams for this API - without it, a proof for a different flight but the same
// url/jq/abiSignature would still match this policy's requestHash.
export function computeRequestHash(requestBody: {
    url: string;
    headers: string;
    queryParams: string;
    postProcessJq: string;
    abiSignature: string;
}) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "string", "string", "string"],
            [
                requestBody.url,
                requestBody.headers,
                requestBody.queryParams,
                requestBody.postProcessJq,
                requestBody.abiSignature,
            ]
        )
    );
}

async function prepareAttestationRequest(requestBody: ReturnType<typeof buildFlightRequestBody>) {
    const url = `${verifierUrlBase}/verifier/web2/Web2Json/prepareRequest`;
    const apiKey = VERIFIER_API_KEY_TESTNET;

    return await prepareAttestationRequestBase(url, apiKey, attestationTypeBase, sourceIdBase, requestBody);
}

async function retrieveDataAndProof(abiEncodedRequest: string, roundId: number) {
    const url = `${COSTON2_DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`;
    console.log("Url:", url, "\n");
    return await retrieveDataAndProofBaseWithRetry(url, abiEncodedRequest, roundId);
}

// Decodes the raw DA layer response into an IWeb2Json.Proof ready for FlightGuard.settle(),
// plus the decoded flightStatus/delayMinutes for a quick sanity check.
function decodeProof(proof: any) {
    console.log("Proof hex:", proof.response_hex, "\n");

    // A piece of black magic that allows us to read the response type from an artifact
    const IWeb2JsonVerification = artifacts.require("IWeb2JsonVerification");
    const responseType = IWeb2JsonVerification._json.abi[0].inputs[0].components[1];

    const decodedResponse: any = web3.eth.abi.decodeParameter(responseType, proof.response_hex);
    console.log("Decoded response:", decodedResponse, "\n");

    // abiSignature declares ONE top-level "dto" tuple param, not two flat params, so
    // abiEncodedData must be decoded as that single (dynamic) tuple type - decoding it
    // as flat (string, uint256) reads the tuple's outer offset word as the string offset
    // and silently produces garbage.
    const dtoType = JSON.parse(abiSignature);
    const decodedDto: any = web3.eth.abi.decodeParameter(dtoType, decodedResponse.responseBody.abiEncodedData);
    const flightStatus: string = decodedDto.flightStatus;
    const delayMinutes: string = decodedDto.delayMinutes;
    console.log(`Flight status: ${flightStatus}, delay: ${delayMinutes} min\n`);

    return {
        settleProof: { merkleProof: proof.proof, data: decodedResponse },
        flightStatus,
        delayMinutes,
    };
}

async function main() {
    const requestBody = buildFlightRequestBody(flightIata, flightDate);
    console.log("Attesting via proxy:", requestBody.url, "\n");
    console.log("Request hash (for buyCover):", computeRequestHash(requestBody), "\n");

    const data = await prepareAttestationRequest(requestBody);
    console.log("Prepared request data:", data, "\n");

    if (data.status !== "VALID" || !data.abiEncodedRequest) {
        throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
    }

    const abiEncodedRequest = data.abiEncodedRequest;
    const roundId = await submitAttestationRequest(abiEncodedRequest);

    const proof = await retrieveDataAndProof(abiEncodedRequest, roundId);

    const { settleProof } = decodeProof(proof);

    console.log("Attestation complete. Proof ready for FlightGuard.settle(policyId, proof):\n", settleProof, "\n");
}

// Guard direct execution only: hardhat forks each `hardhat run` script as its own
// process entry point (so this is true then), but demo.ts imports buildFlightRequestBody
// / computeRequestHash from this file and must not trigger this file's own main().
if (require.main === module) {
    void main().then(() => {
        process.exit(0);
    });
}

/*
 * NOTES / RISKS:
 * - Flight data: airlabs.co /v9/flight (free tier: 1000 req/month total).
 *   AviationStack was abandoned: verifier server fetches to it fail
 *   ('INVALID: FETCH ERROR') even though browser requests succeed.
 * - The jq date-lock uses dep_time_utc (scheduled departure, always present even for
 *   cancellations, and not shifted by overnight arrivals landing on the next UTC date)
 *   so the same requestHash computed at buyCover time still matches at settle time.
 * - Requests are attested via our own GET /api/flight-proxy, not airlabs.co directly, so
 *   FLIGHT_API_KEY never appears in the attested request's queryParams / onchain calldata.
 *   Policies bought before this existed still settle via buildLegacyFlightRequestBody
 *   (see keeper.ts / settle.ts's resolveFlightRequestBody fallback).
 */
