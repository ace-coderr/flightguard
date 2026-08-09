import fs from "fs";
import path from "path";
import { flightGuardAddress, usdt0Address, fxrpAddress } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { buildFlightRequestBody, computeRequestHash } from "../fdc-attest-flight";
import {
    prepareAttestationRequestBase,
    submitAttestationRequest,
    retrieveDataAndProofBaseWithRetry,
} from "../utils/fdc";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/fxrpPayoutE2E.ts --network coston2
//
// Live end-to-end proof of the FXRP payout leg on Coston2: find a real flight that has
// already landed 2h+ late, buy cover on it with payoutInFxrp = true, run the full FDC
// Web2Json attestation cycle, settle(), and confirm real FXRP (not USDT0) landed in the
// traveler's wallet at the FTSO rate read inside the settlement transaction.
//
// Set FXRP_E2E_FLIGHT / FXRP_E2E_DATE to pin a known flight instead of discovering one.

const { VERIFIER_URL_TESTNET, VERIFIER_API_KEY_TESTNET, COSTON2_DA_LAYER_URL } = process.env;

const coverAmount = web3.utils.toWei("2", "mwei"); // 2 USDT0 cover (6 decimals)
const premiumBps = 1000; // documented flat fallback - this script verifies settlement, not pricing
const scheduledArrivalDelaySec = 90; // synthetic near-future deadline; buyCover requires a future ts

const attestationTypeBase = "Web2Json";
const sourceIdBase = "PublicWeb2";

function loadWebEnv() {
    const envPath = path.join(__dirname, "..", "..", "web", ".env.local");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
}

function proxyBase() {
    const base = process.env.NEXT_PUBLIC_APP_URL;
    if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not set");
    return base.replace(/\/$/, "");
}

type Candidate = { flightIata: string; date: string; status: string; arrDelayed: number };

/**
 * Reads a flight through the SAME public proxy endpoint the FDC verifier will fetch, so a
 * candidate is only accepted if the exact bytes the attestation will see already satisfy
 * the payout condition (status cancelled, or arr_delayed >= 120 with the dep_time_utc date
 * the jq filter locks on).
 */
async function inspectViaProxy(flightIata: string, dateHint?: string): Promise<Candidate | null> {
    const url = `${proxyBase()}/api/flight-proxy?flight_iata=${encodeURIComponent(flightIata)}&date=${
        dateHint ?? "2000-01-01"
    }`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: Record<string, unknown> };
    const r = json.response;
    if (!r || typeof r.dep_time_utc !== "string") return null;

    const status = typeof r.status === "string" ? r.status : "unknown";
    const arrDelayed = typeof r.arr_delayed === "number" ? r.arr_delayed : 0;
    return { flightIata, date: r.dep_time_utc.slice(0, 10), status, arrDelayed };
}

function wouldPayOut(c: Candidate) {
    return c.status === "cancelled" || c.arrDelayed >= 120;
}

/** airlabs' live delays feed, narrowed to flights that have already landed 2h+ late - a
 *  still-airborne flight's delay can shrink before it lands, and settle() reads the value
 *  as of attestation time. */
