import { expect } from "chai";
import {
    Observation,
    UNRESOLVED,
    normalizeAirlabs,
    normalizeAviationstack,
    payoutDecision,
    resolveFromObservations,
} from "../web/lib/server/flightSources";
import {
    buildFlightRequestBody as buildWebRequestBody,
    buildLegacyFlightRequestBody as buildWebLegacyRequestBody,
    buildPreProvenanceRequestBody,
    computeRequestHash as computeWebRequestHash,
    resolveFlightRequestBody,
} from "../web/lib/server/flightRequest";
import {
    buildFlightRequestBody as buildScriptRequestBody,
    buildLegacyFlightRequestBody as buildScriptLegacyRequestBody,
    computeRequestHash as computeScriptRequestHash,
} from "../scripts/fdc-attest-flight";

/**
 * FlightGuard settles on ONE attestation and jq cannot make HTTP calls, so the "try source A,
 * fall back to source B" chain lives in the first-party proxy the attestation actually
 * fetches. These tests pin the resolution rules, because the resulting `source` /
 * `corroborated` values are attested and land onchain as FlightGuard.Provenance - a wrong
 * rule here would mislabel real settlements rather than merely misroute a request.
 *
 * Worth noting against the historical record: scripts/fdc-attest-flight.ts records that
 * aviationstack was abandoned early on because the FDC *verifier* could not fetch it
 * ("INVALID: FETCH ERROR"). That failure mode doesn't apply here - the verifier only ever
 * fetches our proxy, and the proxy fetches aviationstack server-side.
 */

const DATE = "2026-08-07";

function obs(overrides: Partial<Observation> = {}): Observation {
    return { source: "airlabs", depDateUtc: DATE, status: "landed", delayMinutes: 0, ...overrides };
}

describe("multi-source flight resolution", () => {
    describe("payout decision", () => {
        it("counts a cancellation or a 2h+ delay, matching the contract's trigger", () => {
            expect(payoutDecision({ status: "cancelled", delayMinutes: 0 })).to.equal(true);
            expect(payoutDecision({ status: "landed", delayMinutes: 120 })).to.equal(true);
            expect(payoutDecision({ status: "landed", delayMinutes: 119 })).to.equal(false);
            expect(payoutDecision({ status: "landed", delayMinutes: 0 })).to.equal(false);
        });
    });

    describe("normalization", () => {
        it("reads the airlabs single-object shape", () => {
            const o = normalizeAirlabs({
                response: { dep_time_utc: "2026-08-07 10:15", status: "landed", arr_delayed: 942 },
            });
            expect(o).to.deep.equal({
                source: "airlabs",
                depDateUtc: DATE,
                status: "landed",
                delayMinutes: 942,
            });
        });

        it("treats a null airlabs arr_delayed as zero, as the jq `// 0` did", () => {
            const o = normalizeAirlabs({
                response: { dep_time_utc: "2026-08-07 10:15", status: "cancelled", arr_delayed: null },
            });
            expect(o.delayMinutes).to.equal(0);
            expect(o.status).to.equal("cancelled");
        });

        it("returns null for an airlabs error/empty payload", () => {
            expect(normalizeAirlabs({ error: { message: "no record" } })).to.equal(null);
            expect(normalizeAirlabs(null)).to.equal(null);
        });

        // aviationstack returns an array of occurrences and its free tier has no historical
        // (flight_date) filter, so the right occurrence has to be picked out client-side.
        it("picks the aviationstack row matching the requested date", () => {
            const o = normalizeAviationstack(
                {
                    data: [
                        { flight_date: "2026-08-06", flight_status: "landed", arrival: { delay: 5 } },
                        { flight_date: DATE, flight_status: "cancelled", arrival: { delay: null } },
                    ],
                },
                DATE
            );
            expect(o).to.deep.equal({
                source: "aviationstack",
                depDateUtc: DATE,
                status: "cancelled",
                delayMinutes: 0,
            });
        });

        it("falls back to departure.scheduled when flight_date is absent", () => {
            const o = normalizeAviationstack(
                {
                    data: [
                        {
                            flight_status: "landed",
                            departure: { scheduled: `${DATE}T10:15:00+00:00` },
                            arrival: { delay: 200 },
                        },
                    ],
                },
                DATE
            );
            expect(o.depDateUtc).to.equal(DATE);
            expect(o.delayMinutes).to.equal(200);
        });

        it("returns null when no aviationstack row is about the requested date", () => {
            const o = normalizeAviationstack({ data: [{ flight_date: "2026-08-01", flight_status: "landed" }] }, DATE);
            expect(o).to.equal(null);
        });
    });

    describe("resolution", () => {
        it("uses the primary alone when it has a usable record", () => {
            const r = resolveFromObservations(obs({ delayMinutes: 300 }), null, DATE);
            expect(r.source).to.equal("airlabs");
            expect(r.delayMinutes).to.equal(300);
            expect(r.corroborated).to.equal(false); // nothing confirmed it
            expect(r.date).to.equal(DATE);
        });

        // The point of the whole exercise: a flight the primary has no record of used to
        // settle as "no payout". Now the secondary can answer for it.
        it("falls back to the secondary when the primary has nothing", () => {
            const r = resolveFromObservations(null, obs({ source: "aviationstack", status: "cancelled" }), DATE);
            expect(r.source).to.equal("aviationstack");
            expect(r.flightStatus).to.equal("cancelled");
        });

        it("falls back when the primary answered about a different date", () => {
            const stale = obs({ depDateUtc: "2026-08-01", status: "landed", delayMinutes: 0 });
            const fresh = obs({ source: "aviationstack", status: "cancelled" });
            const r = resolveFromObservations(stale, fresh, DATE);
            expect(r.source).to.equal("aviationstack");
            expect(r.flightStatus).to.equal("cancelled");
        });

        it("marks agreement on the payout decision as corroborated", () => {
            const r = resolveFromObservations(
                obs({ status: "landed", delayMinutes: 300 }),
                obs({ source: "aviationstack", status: "active", delayMinutes: 295 }),
                DATE
            );
            expect(r.corroborated).to.equal(true);
            // Agreement is on the DECISION, not on every field - sources legitimately differ
            // on status vocabulary and by a minute or two of delay.
            expect(r.source).to.equal("airlabs");
            expect(r.delayMinutes).to.equal(300);
        });

        it("does not claim corroboration when the sources disagree, and keeps the primary's reading", () => {
            const r = resolveFromObservations(
                obs({ status: "landed", delayMinutes: 300 }), // would pay out
                obs({ source: "aviationstack", status: "landed", delayMinutes: 10 }), // would not
                DATE
            );
            expect(r.corroborated).to.equal(false);
            expect(r.source).to.equal("airlabs");
            expect(r.delayMinutes).to.equal(300);
        });

        it("does not let a disagreeing secondary flip a non-payout into a payout", () => {
            const r = resolveFromObservations(
                obs({ status: "landed", delayMinutes: 10 }),
                obs({ source: "aviationstack", status: "cancelled" }),
                DATE
            );
            expect(payoutDecision({ status: r.flightStatus, delayMinutes: r.delayMinutes })).to.equal(false);
            expect(r.corroborated).to.equal(false);
        });

        it("resolves to nothing when neither source has a usable record", () => {
            expect(resolveFromObservations(null, null, DATE)).to.deep.equal(UNRESOLVED);
            expect(UNRESOLVED.flightStatus).to.equal("EMPTY");
            expect(UNRESOLVED.source).to.equal("none");
            expect(UNRESOLVED.date).to.equal(null);
        });

        it("resolves to nothing when both sources are about other dates", () => {
            const r = resolveFromObservations(
                obs({ depDateUtc: "2026-08-01" }),
                obs({ source: "aviationstack", depDateUtc: "2026-08-09" }),
                DATE
            );
            expect(r).to.deep.equal(UNRESOLVED);
        });
    });
});

