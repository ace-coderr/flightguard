import fs from "fs";
import path from "path";
import { flightGuardAddress, usdt0Address, fxrpAddress } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { buildFlightRequestBody, computeRequestHash } from "../fdc-attest-flight";
import { fetchFlight, utcDateOnly } from "../../web/lib/server/flightRequest";
import { FALLBACK_PREMIUM_BPS, quoteRouteRisk } from "../../web/lib/server/riskPricing";

const FlightGuard = artifacts.require("FlightGuard");
// MockUSDT0's ABI is a standard ERC20 - reused here (as demo.ts/buyTestPolicy.ts already
// do for the real usdt0Address) as a typed handle onto the real deployed USDT0 and FXRP
// tokens, not an actual mock/deployment.
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/buyCoverWithFXRP.ts --network coston2
//
// One live buyCoverWithFXRP() call on Coston2: proves the real FTSO read (XRP/USD,
// USDT/USD via ContractRegistry -> FtsoV2) and the real FXRP ERC20 transfer both work
// end-to-end, not just against mocks/local tests. The premiumBps used is the live
// route-risk quote for the flight, so this also proves the risk-adjusted premium is what
// gets converted to FXRP - the risk step happens before the FTSO conversion, not beside it.

const coverAmount = web3.utils.toWei("1", "mwei"); // 1 USDT0 cover (6 decimals)
const scheduledArrivalDelaySec = 3600; // 1h out - not meant to be settled by this script
const flightIata = process.env.RISK_FLIGHT_IATA ?? "EK504";

function loadWebEnv() {
    const envPath = path.join(__dirname, "..", "..", "web", ".env.local");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
}

