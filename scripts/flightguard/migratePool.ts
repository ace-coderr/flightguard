import { flightGuardAddress, usdt0Address } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// FROM=0x... npx hardhat run scripts/flightguard/migratePool.ts --network coston2
//
// Moves a backer's FREE liquidity out of a superseded deployment and into the current one
// (scripts/flightguard/config.ts). Only free liquidity is withdrawable by construction -
// cover locked against still-active policies on the old contract stays there, so those
// policies remain settleable at their original address.
//
// KEEP_BACK leaves some USDT0 in the wallet for premiums; default 1 USDT0.

const from = process.env.FROM;
const keepBack = BigInt(web3.utils.toWei(process.env.KEEP_BACK ?? "1", "mwei"));

async function main() {
    if (!from) throw new Error("FROM (the superseded FlightGuard address) is required");
    if (from.toLowerCase() === flightGuardAddress.toLowerCase()) throw new Error("FROM is the current deployment");

    const [account] = await web3.eth.getAccounts();
    const oldGuard: FlightGuardInstance = await FlightGuard.at(from);
    const newGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);

    const shares = BigInt((await oldGuard.shares(account)).toString());
    const totalShares = BigInt((await oldGuard.totalShares()).toString());
    const poolBalance = BigInt((await oldGuard.poolBalance()).toString());
    const free = BigInt((await oldGuard.freeLiquidity()).toString());
    console.log(`from ${from}`);
    console.log(`  shares=${shares} totalShares=${totalShares} poolBalance=${poolBalance} freeLiquidity=${free}`);

    if (shares > 0n && free > 0n && poolBalance > 0n) {
        // Largest share count whose USDT0 value still fits inside free liquidity; stepped
        // down rather than computed exactly because the division truncates.
        let withdrawShares = (free * totalShares) / poolBalance;
        while (withdrawShares > 0n && (withdrawShares * poolBalance) / totalShares > free) withdrawShares -= 1n;
        if (withdrawShares > shares) withdrawShares = shares;

        if (withdrawShares > 0n) {
            const tx = await oldGuard.withdraw(withdrawShares.toString(), { from: account });
            console.log(`  withdraw tx: ${tx.tx} (${withdrawShares} shares)`);
        }
    } else {
        console.log("  nothing free to withdraw");
    }

    const balance = BigInt((await token.balanceOf(account)).toString());
    const depositAmount = balance > keepBack ? balance - keepBack : 0n;
    console.log(`\nwallet USDT0: ${balance}, depositing ${depositAmount} (keeping back ${keepBack})`);

    if (depositAmount > 0n) {
        await token.approve(newGuard.address, depositAmount.toString(), { from: account });
        const tx = await newGuard.deposit(depositAmount.toString(), { from: account });
        console.log(`  deposit tx: ${tx.tx}`);
    }

    console.log(`\nto ${flightGuardAddress}`);
    console.log(`  poolBalance:   ${(await newGuard.poolBalance()).toString()}`);
    console.log(`  freeLiquidity: ${(await newGuard.freeLiquidity()).toString()}`);
}

void main().then(() => process.exit(0));
