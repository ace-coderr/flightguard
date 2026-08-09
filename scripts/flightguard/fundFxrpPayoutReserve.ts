import { flightGuardAddress, fxrpAddress } from "./config";
import { FlightGuardInstance, MockUSDT0Instance } from "../../typechain-types";

const FlightGuard = artifacts.require("FlightGuard");
// Standard-ERC20 ABI handle onto the real deployed FXRP token (same reuse as demo.ts and
// buyCoverWithFXRP.ts) - not a mock deployment.
const MockUSDT0 = artifacts.require("MockUSDT0");

// yarn hardhat run scripts/flightguard/fundFxrpPayoutReserve.ts --network coston2
//
// Tops up the FXRP the contract can pay FXRP-denominated claims out of. This reserve is the
// counterparty to the internal, FTSO-priced USDT0->FXRP swap settle() performs for a policy
// bought with payoutInFxrp: it hands the holder FXRP and books the cover's USDT0 to
// usdt0SwapProceeds, which the owner reclaims with withdrawSwapProceeds. Backer funds are
// never involved - poolBalance() excludes those proceeds.
//
// Amount in whole FXRP; override with RESERVE_FXRP.
const reserveFxrp = process.env.RESERVE_FXRP ?? "5";

async function main() {
    const [account] = await web3.eth.getAccounts();
    const flightGuard: FlightGuardInstance = await FlightGuard.at(flightGuardAddress);
    const fxrp: MockUSDT0Instance = await MockUSDT0.at(fxrpAddress);

    const owner = await flightGuard.owner();
    if (owner.toLowerCase() !== account.toLowerCase()) {
        throw new Error(`Account ${account} is not the contract owner (${owner})`);
    }

    const amount = web3.utils.toWei(reserveFxrp, "mwei"); // FXRP has 6 decimals
    const balance = BigInt((await fxrp.balanceOf(account)).toString());
    if (balance < BigInt(amount)) {
        throw new Error(`Wallet holds ${balance} FXRP base units, needs ${amount}`);
    }

    const before = BigInt((await flightGuard.fxrpPayoutReserve()).toString());
    await fxrp.approve(flightGuard.address, amount, { from: account });
    const tx = await flightGuard.fundFxrpPayoutReserve(amount, { from: account });
    const after = BigInt((await flightGuard.fxrpPayoutReserve()).toString());

    console.log("FlightGuard:", flightGuard.address);
    console.log("Fund tx:    ", tx.tx);
    console.log(`fxrpPayoutReserve: ${before} -> ${after} base units (+${reserveFxrp} FXRP)`);

    if (after - before !== BigInt(amount)) {
        throw new Error("fxrpPayoutReserve did not increase by the funded amount");
    }
}

void main().then(() => process.exit(0));
