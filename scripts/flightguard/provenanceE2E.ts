import fs from "fs";
import path from "path";
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

// FLIGHT=OH5026 DATE=2026-08-07 npx hardhat run scripts/flightguard/provenanceE2E.ts --network coston2
//
// Live end-to-end for settlement provenance: buys cover, runs a real FDC Web2Json
// attestation of the deployed flight-proxy, settles, and reports the Provenance the
// settlement was recorded with.
//
// This is the script that demonstrates the auditability property: whatever the data
// situation turns out to be - two sources agreeing, one source answering alone, or no source
// having a record at all - the settlement says so onchain instead of collapsing every
// outcome into an indistinguishable "no payout".

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL } = process.env;

const coverAmount = web3.utils.toWei("2", "mwei");
const premiumBps = 1000;
const scheduledArrivalDelaySec = 90;

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
    const flightIata = process.env.FLIGHT;
    const flightDate = process.env.DATE;
    if (!flightIata || !flightDate)
        throw new Error("FLIGHT and DATE are required (e.g. FLIGHT=OH5026 DATE=2026-08-07)");

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    console.log("FlightGuard:", flightGuard.address);
    console.log("Flight:     ", flightIata, flightDate, "\n");

    // What the deployed proxy is actually serving right now - the attestation will read
    // exactly this, so print it before spending anything.
    const requestBody = buildFlightRequestBody(flightIata, flightDate);
    const probeUrl = `${requestBody.url}?flight_iata=${encodeURIComponent(flightIata)}&date=${flightDate}`;
    const probe = await fetch(probeUrl).then((r) => r.json());
    console.log("Deployed proxy `.resolved`:", JSON.stringify(probe.resolved ?? null));
    if (!probe.resolved) {
        console.log(
            "  (no `.resolved` block - this proxy predates the multi-source resolver, so the\n" +
                "   attested DTO will degrade to EMPTY/none and settle as DataUnavailable)"
        );
    }
    console.log();

    const premium = (BigInt(coverAmount) * BigInt(premiumBps)) / 10_000n;
    const free = BigInt((await flightGuard.freeLiquidity()).toString());
    if (free < BigInt(coverAmount)) throw new Error(`freeLiquidity ${free} < coverAmount ${coverAmount}`);
    await token.approve(flightGuard.address, premium.toString(), { from: account });

    const requestHash = computeRequestHash(requestBody);
    const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
    const buyTx = await flightGuard.buyCover(
        coverAmount,
        premiumBps,
        scheduledArrival,
        requestHash,
        `${flightIata}|${flightDate}`,
        false,
        { from: account }
    );
    const policyId = buyTx.logs.find((e: any) => e.event === "CoverBought")!.args.policyId;
    console.log("BuyCover tx:", buyTx.tx, "policyId:", policyId.toString(), "\n");

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

    const wait = scheduledArrival - Math.floor(Date.now() / 1000);
    if (wait > 0) {
        console.log(`Waiting ${wait}s for scheduledArrival...\n`);
        await new Promise((r) => setTimeout(r, wait * 1000));
    }

    const balanceBefore = BigInt((await token.balanceOf(account)).toString());
    const settleTx = await flightGuard.settle(policyId, settleProof, { from: account });
    const balanceAfter = BigInt((await token.balanceOf(account)).toString());
    const evidence = settleTx.logs.find((e: any) => e.event === "SettlementEvidence");
    const policy = await flightGuard.policies(policyId);

    console.log("Settle tx:", settleTx.tx, "\n");
    console.log("=== RESULT ===");
    console.log("Policy status:      ", STATUS[Number(policy.status)]);
    console.log("Policy provenance:  ", PROVENANCE[Number(policy.provenance)]);
    console.log(
        "SettlementEvidence: ",
        evidence ? `provenance=${evidence.args.provenance} source=${evidence.args.source}` : "MISSING"
    );
    console.log("Holder USDT0 delta: ", (balanceAfter - balanceBefore).toString());

    if (!evidence) throw new Error("SettlementEvidence was not emitted");
    if (Number(evidence.args.provenance) !== Number(policy.provenance)) {
        throw new Error("Event provenance disagrees with stored provenance");
    }
    if (Number(policy.provenance) === 0) throw new Error("Provenance is still Unsettled after settle()");

    // The claim the flag exists to support: a no-data settlement is now distinguishable
    // onchain from a confirmed on-time arrival, instead of both reading as a bare NoPayout.
    if (Number(policy.provenance) === 3) {
        console.log(
            "\nOK: settled on ABSENCE OF DATA and said so onchain (DataUnavailable).\n" +
                "    Before this flag, this transaction was indistinguishable from a flight that\n" +
                "    simply arrived on time."
        );
    } else {
        console.log(
            `\nOK: settled on real flight data, recorded as ${PROVENANCE[Number(policy.provenance)]} ` +
                `from source "${evidence.args.source}".`
        );
    }
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
