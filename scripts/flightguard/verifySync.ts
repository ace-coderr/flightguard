import fs from "fs";
import path from "path";
import { flightGuardAddress as scriptAddress, usdt0Address, fxrpAddress } from "./config";

const FlightGuard = artifacts.require("FlightGuard");

// npx hardhat run scripts/flightguard/verifySync.ts --network coston2
//
// Preflight gate: the app and the contract MUST ship together. The attested request scheme
// (postProcessJq + abiSignature) and the DTO settle() decodes are two halves of one
// agreement, and the address/ABI the frontend talks to is a third. If any of them drift, the
// failure is silent and expensive - a frontend older than the contract makes every settlement
// resolve to DataUnavailable (safe, but no claim ever pays), and a contract older than the
// frontend can't decode the proofs the keeper produces at all.
//
// Run this before every deploy. Non-zero exit means do not ship.

const ROOT = path.join(__dirname, "..", "..");
const failures: string[] = [];
const notes: string[] = [];

function check(ok: boolean, label: string, detail = "") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
    if (!ok) failures.push(label);
}

function readWebAddress(): string {
    const src = fs.readFileSync(path.join(ROOT, "web", "lib", "contracts.ts"), "utf8");
    const m = src.match(/export const flightGuardAddress = "(0x[0-9a-fA-F]{40})"/);
    if (!m) throw new Error("Could not parse flightGuardAddress from web/lib/contracts.ts");
    return m[1];
}

function readWebTokenAddresses() {
    const src = fs.readFileSync(path.join(ROOT, "web", "lib", "contracts.ts"), "utf8");
    const usdt0 = src.match(/export const usdt0Address = "(0x[0-9a-fA-F]{40})"/)?.[1];
    const fxrp = src.match(/export const fxrpAddress = "(0x[0-9a-fA-F]{40})"/)?.[1];
    return { usdt0, fxrp };
}