async function main() {
    loadWebEnv();
    const apiKey = process.env.FLIGHT_API_KEY;
    if (!apiKey) throw new Error("FLIGHT_API_KEY is not set");

    // Resolve the real flight, then price its route from live history. If the route sample
    // is unavailable this falls back to the documented flat rate, exactly like the app.
    const flight = await fetchFlight(flightIata, apiKey);
    if (!flight) throw new Error(`No flight found for ${flightIata}`);
    const flightDate = utcDateOnly(flight.depTimeUtc);
    const risk = await quoteRouteRisk({
        flightIata,
        depIata: flight.depIata,
        arrIata: flight.arrIata,
        apiKey,
    });
    const premiumBps = risk.premiumBps;
    console.log(`Flight: ${flightIata}  ${flight.depIata}->${flight.arrIata}  ${flightDate}`);
    console.log(`Route risk: ${risk.description}`);
    console.log(
        `premiumBps: ${premiumBps} (${(premiumBps / 100).toFixed(2)}%, source=${risk.source}` +
            `${premiumBps === FALLBACK_PREMIUM_BPS && risk.source === "fallback" ? ", flat fallback" : ""})\n`
    );

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    const fxrp: MockUSDT0Instance = await MockUSDT0.at(fxrpAddress);
    console.log("FlightGuard:", flightGuard.address);
    console.log("Account:    ", account, "\n");

    // 1. Ensure enough free USDT0 liquidity for coverAmount (deposit if needed).
    const freeLiquidity = BigInt((await flightGuard.freeLiquidity()).toString());
    if (freeLiquidity < BigInt(coverAmount)) {
        const depositAmount = BigInt(coverAmount); // exactly enough - wallet's USDT0 balance is limited
        await token.approve(flightGuard.address, depositAmount.toString(), { from: account });
        const depositTx = await flightGuard.deposit(depositAmount.toString(), { from: account });
        console.log("Deposit tx:", depositTx.tx);
    }

    // 2. Quote the FXRP premium via the real, deployed FTSO wiring.
    const preview = await flightGuard.previewFxrpPremium.call(coverAmount, premiumBps);
    const { premiumUsdt0Equivalent, fxrpAmount, xrpUsdPriceWei, usdtUsdPriceWei } = preview;
    console.log(`Live XRP/USD:  $${web3.utils.fromWei(xrpUsdPriceWei.toString(), "ether")}`);
    console.log(`Live USDT/USD: $${web3.utils.fromWei(usdtUsdPriceWei.toString(), "ether")}`);
    console.log(`Premium: ${web3.utils.fromWei(premiumUsdt0Equivalent.toString(), "mwei")} USDT0-equivalent`);
    console.log(`FXRP owed: ${web3.utils.fromWei(fxrpAmount.toString(), "mwei")} FXRP\n`);

    const fxrpBalance = BigInt((await fxrp.balanceOf(account)).toString());
    if (fxrpBalance < BigInt(fxrpAmount.toString())) {
        throw new Error(
            `Wallet holds ${fxrpBalance} FXRP base units, needs ${fxrpAmount.toString()} - top up from the Coston2 FAssets faucet.`
        );
    }

    // 3. Approve + buy. buyCoverWithFXRP re-reads the FTSO price when it executes, a couple
    // of blocks after this preview, so approving the exact quoted amount reverts with
    // "ERC20: insufficient allowance" whenever XRP/USD ticks down in between. Approve 2%
    // headroom - only what the contract actually charges is transferred.
    const approvalAmount = (BigInt(fxrpAmount.toString()) * 102n) / 100n;
    await fxrp.approve(flightGuard.address, approvalAmount.toString(), { from: account });
    console.log(`Approved ${approvalAmount} FXRP base units (2% headroom over the ${fxrpAmount} quote)\n`);

    const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
    const flightRef = `${flightIata}|${flightDate}`;
    // Must be computed the same way buyCover's scripts do (buildFlightRequestBody +
    // computeRequestHash from fdc-attest-flight.ts) - settle()/the keeper recompute this
    // same hash from the FDC proof's requestBody, so a placeholder value here would leave
    // the resulting policy permanently unsettleable ("requestHash matches neither current
    // nor legacy scheme").
    const requestBody = buildFlightRequestBody(flightIata, flightDate);
    const requestHash = computeRequestHash(requestBody);

    const fxrpBalanceBefore = BigInt((await fxrp.balanceOf(account)).toString());
    const contractFxrpBefore = BigInt((await fxrp.balanceOf(flightGuard.address)).toString());
    const fxrpPremiumsBefore = BigInt((await flightGuard.fxrpPremiums()).toString());

    const buyTx = await flightGuard.buyCoverWithFXRP(
        coverAmount,
        premiumBps,
        scheduledArrival,
        requestHash,
        flightRef,
        {
            from: account,
        }
    );
    const event = buyTx.logs.find((e: any) => e.event === "CoverBoughtWithFXRP");
    const policyId = event.args.policyId;

    console.log("BuyCoverWithFXRP tx:", buyTx.tx);
    console.log("policyId:   ", policyId.toString());
    console.log("premiumBps: ", event.args.premiumBps.toString());
    console.log("Event fxrpAmount:", event.args.fxrpAmount.toString());
    console.log("Event xrpUsdPriceWei:", event.args.xrpUsdPriceWei.toString());
    console.log("Event usdtUsdPriceWei:", event.args.usdtUsdPriceWei.toString(), "\n");

    const fxrpBalanceAfter = BigInt((await fxrp.balanceOf(account)).toString());
    const contractFxrpAfter = BigInt((await fxrp.balanceOf(flightGuard.address)).toString());
    const fxrpPremiumsAfter = BigInt((await flightGuard.fxrpPremiums()).toString());

    console.log("--- RESULT ---");
    console.log(
        `Traveler FXRP: ${fxrpBalanceBefore} -> ${fxrpBalanceAfter} (delta ${fxrpBalanceAfter - fxrpBalanceBefore})`
    );
    console.log(
        `Contract FXRP: ${contractFxrpBefore} -> ${contractFxrpAfter} (delta ${contractFxrpAfter - contractFxrpBefore})`
    );
    console.log(`fxrpPremiums:  ${fxrpPremiumsBefore} -> ${fxrpPremiumsAfter}`);

    const policy = await flightGuard.policies(policyId);
    console.log(`Policy premiumInFxrp: ${policy.premiumInFxrp}`);

    // Compare against the amount the contract actually charged (the event), not the earlier
    // preview - the FTSO price legitimately moves between the two reads.
    const chargedFxrp = BigInt(event.args.fxrpAmount.toString());
    if (fxrpBalanceAfter - fxrpBalanceBefore !== -chargedFxrp) {
        throw new Error("Traveler FXRP balance delta doesn't match the charged fxrpAmount");
    }
    if (fxrpPremiumsAfter - fxrpPremiumsBefore !== chargedFxrp) {
        throw new Error("fxrpPremiums didn't increase by the charged fxrpAmount");
    }
    if (!policy.premiumInFxrp) {
        throw new Error("Policy.premiumInFxrp is false - expected true");
    }
    console.log("\nOK: live buyCoverWithFXRP - real FTSO read + real FXRP transfer confirmed onchain.");
}

void main().then(() => {
    process.exit(0);
});
