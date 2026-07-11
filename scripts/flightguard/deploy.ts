import hre, { run } from "hardhat";
import fs from "fs";
import { FlightGuardInstance } from "../../typechain-types";
import { getFdcVerification, getFtsoV2 } from "../utils/getters";
import { getFXRPTokenAddress } from "../utils/fassets";

const FlightGuard = artifacts.require("FlightGuard");

// yarn hardhat run scripts/flightguard/deploy.ts --network coston2

// Real Coston2 faucet USDT0 ("USDT0 test" / USD₮0, 6 decimals). Confirmed on-chain: the
// deployer wallet's faucet mint (faucet.flare.network) landed here - see
// https://coston2-explorer.flare.network/address/0xC1A5B41512496B80903D1f32d6dEa3a73212E71F
const tokenAddress = "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F";

async function deployAndVerify() {
    // ContractRegistry.getFdcVerification()/getFtsoV2() equivalents, resolved off-chain (see
    // MinTempAgency for the on-chain version of this same lookup). fxrpAddress comes from
    // AssetManagerFXRP.fAsset() (see scripts/fassets/getFXRP.ts) - confirmed live rather than
    // hardcoded, since it's not published as a fixed constant anywhere.
    const [fdcVerification, ftsoV2, fxrpAddress] = await Promise.all([
        getFdcVerification(),
        getFtsoV2(),
        getFXRPTokenAddress(),
    ]);
    console.log("FdcVerification (ContractRegistry):", fdcVerification.address);
    console.log("FtsoV2 (ContractRegistry):         ", ftsoV2.address);
    console.log("FXRP (AssetManagerFXRP.fAsset()):  ", fxrpAddress, "\n");

    const args: any[] = [tokenAddress, fdcVerification.address, ftsoV2.address, fxrpAddress];
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
        `export const flightGuardAddress = "${flightGuard.address}";\n` +
            `export const usdt0Address = "${tokenAddress}";\n` +
            `export const fxrpAddress = "${fxrpAddress}";\n`
    );
}

void deployAndVerify().then(() => {
    process.exit(0);
});
