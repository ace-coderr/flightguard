import { flightGuardAddress, usdt0Address } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";
import { buildFlightRequestBody, computeRequestHash } from "../fdc-attest-flight";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/buyTestPolicy.ts --network coston2
//
// Buys cover with a scheduledArrival a few minutes out, for exercising the keeper
// (GET /api/keeper) end-to-end without waiting for demo.ts's full attest+settle flow.
// Needs scripts/flightguard/config.ts (written by deploy.ts).

const { FLIGHT_API_KEY } = process.env;

// EDIT ME: flight to attest. IATA flight number + YYYY-MM-DD date (must be today on free plan).
const flightIata = "BA75";
const flightDate = "2026-07-11";

const depositAmount = web3.utils.toWei("2", "mwei"); // 2 USDT0 backer deposit (6 decimals)
const coverAmount = web3.utils.toWei("0.5", "mwei"); // 0.5 USDT0 cover bought against that pool
const scheduledArrivalDelaySec = 90; // flight "lands" 90s from now, so it's past-due almost immediately

async function main() {
  if (!FLIGHT_API_KEY) {
    throw new Error("FLIGHT_API_KEY not set in .env");
  }

  const [account] = await web3.eth.getAccounts();
  const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
  const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
  console.log("FlightGuard:", flightGuard.address);
  console.log("Account:    ", account, "\n");

  const premiumBps = await flightGuard.PREMIUM_BPS();
  const premium = (BigInt(coverAmount) * BigInt(premiumBps.toString())) / 10_000n;
  const freeLiquidity = BigInt((await flightGuard.freeLiquidity()).toString());

  // Only deposit if the pool doesn't already have enough free liquidity (idempotent
  // across repeated runs of this script against the same deployment).
  if (freeLiquidity < BigInt(coverAmount)) {
    const totalApproval = BigInt(depositAmount) + premium;
    await token.approve(flightGuard.address, totalApproval.toString(), { from: account });
    const depositTx = await flightGuard.deposit(depositAmount, { from: account });
    console.log("Deposit tx:", depositTx.tx);
  } else {
    await token.approve(flightGuard.address, premium.toString(), { from: account });
  }

  const requestBody = buildFlightRequestBody(flightIata, flightDate, FLIGHT_API_KEY);
  const requestHash = computeRequestHash(requestBody);
  const flightRef = `${flightIata}|${flightDate}`;

  const scheduledArrival = Math.floor(Date.now() / 1000) + scheduledArrivalDelaySec;
  const buyTx = await flightGuard.buyCover(coverAmount, scheduledArrival, requestHash, flightRef, { from: account });
  const coverBoughtEvent = buyTx.logs.find((e: any) => e.event === "CoverBought");
  const policyId = coverBoughtEvent.args.policyId;

  console.log("\nBuyCover tx:", buyTx.tx);
  console.log("policyId:   ", policyId.toString());
  console.log("flightRef:  ", flightRef);
  console.log("scheduledArrival:", scheduledArrival, `(${new Date(scheduledArrival * 1000).toISOString()})`);
  console.log(`\nPast-due in ~${scheduledArrivalDelaySec}s. Then hit GET /api/keeper.`);
}

void main().then(() => {
  process.exit(0);
});
