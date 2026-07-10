import hre, { run } from "hardhat";
import fs from "fs";
import { FlightGuardInstance } from "../../typechain-types";
import { getFdcVerification } from "../utils/getters";

const FlightGuard = artifacts.require("FlightGuard");

// yarn hardhat run scripts/flightguard/deploy.ts --network coston2

// Real Coston2 faucet USDT0 ("USDT0 test" / USD₮0, 6 decimals). Confirmed on-chain: the
// deployer wallet's faucet mint (faucet.flare.network) landed here - see
// https://coston2-explorer.flare.network/address/0xC1A5B41512496B80903D1f32d6dEa3a73212E71F
const tokenAddress = "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F";

async function deployAndVerify() {
    // ContractRegistry.getFdcVerification() equivalent, resolved off-chain (see MinTempAgency
    // for the on-chain version of this same lookup).
    const fdcVerification = await getFdcVerification();
    console.log("FdcVerification (ContractRegistry):", fdcVerification.address, "\n");

    const args: any[] = [tokenAddress, fdcVerification.address];
    const flightGuard: FlightGuardInstance = await FlightGuard.new(...args);
    try {
        await run("verify:verify", {
            address: flightGuard.address,
            constructorArguments: args,
        });
    } catch (e: any) {
        console.log(e);
    }
    console.log(`(${hre.network.name}) FlightGuard deployed to`, flightGuard.address, "\n");

    fs.writeFileSync(
        `scripts/flightguard/config.ts`,
        `export const flightGuardAddress = "${flightGuard.address}";\nexport const usdt0Address = "${tokenAddress}";\n`
    );
}

void deployAndVerify().then(() => {
    process.exit(0);
});