describe("attested request schemes", () => {
    const FLIGHT = "OH5026";

    before(() => {
        process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://flightguard.vercel.app";
    });

    // The jq and abiSignature are duplicated between the app and the scripts because the
    // scripts can't import from web/. requestHash is keccak over exactly those strings, so a
    // one-character drift between the two silently makes every script-bought policy
    // unsettleable by the app's keeper. This is the test that catches that.
    it("builds a byte-identical request in the app and in the scripts", () => {
        const web = buildWebRequestBody(FLIGHT, DATE);
        const script = buildScriptRequestBody(FLIGHT, DATE);

        expect(script).to.deep.equal(web);
        expect(computeScriptRequestHash(script)).to.equal(computeWebRequestHash(web));
    });

    it("builds a byte-identical legacy request in the app and in the scripts", () => {
        const web = buildWebLegacyRequestBody(FLIGHT, DATE, "KEY");
        const script = buildScriptLegacyRequestBody(FLIGHT, DATE, "KEY");
        expect(script).to.deep.equal(web);
        expect(computeScriptRequestHash(script)).to.equal(computeWebRequestHash(web));
    });

    it("attests the four-field provenance DTO and locks on the resolved date", () => {
        const body = buildWebRequestBody(FLIGHT, DATE);
        expect(body.abiSignature).to.contain(`"name":"source"`);
        expect(body.abiSignature).to.contain(`"name":"corroborated"`);
        expect(body.postProcessJq).to.contain(`(.resolved.date // "") == "${DATE}"`);
        // Every field defaults safely, so a proxy with no `.resolved` block degrades to
        // ("EMPTY", 0, "none", false) rather than to a payout.
        expect(body.postProcessJq).to.contain(`.resolved.flightStatus // "EMPTY"`);
        expect(body.postProcessJq).to.contain(`.resolved.source // "none"`);
        expect(body.postProcessJq).to.contain(`.resolved.corroborated // false`);
    });

    it("gives each scheme a distinct requestHash", () => {
        const hashes = new Set([
            computeWebRequestHash(buildWebRequestBody(FLIGHT, DATE)),
            computeWebRequestHash(buildPreProvenanceRequestBody(FLIGHT, DATE)),
            computeWebRequestHash(buildWebLegacyRequestBody(FLIGHT, DATE, "KEY")),
        ]);
        expect(hashes.size).to.equal(3);
    });

    it("identifies which scheme a requestHash belongs to", () => {
        const current = computeWebRequestHash(buildWebRequestBody(FLIGHT, DATE));
        expect(resolveFlightRequestBody(FLIGHT, DATE, current, "KEY").scheme).to.equal("provenance");

        const preProvenance = computeWebRequestHash(buildPreProvenanceRequestBody(FLIGHT, DATE));
        expect(resolveFlightRequestBody(FLIGHT, DATE, preProvenance, "KEY").scheme).to.equal("pre-provenance");

        const legacy = computeWebRequestHash(buildWebLegacyRequestBody(FLIGHT, DATE, "KEY"));
        expect(resolveFlightRequestBody(FLIGHT, DATE, legacy, "KEY").scheme).to.equal("legacy");

        expect(resolveFlightRequestBody(FLIGHT, DATE, `0x${"11".repeat(32)}`, "KEY")).to.equal(null);
    });
});
