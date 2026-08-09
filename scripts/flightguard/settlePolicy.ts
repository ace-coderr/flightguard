import fs from "fs";
import path from "path";
import { flightGuardAddress, usdt0Address, fxrpAddress } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { parseFlightRef, resolveFlightRequestBody } from "../../web/lib/server/flightRequest";
import {
    prepareAttestationRequestBase,
    submitAttestationRequest,
    retrieveDataAndProofBaseWithRetry,
} from "../utils/fdc";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// POLICY_ID=1 npx hardhat run scripts/flightguard/settlePolicy.ts --network coston2
//
// Settles ONE existing policy by id, rather than buying a new one. This is the manual
// counterpart to the autonomous keeper: same steps (rebuild the policy's exact attested
// request from its onchain flightRef, run the FDC cycle, call settle()), but targeted and
// run by hand - for unblocking a policy whose liquidity you don't want locked until the
// claim window expires.
//
// Reads everything it needs from chain, so it cannot settle the wrong flight: the request is
// rebuilt from the policy's own flightRef and checked against its stored requestHash before
// any fee is spent.

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL } = process.env;

const PROVENANCE = ["Unsettled", "Corroborated", "SingleSource", "DataUnavailable"];
const STATUS = ["Active", "PaidOut", "Expired", "NoPayout"];

function loadWebEnv() {
    const envPath = path.join(__dirname, "..", "..", "web", ".env.local");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
}

function decodeProof(proof: any, abiSignature: string) {
    const IWeb2JsonVerification = artifacts.require("IWeb2JsonVerification");
    const responseType = IWeb2JsonVerification._json.abi[0].inputs[0].components[1];
    const decodedResponse: any = web3.eth.abi.decodeParameter(responseType, proof.response_hex);
    const dto: any = web3.eth.abi.decodeParameter(
        JSON.parse(abiSignature),
        decodedResponse.responseBody.abiEncodedData
    );
    return { settleProof: { merkleProof: proof.proof, data: decodedResponse }, dto };
}