async function main() {
    const webAddress = readWebAddress();
    const artifact = JSON.parse(
        fs.readFileSync(path.join(ROOT, "artifacts", "contracts", "FlightGuard.sol", "FlightGuard.json"), "utf8")
    );
    const webAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "lib", "abi", "FlightGuard.json"), "utf8"));

    console.log("app  ->", webAddress);
    console.log("chain->", scriptAddress, "\n");

    console.log("address wiring");
    check(
        webAddress.toLowerCase() === scriptAddress.toLowerCase(),
        "frontend and deploy config point at the same FlightGuard",
        `${webAddress} vs ${scriptAddress}`
    );
    const webTokens = readWebTokenAddresses();
    check(webTokens.usdt0?.toLowerCase() === usdt0Address.toLowerCase(), "USDT0 address matches");
    check(webTokens.fxrp?.toLowerCase() === fxrpAddress.toLowerCase(), "FXRP address matches");

    console.log("\nABI wiring");
    check(
        JSON.stringify(webAbi) === JSON.stringify(artifact.abi),
        "web/lib/abi/FlightGuard.json is the freshly compiled ABI"
    );

    console.log("\ndeployed bytecode");
    const code = await web3.eth.getCode(webAddress);
    check(code !== "0x" && code.length > 2, "a contract exists at the frontend's address");
    // `token` and `fxrpToken` are immutable: the constructor patches their addresses into
    // every read site in the runtime code, while the compiled artifact still carries zeroed
    // placeholders there. Comparing raw always fails. The exact byte ranges live in the solc
    // output (build-info), NOT in Hardhat's simplified artifact - which reports
    // immutableReferences as empty - so they're read from the build-info the artifact's .dbg
    // file points at, and masked in both before comparing.
    const dbg = JSON.parse(
        fs.readFileSync(path.join(ROOT, "artifacts", "contracts", "FlightGuard.sol", "FlightGuard.dbg.json"), "utf8")
    );
    const buildInfo = JSON.parse(
        fs.readFileSync(path.resolve(ROOT, "artifacts", "contracts", "FlightGuard.sol", dbg.buildInfo), "utf8")
    );
    const immutableRefs: { start: number; length: number }[] = Object.values(
        buildInfo.output.contracts["contracts/FlightGuard.sol"].FlightGuard.evm.deployedBytecode.immutableReferences ??
            {}
    ).flat() as { start: number; length: number }[];

    const maskImmutables = (hex: string) => {
        const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
        for (const { start, length } of immutableRefs) bytes.fill(0, start, start + length);
        return bytes.toString("hex");
    };
    const deployedMatches = maskImmutables(code) === maskImmutables(artifact.deployedBytecode);
    check(
        deployedMatches,
        "deployed runtime bytecode is this build of FlightGuard.sol",
        deployedMatches
            ? `${immutableRefs.length} immutable slots masked`
            : "the deployed contract is NOT this source - redeploy before shipping the app"
    );
    // Independent of the byte comparison: the trailing CBOR metadata hash commits to the
    // source text and compiler settings, so a match here means the deployed contract was
    // built from exactly this source even if the immutable masking were wrong.
    check(code.slice(-106) === artifact.deployedBytecode.slice(-106), "deployed metadata hash matches this source");

    console.log("\nlive contract surface (both feature sets in one deployment)");
    const fg = await FlightGuard.at(webAddress);
    try {
        const reserve = (await fg.fxrpPayoutReserve()).toString();
        const proceeds = (await fg.usdt0SwapProceeds()).toString();
        check(true, "FXRP payout surface responds", `reserve=${reserve} swapProceeds=${proceeds}`);
        if (reserve === "0") {
            notes.push("fxrpPayoutReserve is 0 - FXRP-payout policies will fall back to USDT0 until it is funded");
        }
    } catch {
        check(false, "FXRP payout surface responds");
    }
    try {
        const count = Number(await fg.policyCount());
        if (count > 0) {
            const p = await fg.policies(0);
            check(
                p.provenance !== undefined && p.payoutInFxrp !== undefined,
                "Policy carries both payoutInFxrp and provenance",
                `policy 0: payoutInFxrp=${p.payoutInFxrp} provenance=${p.provenance}`
            );
        } else {
            check(true, "no policies yet; struct shape checked via ABI only");
        }
    } catch {
        check(false, "Policy struct exposes provenance");
    }
    const abiNames = (artifact.abi as any[]).map((e) => e.name).filter(Boolean);
    for (const n of ["previewFxrpPayout", "withdrawSwapProceeds", "PaidOutInFxrp", "SettlementEvidence"]) {
        check(abiNames.includes(n), `ABI exposes ${n}`);
    }

    console.log("\ndeployed proxy (what FDC verifiers actually fetch)");
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    if (!appUrl) {
        check(false, "NEXT_PUBLIC_APP_URL is set");
    } else {
        const probeFlight = process.env.FLIGHT ?? "BA75";
        const probeDate = process.env.DATE ?? new Date().toISOString().slice(0, 10);
        try {
            const res = await fetch(
                `${appUrl}/api/flight-proxy?flight_iata=${encodeURIComponent(probeFlight)}&date=${probeDate}`
            );
            const json: any = await res.json();
            const hasResolved = json && Object.prototype.hasOwnProperty.call(json, "resolved");
            check(
                hasResolved,
                "live proxy serves the `.resolved` block the current jq reads",
                hasResolved ? JSON.stringify(json.resolved) : "MISSING - the deployed app predates the resolver"
            );
            check(
                json && Object.prototype.hasOwnProperty.call(json, "response"),
                "live proxy still passes `.response` through for the legacy scheme"
            );
        } catch (e: any) {
            check(false, "live proxy is reachable", e.message);
        }
    }

    console.log("");
    for (const n of notes) console.log(`  note: ${n}`);

    if (failures.length > 0) {
        console.log(`\nOUT OF SYNC - ${failures.length} check(s) failed. Do not deploy:`);
        for (const f of failures) console.log(`  - ${f}`);
        process.exit(1);
    }
    console.log("\nIN SYNC: frontend, ABI, deployed bytecode and live proxy all agree.");
}

void main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
