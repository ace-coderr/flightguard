import fs from "fs";
import path from "path";
import { flightGuardAddress, usdt0Address } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { buildFlightRequestBody, computeRequestHash } from "../fdc-attest-flight";
import { fetchFlight, scheduledArrivalFromFlight, utcDateOnly } from "../../web/lib/server/flightRequest";
import { quoteRouteRisk } from "../../web/lib/server/riskPricing";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/buyRiskPricedPolicy.ts --network coston2
//
// End-to-end proof of the risk-based premium path: resolves a real upcoming flight, prices
// its route from live airlabs history (the same code path /api/flight-request uses), then
// buys cover onchain with that risk-adjusted premiumBps and asserts the stored policy
// matches the quote. Needs scripts/flightguard/config.ts (written by deploy.ts).

// EDIT ME: any real flight number that hasn't departed yet.
const flightIata = process.env.RISK_FLIGHT_IATA ?? "EK504";

const depositAmount = web3.utils.toWei("5", "mwei"); // 5 USDT0 backing deposit (6 decimals)
const coverAmount = web3.utils.toWei("1", "mwei"); // 1 USDT0 cover

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

    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    console.log("FlightGuard:", flightGuard.address);
    console.log("Account:    ", account, "\n");

    // 1. Resolve the real flight (same lookup the quote API performs).
    const flight = await fetchFlight(flightIata, apiKey);
    if (!flight) throw new Error(`No flight found for ${flightIata}`);
    const scheduledArrival = scheduledArrivalFromFlight(flight);
    if (scheduledArrival === null) throw new Error(`${flightIata} has no scheduled arrival yet`);
    if (scheduledArrival <= Math.floor(Date.now() / 1000)) {
        throw new Error(`${flightIata} has already arrived - pick a flight that hasn't landed`);
    }
    const date = utcDateOnly(flight.depTimeUtc);
    console.log(`Flight:  ${flightIata}  ${flight.depIata}->${flight.arrIata}  ${date}  (status: ${flight.status})`);

    // 2. Price the route from live history.
    const risk = await quoteRouteRisk({
        flightIata,
        depIata: flight.depIata,
        arrIata: flight.arrIata,
        apiKey,
    });
    console.log(`Risk:    ${risk.description}`);
    console.log(
        `Premium: ${(risk.premiumBps / 100).toFixed(2)}% (${risk.premiumBps} bps, source=${risk.source})` +
            `  observed delay rate: ${risk.delayRate === null ? "n/a" : (risk.delayRate * 100).toFixed(0) + "%"}\n`
    );

    // 3. Make sure the pool can cover it.
    const premium = (BigInt(coverAmount) * BigInt(risk.premiumBps)) / 10_000n;
    const freeLiquidity = BigInt((await flightGuard.freeLiquidity()).toString());
    if (freeLiquidity < BigInt(coverAmount)) {
        await token.approve(flightGuard.address, (BigInt(depositAmount) + premium).toString(), { from: account });
        const depositTx = await flightGuard.deposit(depositAmount, { from: account });
        console.log("Deposit tx:", depositTx.tx);
    } else {
        await token.approve(flightGuard.address, premium.toString(), { from: account });
    }

    // 4. Buy at the risk-adjusted rate.
    const requestHash = computeRequestHash(buildFlightRequestBody(flightIata, date));
    const flightRef = `${flightIata}|${date}`;
    const buyTx = await flightGuard.buyCover(coverAmount, risk.premiumBps, scheduledArrival, requestHash, flightRef, {
        from: account,
    });
    const policyId = buyTx.logs.find((e: any) => e.event === "CoverBought")!.args.policyId;
    console.log("BuyCover tx:", buyTx.tx);
    console.log("policyId:   ", policyId.toString());

    // 5. Assert the chain stored exactly what we quoted.
    const policy = await flightGuard.policies(policyId);
    const storedBps = Number(policy.premiumBps.toString());
    const storedPremium = BigInt(policy.premium.toString());
    console.log(
        `\nOnchain policy: premiumBps=${storedBps}  premium=${storedPremium} (6dp)  flightRef=${policy.flightRef}`
    );
    if (storedBps !== risk.premiumBps)
        throw new Error(`premiumBps mismatch: quoted ${risk.premiumBps}, stored ${storedBps}`);
    if (storedPremium !== premium) throw new Error(`premium mismatch: expected ${premium}, stored ${storedPremium}`);

    // 6. Show the FXRP conversion of that same risk-adjusted premium.
    const fxrp = await flightGuard.previewFxrpPremium.call(coverAmount, risk.premiumBps);
    console.log(
        `previewFxrpPremium(${coverAmount}, ${risk.premiumBps}) -> premiumUsdt0=${fxrp[0].toString()} ` +
            `fxrpAmount=${fxrp[1].toString()} (6dp)`
    );
    if (BigInt(fxrp[0].toString()) !== premium) throw new Error("FXRP path priced a different USDT0 premium");

    console.log(
        "\nOK - risk-adjusted premium quoted offchain, accepted onchain, and consistent across both pay paths."
    );
}

void main().then(() => {
    process.exit(0);
});