async function main() {
    loadWebEnv();
    const policyId = process.env.POLICY_ID;
    if (policyId === undefined) throw new Error("POLICY_ID is required (e.g. POLICY_ID=1)");
    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) throw new Error("FLIGHT_API_KEY is not set");

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    const fxrp: MockUSDT0Instance = await MockUSDT0.at(fxrpAddress);

    const policy = await flightGuard.policies(policyId);
    const scheduledArrival = Number(policy.scheduledArrival);
    const claimWindow = Number(await flightGuard.CLAIM_WINDOW());
    const now = Math.floor(Date.now() / 1000);

    console.log("FlightGuard:", flightGuard.address);
    console.log(`policy ${policyId}: ${policy.flightRef}`);
    console.log(`  status=${STATUS[Number(policy.status)]} payoutInFxrp=${policy.payoutInFxrp}`);
    console.log(`  cover=${policy.coverAmount.toString()} holder=${policy.holder}`);

    if (Number(policy.status) !== 0) throw new Error(`policy is ${STATUS[Number(policy.status)]}, not Active`);
    if (now < scheduledArrival) throw new Error(`too early - scheduled arrival is in ${scheduledArrival - now}s`);
    if (now > scheduledArrival + claimWindow) {
        throw new Error("claim window has closed - call expire() instead to unlock the cover");
    }

    // Rebuild the policy's exact attested request from its own flightRef and confirm it
    // hashes to what the policy stored, BEFORE paying for an attestation.
    const { flightIata, date } = parseFlightRef(policy.flightRef);
    const resolved = resolveFlightRequestBody(flightIata, date, policy.requestHash as `0x${string}`, apiKey);
    if (!resolved) throw new Error(`requestHash does not match any known scheme for "${policy.flightRef}"`);
    if (resolved.scheme !== "provenance") {
        throw new Error(`policy uses the ${resolved.scheme} scheme, which this contract cannot decode`);
    }
    const requestBody = resolved.requestBody;
    console.log(`  request scheme: ${resolved.scheme} (requestHash matches)\n`);

    // Show what the proxy is serving right now - this is what will be attested.
    const probe = await fetch(`${requestBody.url}?flight_iata=${encodeURIComponent(flightIata)}&date=${date}`).then(
        (r) => r.json()
    );
    console.log("Live proxy `.resolved`:", JSON.stringify(probe.resolved ?? null), "\n");

    if (policy.payoutInFxrp) {
        const quote = await flightGuard.previewFxrpPayout.call(policy.coverAmount);
        const reserve = BigInt((await flightGuard.fxrpPayoutReserve()).toString());
        console.log(`FXRP payout: needs ~${quote.fxrpAmount.toString()}, reserve holds ${reserve}`);
        if (reserve < BigInt(quote.fxrpAmount.toString())) {
            console.log("  WARNING: reserve is short - a payout would fall back to USDT0\n");
        } else {
            console.log("  reserve is sufficient\n");
        }
    }

    const data = await prepareAttestationRequestBase(
        `${VERIFIER_URL_TESTNET}/verifier/web2/Web2Json/prepareRequest`,
        VERIFIER_API_KEY_TESTNET,
        "Web2Json",
        "PublicWeb2",
        requestBody
    );
    if (data.status !== "VALID" || !data.abiEncodedRequest) {
        throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
    }
    const roundId = await submitAttestationRequest(data.abiEncodedRequest);
    const proof = await retrieveDataAndProofBaseWithRetry(
        `${COSTON2_DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`,
        data.abiEncodedRequest,
        roundId
    );
    const { settleProof, dto } = decodeProof(proof, requestBody.abiSignature);
    console.log(
        `\nAttested DTO: flightStatus=${dto.flightStatus} delayMinutes=${dto.delayMinutes} ` +
            `source=${dto.source} corroborated=${dto.corroborated}\n`
    );

    const usdt0Before = BigInt((await token.balanceOf(policy.holder)).toString());
    const fxrpBefore = BigInt((await fxrp.balanceOf(policy.holder)).toString());
    const lockedBefore = BigInt((await flightGuard.totalLocked()).toString());

    // Explicit gas: the FXRP-payout branch (two FTSO reads + an FAsset transfer) can exceed
    // a bare estimate, and falling short reverts the whole settlement rather than degrading.
    const settleTx = await flightGuard.settle(policyId, settleProof, { from: account, gas: 1_000_000 });
    console.log("Settle tx:", settleTx.tx, "\n");

    const after = await flightGuard.policies(policyId);
    const usdt0After = BigInt((await token.balanceOf(policy.holder)).toString());
    const fxrpAfter = BigInt((await fxrp.balanceOf(policy.holder)).toString());
    const lockedAfter = BigInt((await flightGuard.totalLocked()).toString());
    const evidence = settleTx.logs.find((e: any) => e.event === "SettlementEvidence");
    const paidFxrp = settleTx.logs.find((e: any) => e.event === "PaidOutInFxrp");

    console.log("=== RESULT ===");
    console.log("status:      ", STATUS[Number(after.status)]);
    console.log(
        "provenance:  ",
        PROVENANCE[Number(after.provenance)],
        evidence ? `(source=${evidence.args.source})` : ""
    );
    console.log("holder USDT0:", `${usdt0Before} -> ${usdt0After} (delta ${usdt0After - usdt0Before})`);
    console.log("holder FXRP: ", `${fxrpBefore} -> ${fxrpAfter} (delta ${fxrpAfter - fxrpBefore})`);
    console.log("totalLocked: ", `${lockedBefore} -> ${lockedAfter} (released ${lockedBefore - lockedAfter})`);
    if (paidFxrp) {
        console.log(
            `PaidOutInFxrp: ${paidFxrp.args.fxrpAmount.toString()} FXRP at XRP/USD ` +
                `$${web3.utils.fromWei(paidFxrp.args.xrpUsdPriceWei.toString(), "ether")}`
        );
    }

    if (Number(after.status) === 0) throw new Error("policy is still Active after settle()");
    if (lockedAfter >= lockedBefore) throw new Error("totalLocked did not fall - cover was not released");
    console.log(`\nOK: policy ${policyId} settled and its cover released back to the pool.`);
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