async function discoverFlight(apiKey: string): Promise<Candidate> {
    const pinned = process.env.FXRP_E2E_FLIGHT;
    if (pinned) {
        const c = await inspectViaProxy(pinned, process.env.FXRP_E2E_DATE);
        if (!c) throw new Error(`Pinned flight ${pinned} not found via the proxy`);
        if (process.env.FXRP_E2E_DATE) c.date = process.env.FXRP_E2E_DATE;
        if (!wouldPayOut(c)) {
            throw new Error(`Pinned flight ${pinned} would not pay out (status=${c.status}, delay=${c.arrDelayed})`);
        }
        return c;
    }

    const url = `https://airlabs.co/api/v9/delays?${new URLSearchParams({
        api_key: apiKey,
        delay: "120",
        type: "arrivals",
    })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`airlabs delays responded ${res.status}`);
    const json = (await res.json()) as { response?: { flight_iata?: string; status?: string; delayed?: number }[] };
    const entries = (json.response ?? [])
        .filter((e) => e.flight_iata && e.status === "landed")
        .sort((a, b) => (b.delayed ?? 0) - (a.delayed ?? 0));

    console.log(`Delay radar: ${entries.length} landed arrivals currently reported 120min+ late`);

    for (const e of entries.slice(0, 12)) {
        const c = await inspectViaProxy(e.flight_iata);
        if (!c) continue;
        console.log(`  candidate ${c.flightIata}: status=${c.status} arr_delayed=${c.arrDelayed} date=${c.date}`);
        if (wouldPayOut(c)) return c;
    }
    throw new Error("No landed 2h+ delayed flight confirmed through the proxy right now - rerun shortly");
}

async function prepareAttestationRequest(requestBody: ReturnType<typeof buildFlightRequestBody>) {
    const url = `${VERIFIER_URL_TESTNET}/verifier/web2/Web2Json/prepareRequest`;
    return await prepareAttestationRequestBase(
        url,
        VERIFIER_API_KEY_TESTNET,
        attestationTypeBase,
        sourceIdBase,
        requestBody
    );
}

async function retrieveDataAndProof(abiEncodedRequest: string, roundId: number) {
    const url = `${COSTON2_DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`;
    return await retrieveDataAndProofBaseWithRetry(url, abiEncodedRequest, roundId);
}

function decodeProof(proof: any, abiSignature: string) {
    const IWeb2JsonVerification = artifacts.require("IWeb2JsonVerification");
    const responseType = IWeb2JsonVerification._json.abi[0].inputs[0].components[1];
    const decodedResponse: any = web3.eth.abi.decodeParameter(responseType, proof.response_hex);
    const decodedDto: any = web3.eth.abi.decodeParameter(
        JSON.parse(abiSignature),
        decodedResponse.responseBody.abiEncodedData
    );
    console.log(`Decoded flightStatus: ${decodedDto.flightStatus}, delayMinutes: ${decodedDto.delayMinutes}\n`);
    return {
        settleProof: { merkleProof: proof.proof, data: decodedResponse },
        flightStatus: decodedDto.flightStatus,
        delayMinutes: decodedDto.delayMinutes,
    };
}

async function main() {
    loadWebEnv();
    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) throw new Error("FLIGHT_API_KEY is not set");

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    const fxrp: MockUSDT0Instance = await MockUSDT0.at(fxrpAddress);
    console.log("FlightGuard:", flightGuard.address);
    console.log("Account:    ", account, "\n");

    const flight = await discoverFlight(apiKey);
    console.log(
        `\nUsing ${flight.flightIata} on ${flight.date} (status=${flight.status}, arr_delayed=${flight.arrDelayed})\n`
    );

    // 1. Make sure the pool can back the cover and the reserve can fund an FXRP payout.
    const free = BigInt((await flightGuard.freeLiquidity()).toString());
    if (free < BigInt(coverAmount)) {
        throw new Error(`freeLiquidity ${free} < coverAmount ${coverAmount} - deposit into the pool first`);
    }
    const payoutQuote = await flightGuard.previewFxrpPayout.call(coverAmount);
    const reserve = BigInt((await flightGuard.fxrpPayoutReserve()).toString());
    console.log(`Live XRP/USD:  $${web3.utils.fromWei(payoutQuote.xrpUsdPriceWei.toString(), "ether")}`);
    console.log(`Live USDT/USD: $${web3.utils.fromWei(payoutQuote.usdtUsdPriceWei.toString(), "ether")}`);
    console.log(
        `Estimated payout: ${web3.utils.fromWei(payoutQuote.fxrpAmount.toString(), "mwei")} FXRP ` +
            `for ${web3.utils.fromWei(coverAmount, "mwei")} USDT0 of cover`
    );
    console.log(`fxrpPayoutReserve: ${web3.utils.fromWei(reserve.toString(), "mwei")} FXRP\n`);
    if (reserve < BigInt(payoutQuote.fxrpAmount.toString())) {
        throw new Error("FXRP payout reserve is short - run fundFxrpPayoutReserve.ts first");
    }

    // 2. Buy cover, electing an FXRP payout.
    const premium = (BigInt(coverAmount) * BigInt(premiumBps)) / 10_000n;
    await token.approve(flightGuard.address, premium.toString(), { from: account });

    const requestBody = buildFlightRequestBody(flight.flightIata, flight.date);
    const requestHash = computeRequestHash(requestBody);
    const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
    const flightRef = `${flight.flightIata}|${flight.date}`;

    const buyTx = await flightGuard.buyCover(
        coverAmount,
        premiumBps,
        scheduledArrival,
        requestHash,
        flightRef,
        true, // payoutInFxrp
        { from: account }
    );
    const policyId = buyTx.logs.find((e: any) => e.event === "CoverBought")!.args.policyId;
    console.log("BuyCover tx:", buyTx.tx, "policyId:", policyId.toString());
    console.log("policy.payoutInFxrp:", (await flightGuard.policies(policyId)).payoutInFxrp, "\n");

    // 3. FDC attestation cycle.
    const data = await prepareAttestationRequest(requestBody);
    if (data.status !== "VALID" || !data.abiEncodedRequest) {
        throw new Error(`Verifier rejected the request: ${JSON.stringify(data)}`);
    }
    const roundId = await submitAttestationRequest(data.abiEncodedRequest);
    const proof = await retrieveDataAndProof(data.abiEncodedRequest, roundId);
    const { settleProof, flightStatus, delayMinutes } = decodeProof(proof, requestBody.abiSignature);

    const secondsUntilArrival = scheduledArrival - Math.floor(Date.now() / 1000);
    if (secondsUntilArrival > 0) {
        console.log(`Waiting ${secondsUntilArrival}s for scheduledArrival...\n`);
        await new Promise((resolve) => setTimeout(resolve, secondsUntilArrival * 1000));
    }

    // 4. Settle and check what actually moved.
    const fxrpBefore = BigInt((await fxrp.balanceOf(account)).toString());
    const usdt0Before = BigInt((await token.balanceOf(account)).toString());
    const reserveBefore = BigInt((await flightGuard.fxrpPayoutReserve()).toString());
    const proceedsBefore = BigInt((await flightGuard.usdt0SwapProceeds()).toString());
    const poolBefore = BigInt((await flightGuard.poolBalance()).toString());

    const settleTx = await flightGuard.settle(policyId, settleProof, { from: account });
    console.log("Settle tx:", settleTx.tx, "\n");

    const fxrpAfter = BigInt((await fxrp.balanceOf(account)).toString());
    const usdt0After = BigInt((await token.balanceOf(account)).toString());
    const reserveAfter = BigInt((await flightGuard.fxrpPayoutReserve()).toString());
    const proceedsAfter = BigInt((await flightGuard.usdt0SwapProceeds()).toString());
    const poolAfter = BigInt((await flightGuard.poolBalance()).toString());

    const paidEvent = settleTx.logs.find((e: any) => e.event === "PaidOutInFxrp");
    const fellBack = settleTx.logs.find((e: any) => e.event === "FxrpPayoutUnavailable");
    const policy = await flightGuard.policies(policyId);

    console.log("=== RESULT ===");
    console.log("Flight:              ", flight.flightIata, flight.date);
    console.log("Attested flightStatus:", flightStatus, "delayMinutes:", delayMinutes.toString());
    console.log("Policy status:       ", ["Active", "PaidOut", "Expired", "NoPayout"][Number(policy.status)]);
    console.log(`Traveler FXRP:  ${fxrpBefore} -> ${fxrpAfter} (delta ${fxrpAfter - fxrpBefore})`);
    console.log(`Traveler USDT0: ${usdt0Before} -> ${usdt0After} (delta ${usdt0After - usdt0Before})`);
    console.log(`fxrpPayoutReserve:  ${reserveBefore} -> ${reserveAfter}`);
    console.log(`usdt0SwapProceeds:  ${proceedsBefore} -> ${proceedsAfter}`);
    console.log(`poolBalance:        ${poolBefore} -> ${poolAfter}`);

    if (fellBack) {
        throw new Error(
            `Payout fell back to USDT0: needed ${fellBack.args.fxrpAmountNeeded}, reserve had ${fellBack.args.fxrpReserveAvailable}`
        );
    }
    if (!paidEvent) throw new Error("No PaidOutInFxrp event - the policy did not pay out in FXRP");

    const paidFxrp = BigInt(paidEvent.args.fxrpAmount.toString());
    console.log(`\nPaidOutInFxrp: ${web3.utils.fromWei(paidFxrp.toString(), "mwei")} FXRP`);
    console.log(`  at XRP/USD  $${web3.utils.fromWei(paidEvent.args.xrpUsdPriceWei.toString(), "ether")}`);
    console.log(`  at USDT/USD $${web3.utils.fromWei(paidEvent.args.usdtUsdPriceWei.toString(), "ether")}`);

    // The settlement-time rate is read inside settle(), so recompute the expected amount
    // from the rates the event reports rather than from the earlier preview.
    const expectedFxrp =
        (BigInt(coverAmount) * BigInt(paidEvent.args.usdtUsdPriceWei.toString())) /
        BigInt(paidEvent.args.xrpUsdPriceWei.toString());

    if (Number(policy.status) !== 1) throw new Error("Policy did not reach PaidOut");
    if (paidFxrp !== expectedFxrp)
        throw new Error(`Paid ${paidFxrp} FXRP, expected ${expectedFxrp} at the event rates`);
    if (fxrpAfter - fxrpBefore !== paidFxrp) throw new Error("Traveler FXRP delta doesn't match the paid amount");
    if (usdt0After !== usdt0Before) throw new Error("Traveler received USDT0 on an FXRP-payout policy");
    if (reserveBefore - reserveAfter !== paidFxrp) throw new Error("Reserve didn't decrease by the paid FXRP");
    if (proceedsAfter - proceedsBefore !== BigInt(coverAmount)) {
        throw new Error("usdt0SwapProceeds didn't absorb the cover amount");
    }
    if (poolBefore - poolAfter !== BigInt(coverAmount)) {
        throw new Error("poolBalance didn't fall by the cover amount, as it would for a USDT0 payout");
    }

    console.log("\nOK: live FXRP payout confirmed onchain - real FDC proof, real FTSO rate at settlement,");
    console.log("    real FXRP in the traveler's wallet, and the pool moved exactly as a USDT0 payout would.");
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
