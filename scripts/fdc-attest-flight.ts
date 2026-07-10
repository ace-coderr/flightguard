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
 * COSTON2_DA_LAYER_URL, FLIGHT_API_KEY
 */

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL, FLIGHT_API_KEY } = process.env;

// yarn hardhat run scripts/fdc-attest-flight.ts --network coston2

// EDIT ME: flight to attest. IATA flight number + YYYY-MM-DD date (must be today on free plan).
const flightIata = "BA75";
const flightDate = "2026-07-09";

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
// The select() locks the proof to the requested date: if the API is returning a
// different day's flight, jq outputs nothing and the attestation fails instead of
// attesting the wrong flight.
function buildPostProcessJq(date: string) {
    return `{flightStatus: (.response.status // .error.message // "EMPTY"), delayMinutes: (.response.arr_delayed // 0)}`;
}

// The exact request we attest. IMPORTANT: this same (url, postProcessJq, abiSignature)
// tuple is hashed into requestHash at buyCover time.
export function buildFlightRequestBody(flightIataCode: string, date: string, apiKey: string) {
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
// keccak256(abi.encode(url, postProcessJq, abiSignature))
export function computeRequestHash(requestBody: { url: string; postProcessJq: string; abiSignature: string }) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "string"],
            [requestBody.url, requestBody.postProcessJq, requestBody.abiSignature]
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

    const decodedDto = web3.eth.abi.decodeParameters(
        ["string", "uint256"],
        decodedResponse.responseBody.abiEncodedData
    );
    const flightStatus: string = decodedDto[0];
    const delayMinutes: string = decodedDto[1];
    console.log(`Flight status: ${flightStatus}, delay: ${delayMinutes} min\n`);

    return {
        settleProof: { merkleProof: proof.proof, data: decodedResponse },
        flightStatus,
        delayMinutes,
    };
}

async function main() {
    if (!FLIGHT_API_KEY) {
        throw new Error("FLIGHT_API_KEY not set in .env");
    }

    const requestBody = buildFlightRequestBody(flightIata, flightDate, FLIGHT_API_KEY);
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

void main().then(() => {
    process.exit(0);
});

/*
 * NOTES / RISKS:
 * - Flight data: airlabs.co /v9/flight (free tier: 1000 req/month total).
 *   AviationStack was abandoned: verifier server fetches to it fail
 *   ('INVALID: FETCH ERROR') even though browser requests succeed.
 * - The jq date-lock uses arr_time_utc (scheduled arrival, stable) so the same
 *   requestHash computed at buyCover time still matches at settle time.
 * - API key in URL is visible in the attested request onchain. Fine for demo;
 *   note it in README as known limitation + roadmap item.
 */
