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

// yarn hardhat run scripts/flightguard/settleLandedDelayed.ts --network coston2
//
// Verification run: buy cover on a real LANDED flight with arr_delayed >= 120 (picked live
// from airlabs /v9/delays?type=arrivals&delay=120, filtered to status=landed, confirmed via
// GET https://flightguard.vercel.app/api/flight-proxy), run the full FDC attestation cycle
// through that same deployed proxy, settle(), and report whether it paid out.

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL } = process.env;

const flightIata = "G58846";
const flightDate = "2026-07-11"; // matches dep_time_utc's date (the jq date-lock)

const depositAmount = web3.utils.toWei("2", "mwei"); // top up free liquidity if needed
const coverAmount = web3.utils.toWei("2", "mwei");
const scheduledArrivalDelaySec = 90; // synthetic near-future deadline; buyCover requires a future ts

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

function decodeProof(proof: any, abiSignature: string) {
    console.log("Proof hex:", proof.response_hex, "\n");
    const IWeb2JsonVerification = artifacts.require("IWeb2JsonVerification");
    const responseType = IWeb2JsonVerification._json.abi[0].inputs[0].components[1];
    const decodedResponse: any = web3.eth.abi.decodeParameter(responseType, proof.response_hex);

    const dtoType = JSON.parse(abiSignature);
    const decodedDto: any = web3.eth.abi.decodeParameter(dtoType, decodedResponse.responseBody.abiEncodedData);
    console.log(`Decoded flightStatus: ${decodedDto.flightStatus}, delayMinutes: ${decodedDto.delayMinutes}\n`);

    return {
        settleProof: { merkleProof: proof.proof, data: decodedResponse },
        flightStatus: decodedDto.flightStatus,
        delayMinutes: decodedDto.delayMinutes,
    };
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
    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    console.log("FlightGuard:", flightGuard.address);
    console.log("USDT0:      ", token.address);
    console.log("Account:    ", account, "\n");

    await logPoolState(flightGuard, "before");

    const premiumBps = await flightGuard.PREMIUM_BPS();
    const premium = (BigInt(coverAmount) * BigInt(premiumBps.toString())) / 10_000n;
    const freeLiquidity = BigInt((await flightGuard.freeLiquidity()).toString());

    if (freeLiquidity < BigInt(coverAmount)) {
        const totalApproval = BigInt(depositAmount) + premium;
        await token.approve(flightGuard.address, totalApproval.toString(), { from: account });
        const depositTx = await flightGuard.deposit(depositAmount, { from: account });
        console.log("Deposit tx (topped up free liquidity):", depositTx.tx, "\n");
    } else {
        await token.approve(flightGuard.address, premium.toString(), { from: account });
    }

    // 1. Traveler: buy cover for the flight
    const requestBody = buildFlightRequestBody(flightIata, flightDate);
    const requestHash = computeRequestHash(requestBody);
    console.log("Attesting via proxy:", requestBody.url);
    console.log("Request hash:", requestHash, "\n");

    const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
    const flightRef = `${flightIata}|${flightDate}`;
    const buyTx = await flightGuard.buyCover(coverAmount, scheduledArrival, requestHash, flightRef, { from: account });
    const coverBoughtEvent = buyTx.logs.find((e: any) => e.event === "CoverBought");
    const policyId = coverBoughtEvent.args.policyId;
    console.log("BuyCover tx:", buyTx.tx, "policyId:", policyId.toString(), "\n");
    await logPoolState(flightGuard, "after buyCover");

    // 2. FDC attestation cycle: prepareRequest -> FdcHub submit -> wait for round -> DA proof
    const data = await prepareAttestationRequest(requestBody);
    console.log("Prepared request data:", data, "\n");
    if (data.status !== "VALID" || !data.abiEncodedRequest) {
        throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
    }

    const abiEncodedRequest = data.abiEncodedRequest;
    const roundId = await submitAttestationRequest(abiEncodedRequest);
    const proof = await retrieveDataAndProof(abiEncodedRequest, roundId);
    const { settleProof, flightStatus, delayMinutes } = decodeProof(proof, requestBody.abiSignature);

    const secondsUntilArrival = scheduledArrival - Math.floor(Date.now() / 1000);
    if (secondsUntilArrival > 0) {
        console.log(`Waiting ${secondsUntilArrival}s for scheduledArrival...\n`);
        await new Promise((resolve) => setTimeout(resolve, secondsUntilArrival * 1000));
    }

    // 3. Settle
    const holderBalanceBefore = BigInt((await token.balanceOf(account)).toString());
    const settleTx = await flightGuard.settle(policyId, settleProof, { from: account });
    console.log("Settle tx:", settleTx.tx, "\n");
    const holderBalanceAfter = BigInt((await token.balanceOf(account)).toString());

    const policy = await flightGuard.policies(policyId);
    const statusNames = ["Active", "PaidOut", "Expired", "NoPayout"];
    const finalStatus = statusNames[Number(policy.status)];
    const paidOut = Number(policy.status) === 1;

    console.log("=== RESULT ===");
    console.log("Flight:", flightIata, flightDate);
    console.log("Decoded flightStatus:", flightStatus);
    console.log("Decoded delayMinutes:", delayMinutes);
    console.log("Policy status:", finalStatus);
    console.log("PAID OUT:", paidOut);
    console.log(
        "Holder balance change:",
        web3.utils.fromWei((holderBalanceAfter - holderBalanceBefore).toString(), "mwei"),
        "USDT0\n"
    );
    await logPoolState(flightGuard, "after settle");
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
