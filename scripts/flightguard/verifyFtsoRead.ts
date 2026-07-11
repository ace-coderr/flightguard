import { ethers } from "hardhat";
import { flightGuardAddress } from "./config";

// yarn hardhat run scripts/flightguard/verifyFtsoRead.ts --network coston2
//
// Real-FTSO read check: calls the DEPLOYED FlightGuard's previewFxrpPremium() against the
// real, live Coston2 ContractRegistry -> FtsoV2 (not MockFtsoV2 - see
// test/FlightGuard.test.ts for the mock-FTSO conversion-math suite). Asserts the returned
// prices are real, sane market data, not just that the arithmetic is internally
// consistent. Run after scripts/flightguard/deploy.ts.

const FlightGuard = artifacts.require("FlightGuard");

async function main() {
    const flightGuard = await FlightGuard.at(flightGuardAddress);

    const coverAmount = ethers.parseUnits("40", 6);
    const result = await flightGuard.previewFxrpPremium.call(coverAmount);
    const { premiumUsdt0Equivalent, fxrpAmount, xrpUsdPriceWei, usdtUsdPriceWei } = result;

    console.log("FlightGuard:", flightGuard.address);
    console.log(`Cover amount:  ${ethers.formatUnits(coverAmount.toString(), 6)} USDT0`);
    console.log(`Premium (10%): ${ethers.formatUnits(premiumUsdt0Equivalent.toString(), 6)} USDT0`);
    console.log(`Live XRP/USD:  $${ethers.formatUnits(xrpUsdPriceWei.toString(), 18)}`);
    console.log(`Live USDT/USD: $${ethers.formatUnits(usdtUsdPriceWei.toString(), 18)}`);
    console.log(`=> FXRP owed:  ${ethers.formatUnits(fxrpAmount.toString(), 6)} FXRP\n`);

    if (fxrpAmount <= 0n) throw new Error("fxrpAmount <= 0 - FTSO read failed");
    // Sanity bands, not exact-value assertions - real market prices move, but XRP/USDT
    // trading outside these ranges would mean we read the wrong feed entirely.
    const xrpPrice = Number(ethers.formatUnits(xrpUsdPriceWei.toString(), 18));
    const usdtPrice = Number(ethers.formatUnits(usdtUsdPriceWei.toString(), 18));
    if (xrpPrice < 0.1 || xrpPrice > 20) throw new Error(`XRP/USD price $${xrpPrice} outside sane band`);
    if (usdtPrice < 0.9 || usdtPrice > 1.1) throw new Error(`USDT/USD price $${usdtPrice} outside sane band`);

    console.log("OK: real FTSO read via ContractRegistry -> FtsoV2 returns sane, live prices.");
}

void main().then(() => {
    process.exit(0);
});
