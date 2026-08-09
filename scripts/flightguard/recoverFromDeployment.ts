import { flightGuardAddress, usdt0Address, fxrpAddress } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// FROM=0x... npx hardhat run scripts/flightguard/recoverFromDeployment.ts --network coston2
//
// Sweeps everything recoverable out of a superseded FlightGuard: expires policies whose
// claim window has closed (unlocking their cover), withdraws the backer's free liquidity,
// and pulls back the owner-side FXRP balances and USDT0 swap proceeds.
//
// Superseded deployments predate some of these functions, so every step is attempted
// independently and a missing one is reported rather than aborting the sweep. Nothing here
// can touch another backer's funds: withdraw burns only this account's shares, and the
// owner-side balances are tracked separately from the pool by construction.
//
// DEPOSIT=false skips redepositing the recovered USDT0 into the current deployment.

const STATUS = ["Active", "PaidOut", "Expired", "NoPayout"];

async function tryStep<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
        const out = await fn();
        return out;
    } catch (e: any) {
        const msg = (e.reason || e.message || String(e)).split("\n")[0].slice(0, 140);
        console.log(`  skip  ${label}: ${msg}`);
        return null;
    }
}

async function main() {
    const from = process.env.FROM;
    if (!from) throw new Error("FROM (the superseded FlightGuard address) is required");
    if (from.toLowerCase() === flightGuardAddress.toLowerCase()) throw new Error("FROM is the current deployment");

    const [account] = await web3.eth.getAccounts();
    const old: FlightGuardInstance = await FlightGuard.at(from);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    const fxrp: MockUSDT0Instance = await MockUSDT0.at(fxrpAddress);

    const usdt0Start = BigInt((await token.balanceOf(account)).toString());
    const fxrpStart = BigInt((await fxrp.balanceOf(account)).toString());
    console.log(`recovering from ${from}`);
    console.log(
        `  contract holds: ${(await token.balanceOf(from)).toString()} USDT0, ${(await fxrp.balanceOf(from)).toString()} FXRP\n`
    );

    // 1. Expire anything past its claim window so its cover stops being locked.
    const count = Number(await old.policyCount());
    const claimWindow = Number(await old.CLAIM_WINDOW());
    const now = Math.floor(Date.now() / 1000);
    console.log(`policies (${count}):`);
    for (let i = 0; i < count; i++) {
        const p = await old.policies(i);
        const status = Number(p.status);
        const arrival = Number(p.scheduledArrival);
        if (status !== 0) {
            console.log(`  policy ${i}: ${STATUS[status]} - nothing to do`);
            continue;
        }
        if (now <= arrival + claimWindow) {
            console.log(
                `  policy ${i}: Active, claim window still open for ${arrival + claimWindow - now}s - LEAVING LOCKED`
            );
            continue;
        }
        const tx = await tryStep(`expire(${i})`, () => old.expire(i, { from: account }));
        if (tx) console.log(`  policy ${i}: expired, cover unlocked (${(tx as any).tx})`);
    }

    // 2. Withdraw this account's free liquidity.
    console.log("\npool:");
    const shares = BigInt((await old.shares(account)).toString());
    const totalShares = BigInt((await old.totalShares()).toString());
    const poolBalance = BigInt((await old.poolBalance()).toString());
    const free = BigInt((await old.freeLiquidity()).toString());
    console.log(`  shares=${shares} totalShares=${totalShares} poolBalance=${poolBalance} free=${free}`);

    if (shares > 0n && totalShares > 0n && poolBalance > 0n && free > 0n) {
        let withdrawShares = shares;
        // Step down to whatever still fits inside free liquidity (integer division truncates).
        while (withdrawShares > 0n && (withdrawShares * poolBalance) / totalShares > free) withdrawShares -= 1n;
        if (withdrawShares > 0n) {
            const tx = await tryStep("withdraw", () => old.withdraw(withdrawShares.toString(), { from: account }));
            if (tx) console.log(`  withdrew ${withdrawShares} shares (${(tx as any).tx})`);
        } else {
            console.log("  no shares withdrawable within free liquidity");
        }
    } else {
        console.log("  nothing to withdraw");
    }

    // 3. Owner-side balances. Each is tracked separately from the pool, so these never draw
    //    on backer funds - and each may not exist on an older deployment.
    console.log("\nowner-side balances:");
    const premiums = await tryStep("read fxrpPremiums", async () => BigInt((await old.fxrpPremiums()).toString()));
    if (premiums && premiums > 0n) {
        const tx = await tryStep("withdrawFxrpPremiums", () =>
            old.withdrawFxrpPremiums(account, premiums.toString(), { from: account })
        );
        if (tx) console.log(`  withdrew ${premiums} FXRP premiums`);
    } else if (premiums === 0n) {
        console.log("  fxrpPremiums: 0");
    }

    const reserve = await tryStep("read fxrpPayoutReserve", async () =>
        BigInt((await old.fxrpPayoutReserve()).toString())
    );
    if (reserve && reserve > 0n) {
        const tx = await tryStep("withdrawFxrpPayoutReserve", () =>
            old.withdrawFxrpPayoutReserve(account, reserve.toString(), { from: account })
        );
        if (tx) console.log(`  withdrew ${reserve} FXRP payout reserve`);
    } else if (reserve === 0n) {
        console.log("  fxrpPayoutReserve: 0");
    }

    const proceeds = await tryStep("read usdt0SwapProceeds", async () =>
        BigInt((await old.usdt0SwapProceeds()).toString())
    );
    if (proceeds && proceeds > 0n) {
        const tx = await tryStep("withdrawSwapProceeds", () =>
            old.withdrawSwapProceeds(account, proceeds.toString(), { from: account })
        );
        if (tx) console.log(`  withdrew ${proceeds} USDT0 swap proceeds`);
    } else if (proceeds === 0n) {
        console.log("  usdt0SwapProceeds: 0");
    }

    const usdt0End = BigInt((await token.balanceOf(account)).toString());
    const fxrpEnd = BigInt((await fxrp.balanceOf(account)).toString());
    const usdt0Gained = usdt0End - usdt0Start;
    console.log(`\nrecovered: ${usdt0Gained} USDT0, ${fxrpEnd - fxrpStart} FXRP`);
    console.log(
        `still stranded in ${from}: ${(await token.balanceOf(from)).toString()} USDT0, ${(await fxrp.balanceOf(from)).toString()} FXRP`
    );

    // 4. Put the recovered USDT0 back to work in the current deployment.
    if (process.env.DEPOSIT !== "false" && usdt0Gained > 0n) {
        const current: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
        await token.approve(current.address, usdt0Gained.toString(), { from: account });
        const tx = await current.deposit(usdt0Gained.toString(), { from: account });
        console.log(`\ndeposited ${usdt0Gained} USDT0 into ${flightGuardAddress} (${tx.tx})`);
        console.log(`  poolBalance:   ${(await current.poolBalance()).toString()}`);
        console.log(`  freeLiquidity: ${(await current.freeLiquidity()).toString()}`);
    }
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
