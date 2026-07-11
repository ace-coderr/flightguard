import { flightGuardAddress, usdt0Address } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";

const FlightGuard = artifacts.require("FlightGuard");
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/poolLifecycle.ts --network coston2
//
// Verification run: deposit, withdraw within free liquidity, then confirm an over-withdraw
// against locked liquidity correctly reverts.

const depositAmount = web3.utils.toWei("0.5", "mwei"); // 0.5 USDT0
const withdrawTargetAmount = web3.utils.toWei("0.3", "mwei"); // ~0.3 USDT0 worth of shares, well within free liquidity

async function logState(flightGuard: FlightGuardInstance, account: string, label: string) {
    const poolBalance = BigInt((await flightGuard.poolBalance()).toString());
    const totalLocked = BigInt((await flightGuard.totalLocked()).toString());
    const freeLiquidity = BigInt((await flightGuard.freeLiquidity()).toString());
    const totalShares = BigInt((await flightGuard.totalShares()).toString());
    const myShares = BigInt((await flightGuard.shares(account)).toString());
    console.log(`--- State (${label}) ---`);
    console.log(`poolBalance:   ${web3.utils.fromWei(poolBalance.toString(), "mwei")} USDT0`);
    console.log(`totalLocked:   ${web3.utils.fromWei(totalLocked.toString(), "mwei")} USDT0`);
    console.log(`freeLiquidity: ${web3.utils.fromWei(freeLiquidity.toString(), "mwei")} USDT0`);
    console.log(`totalShares:   ${totalShares.toString()}`);
    console.log(`myShares:      ${myShares.toString()}\n`);
    return { poolBalance, totalLocked, freeLiquidity, totalShares, myShares };
}

async function main() {
    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const token: MockUSDT0Instance = await MockUSDT0.at(usdt0Address);
    console.log("FlightGuard:", flightGuard.address);
    console.log("Account:    ", account, "\n");

    const before = await logState(flightGuard, account, "before");

    // 1. Deposit
    let depositPassed = false;
    let depositTxHash = "";
    let sharesMinted = 0n;
    try {
        await token.approve(flightGuard.address, depositAmount, { from: account });
        const depositTx = await flightGuard.deposit(depositAmount, { from: account });
        depositTxHash = depositTx.tx;
        const depositedEvent = depositTx.logs.find((e: any) => e.event === "Deposited");
        sharesMinted = BigInt(depositedEvent.args.sharesMinted.toString());
        console.log("Deposit tx:", depositTxHash, "shares minted:", sharesMinted.toString(), "\n");
        depositPassed = true;
    } catch (e: any) {
        console.log("DEPOSIT FAILED:", e.message, "\n");
    }

    const afterDeposit = await logState(flightGuard, account, "after deposit");

    // 2. Withdraw within free liquidity
    let withdrawPassed = false;
    let withdrawTxHash = "";
    const withdrawShareAmount =
        (BigInt(withdrawTargetAmount) * afterDeposit.totalShares) / afterDeposit.poolBalance;
    try {
        const balBefore = BigInt((await token.balanceOf(account)).toString());
        const withdrawTx = await flightGuard.withdraw(withdrawShareAmount.toString(), { from: account });
        withdrawTxHash = withdrawTx.tx;
        const balAfter = BigInt((await token.balanceOf(account)).toString());
        console.log("Withdraw tx:", withdrawTxHash);
        console.log(
            "USDT0 received:",
            web3.utils.fromWei((balAfter - balBefore).toString(), "mwei"),
            "USDT0\n"
        );
        withdrawPassed = true;
    } catch (e: any) {
        console.log("WITHDRAW (free liquidity) FAILED:", e.message, "\n");
    }

    const afterWithdraw = await logState(flightGuard, account, "after withdraw");

    // 3. Over-withdraw: try to withdraw ALL remaining shares, which exceeds free liquidity
    //    since totalLocked (from the still-active policy) keeps some of the pool locked.
    let overWithdrawCorrectlyBlocked = false;
    try {
        await flightGuard.withdraw(afterWithdraw.myShares.toString(), { from: account });
        console.log("OVER-WITHDRAW DID NOT REVERT (BUG: locked liquidity was not enforced)\n");
    } catch (e: any) {
        const reverted = /liquidity locked/i.test(e.message);
        console.log(`Over-withdraw reverted as expected: ${reverted ? "yes (\"liquidity locked\")" : "yes (unexpected reason)"}`);
        console.log("Revert message:", e.message, "\n");
        overWithdrawCorrectlyBlocked = reverted;
    }

    const final = await logState(flightGuard, account, "final");

    console.log("=== SUMMARY ===");
    console.log("Deposit:                    ", depositPassed ? "PASS" : "FAIL", depositTxHash);
    console.log("Withdraw (free liquidity):  ", withdrawPassed ? "PASS" : "FAIL", withdrawTxHash);
    console.log("Over-withdraw correctly blocked (locked liquidity):", overWithdrawCorrectlyBlocked ? "PASS" : "FAIL");
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
