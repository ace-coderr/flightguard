import { flightGuardAddress, usdt0Address } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { buildFlightRequestBody, computeRequestHash } from "../fdc-attest-flight";
import {
    prepareAttestationRequestBase,
    submitAttestationRequest,
    retrieveDataAndProofBaseWithRetry,
} from "../utils/fdc";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/demo.ts --network coston2
//
// Full happy path: deposit -> buyCover -> FDC attestation cycle -> settle.
// Needs scripts/flightguard/config.ts, which is written by deploy.ts - run that first.

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL, FLIGHT_API_KEY } = process.env;

// EDIT ME: flight to attest. IATA flight number + YYYY-MM-DD date (must be today on free plan).
const flightIata = "BA75";
const flightDate = "2026-07-10";

const depositAmount = web3.utils.toWei("5", "mwei"); // 5 USDT0 backer deposit (6 decimals)
const coverAmount = web3.utils.toWei("2", "mwei"); // 2 USDT0 cover bought against that pool
const scheduledArrivalDelaySec = 60; // flight "lands" 1 min from now

const attestationTypeBase = "Web2Json";
const sourceIdBase = "PublicWeb2";
const verifierUrlBase = VERIFIER_URL_TESTNET;

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

// Same decode as fdc-attest-flight.ts's decodeProof: abiSignature is a single "dto" tuple,
// so it must be decoded as one dynamic tuple type, not as flat (string, uint256).
function decodeProof(proof: any, abiSignature: string) {
    console.log("Proof hex:", proof.response_hex, "\n");

    const IWeb2JsonVerification = artifacts.require("IWeb2JsonVerification");
    const responseType = IWeb2JsonVerification._json.abi[0].inputs[0].components[1];
    const decodedResponse: any = web3.eth.abi.decodeParameter(responseType, proof.response_hex);

    const dtoType = JSON.parse(abiSignature);
    const decodedDto: any = web3.eth.abi.decodeParameter(dtoType, decodedResponse.responseBody.abiEncodedData);
    console.log(`Flight status: ${decodedDto.flightStatus}, delay: ${decodedDto.delayMinutes} min\n`);

    return { merkleProof: proof.proof, data: decodedResponse };
}

async function logPoolState(flightGuard: FlightGuardInstance, label: string) {
    const poolBalance = await flightGuard.poolBalance();
    const totalLocked = await flightGuard.totalLocked();
    const freeLiquidity = await flightGuard.freeLiquidity();
    console.log(`--- Pool state (${label}) ---`);
    console.log(`poolBalance:   ${web3.utils.fromWei(poolBalance.toString(), "mwei")} USDT0`);
    console.log(`totalLocked:   ${web3.utils.fromWei(totalLocked.toString(), "mwei")} USDT0`);
    console.log(`freeLiquidity: ${web3.utils.fromWei(freeLiquidity.toString(), "mwei")} USDT0\n`);
}

async function main() {
    if (!FLIGHT_API_KEY) {
        throw new Error("FLIGHT_API_KEY not set in .env");
    }

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    console.log("FlightGuard:", flightGuard.address);
    console.log("USDT0:      ", token.address);
    console.log("Account:    ", account, "\n");

    // 1. Backer: approve + deposit into the pool
    const premiumBps = await flightGuard.PREMIUM_BPS();
    const premium = (BigInt(coverAmount) * BigInt(premiumBps.toString())) / 10_000n;
    const totalApproval = BigInt(depositAmount) + premium;
    await token.approve(flightGuard.address, totalApproval.toString(), { from: account });
    console.log(`Approved ${web3.utils.fromWei(totalApproval.toString(), "mwei")} USDT0 (deposit + premium)\n`);

    const depositTx = await flightGuard.deposit(depositAmount, { from: account });
    console.log("Deposit tx:", depositTx.tx, "\n");
    await logPoolState(flightGuard, "after deposit");

    // 2. Traveler: buy cover for the flight
    const requestBody = buildFlightRequestBody(flightIata, flightDate, FLIGHT_API_KEY);
    const requestHash = computeRequestHash(requestBody);
    console.log("Request hash:", requestHash, "\n");

    const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
    const buyTx = await flightGuard.buyCover(coverAmount, scheduledArrival, requestHash, { from: account });
    const coverBoughtEvent = buyTx.logs.find((e: any) => e.event === "CoverBought");
    const policyId = coverBoughtEvent.args.policyId;
    console.log("BuyCover tx:", buyTx.tx, "policyId:", policyId.toString(), "\n");
    await logPoolState(flightGuard, "after buyCover");

    // 3. Run the FDC attestation cycle: prepareRequest -> FdcHub submit -> wait for round -> DA proof
    const data = await prepareAttestationRequest(requestBody);
    console.log("Prepared request data:", data, "\n");
    if (data.status !== "VALID" || !data.abiEncodedRequest) {
        throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
    }

    const abiEncodedRequest = data.abiEncodedRequest;
    const roundId = await submitAttestationRequest(abiEncodedRequest);
    const proof = await retrieveDataAndProof(abiEncodedRequest, roundId);
    const settleProof = decodeProof(proof, requestBody.abiSignature);

    // scheduledArrival has almost certainly passed by now (round finalization alone takes
    // 90-180s), but wait out any remainder so settle()'s "too early" check can't trip.
    const secondsUntilArrival = scheduledArrival - Math.floor(Date.now() / 1000);
    if (secondsUntilArrival > 0) {
        console.log(`Waiting ${secondsUntilArrival}s for scheduledArrival...\n`);
        await new Promise((resolve) => setTimeout(resolve, secondsUntilArrival * 1000));
    }

    // 4. Settle
    const holderBalanceBefore = BigInt((await token.balanceOf(account)).toString());
    const settleTx = await flightGuard.settle(policyId, settleProof, { from: account });
    console.log("Settle tx:", settleTx.tx, "\n");
    const holderBalanceAfter = BigInt((await token.balanceOf(account)).toString());

    const policy = await flightGuard.policies(policyId);
    const statusNames = ["Active", "PaidOut", "Expired", "NoPayout"];

    console.log("--- Result ---");
    console.log("Policy status:", statusNames[Number(policy.status)]);
    console.log(
        "Holder balance change:",
        web3.utils.fromWei((holderBalanceAfter - holderBalanceBefore).toString(), "mwei"),
        "USDT0\n"
    );
    await logPoolState(flightGuard, "after settle");
}

void main().then(() => {
    process.exit(0);
});
