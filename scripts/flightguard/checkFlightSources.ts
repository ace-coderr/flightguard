import fs from "fs";
import path from "path";
import { normalizeAirlabs, resolveFlightStatus } from "../../web/lib/server/flightSources";

// npx hardhat run scripts/flightguard/checkFlightSources.ts --network coston2
//
// Exercises the multi-source resolver against the REAL upstreams (not fixtures), and prints
// the `.resolved` block the attested jq will read. Run it before relying on a settlement:
// it shows which source answered, whether anything corroborated it, and - most importantly -
// whether the answer is "no source had a record", which is the case that used to settle
// silently as "no payout".
//
// FLIGHT / DATE override the flight inspected. AVIATIONSTACK_API_KEY, if set, enables the
// secondary; without it this honestly reports single-source.

function loadEnv() {
    for (const p of [path.join(__dirname, "..", "..", ".env"), path.join(__dirname, "..", "..", "web", ".env.local")]) {
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=(.*)$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    }
}

async function main() {
    loadEnv();
    const airlabsKey = process.env.FLIGHT_API_KEY;
    if (!airlabsKey) throw new Error("FLIGHT_API_KEY is not set");
    const aviationstackKey = process.env.AVIATIONSTACK_API_KEY;

    const flightIata = process.env.FLIGHT ?? "BA75";
    const date = process.env.DATE ?? new Date().toISOString().slice(0, 10);

    console.log(`Flight:    ${flightIata}`);
    console.log(`Date:      ${date}`);
    console.log(
        `Secondary: ${aviationstackKey ? "aviationstack (key present)" : "DISABLED (no AVIATIONSTACK_API_KEY)"}\n`
    );

    // Raw primary reading first, so a fallback is visibly a fallback rather than implied.
    const rawRes = await fetch(
        `https://airlabs.co/api/v9/flight?${new URLSearchParams({ api_key: airlabsKey, flight_iata: flightIata })}`
    );
    const raw = await rawRes.json().catch(() => null);
    const primary = normalizeAirlabs(raw);
    console.log("primary (airlabs):", primary ? JSON.stringify(primary) : "no usable record");

    const resolved = await resolveFlightStatus({
        flightIata,
        date,
        airlabsKey,
        aviationstackKey,
        corroborate: process.env.FLIGHT_CORROBORATE === "true",
    });

    console.log("\n--- .resolved (what the attested jq reads) ---");
    console.log(JSON.stringify(resolved, null, 2));

    const locked = resolved.date === date;
    console.log(`\nDate-lock (.resolved.date == "${date}"): ${locked ? "MATCH" : "NO MATCH"}`);
    console.log("Attested DTO would be:", {
        flightStatus: locked ? resolved.flightStatus : "EMPTY",
        delayMinutes: locked ? resolved.delayMinutes : 0,
        source: locked ? resolved.source : "none",
        corroborated: locked ? resolved.corroborated : false,
    });
    console.log(
        `Onchain provenance would be: ${
            !locked || resolved.flightStatus === "EMPTY"
                ? "DataUnavailable"
                : resolved.corroborated
                  ? "Corroborated"
                  : "SingleSource"
        }`
    );
}

void main().then(() => process.exit(0));
