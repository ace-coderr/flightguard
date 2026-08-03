import { expect } from "chai";
import {
    FALLBACK_PREMIUM_BPS,
    LOW_RISK_PREMIUM_BPS,
    MAX_PREMIUM_BPS,
    MIN_PREMIUM_BPS,
    RouteObservation,
    SEVERE_DELAY_MIN,
    dedupeObservations,
    estimateRiskRate,
    fallbackQuote,
    isSevere,
    premiumBpsFromRiskRate,
    quoteFromObservations,
} from "../web/lib/server/riskPricing";

// The offchain pricer is the only thing that chooses a policy's premiumBps, and the contract
// re-validates it against MIN_PREMIUM_BPS/MAX_PREMIUM_BPS. These tests pin the pricing math
// so the app can never quote a premium the contract would reject, and so the small-sample
// behaviour (the free tier's core limitation) stays honest.

const ROUTE = "DXB-BOM";

function obs(delayMinutes: number, key = `slot-${Math.random()}`): RouteObservation {
    return { key, delayMinutes, cancelled: false };
}

function cancelled(key = `slot-${Math.random()}`): RouteObservation {
    return { key, delayMinutes: 0, cancelled: true };
}

function sample(count: number, build: (i: number) => RouteObservation) {
    return Array.from({ length: count }, (_, i) => build(i));
}

describe("route-risk premium pricing", () => {
    describe("premium bounds", () => {
        it("never quotes below the app floor or above the onchain maximum", () => {
            for (const rate of [-1, 0, 0.01, 0.25, 0.5, 0.9, 1, 2, 1e6]) {
                const bps = premiumBpsFromRiskRate(rate);
                expect(bps).to.be.at.least(LOW_RISK_PREMIUM_BPS);
                expect(bps).to.be.at.most(MAX_PREMIUM_BPS);
            }
        });

        it("keeps every quote inside the contract's accepted range", () => {
            // Any sample the estimator can see - all clean, all catastrophic, or mixed -
            // must still map into [MIN_PREMIUM_BPS, MAX_PREMIUM_BPS] or buyCover reverts.
            const samples: RouteObservation[][] = [
                sample(30, () => obs(0)),
                sample(30, () => obs(600)),
                sample(30, (i) => (i % 2 === 0 ? cancelled() : obs(0))),
                sample(4, () => cancelled()),
                sample(100, () => obs(SEVERE_DELAY_MIN)),
            ];
            for (const observations of samples) {
                const quote = quoteFromObservations(observations, ROUTE);
                expect(quote).to.not.equal(null);
                expect(quote.premiumBps).to.be.at.least(MIN_PREMIUM_BPS);
                expect(quote.premiumBps).to.be.at.most(MAX_PREMIUM_BPS);
            }
        });

        it("reaches the 15% cap on a route that always triggers, and the 8% floor is the best case", () => {
            const awful = quoteFromObservations(
                sample(30, () => cancelled()),
                ROUTE
            );
            expect(awful.premiumBps).to.equal(MAX_PREMIUM_BPS);

            // A perfectly clean route can approach but never undercut the floor.
            expect(premiumBpsFromRiskRate(0)).to.equal(LOW_RISK_PREMIUM_BPS);
        });

        it("prices monotonically - a worse route never costs less", () => {
            const rates = [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1];
            const quoted = rates.map(premiumBpsFromRiskRate);
            for (let i = 1; i < quoted.length; i++) {
                expect(quoted[i]).to.be.at.least(quoted[i - 1]);
            }
        });
    });

    describe("payout trigger semantics", () => {
        it("counts a 2h+ delay or a cancellation as a severe event, and 119 minutes as not", () => {
            expect(isSevere(obs(SEVERE_DELAY_MIN))).to.equal(true);
            expect(isSevere(obs(SEVERE_DELAY_MIN - 1))).to.equal(false);
            expect(isSevere(cancelled())).to.equal(true);
        });

        it("reports the raw observed severe rate, not the smoothed one", () => {
            // 3 of 12 hit the trigger - the user-facing number must be the honest 25%.
            const observations = [...sample(3, () => obs(300)), ...sample(9, () => obs(0))];
            const quote = quoteFromObservations(observations, ROUTE);
            expect(quote.delayRate).to.equal(0.25);
            expect(quote.delayedCount).to.equal(3);
            expect(quote.sampleSize).to.equal(12);
        });
    });

    describe("small-sample handling", () => {
        it("falls back to the flat rate when the route sample is too thin to mean anything", () => {
            expect(quoteFromObservations([], ROUTE)).to.equal(null);
            expect(
                quoteFromObservations(
                    sample(3, () => obs(0)),
                    ROUTE
                )
            ).to.equal(null);
            // 4 observations is the minimum we'll price on.
            expect(
                quoteFromObservations(
                    sample(4, () => obs(0)),
                    ROUTE
                )
            ).to.not.equal(null);
        });

        it("prices the documented flat 10% fallback when risk data is unavailable", () => {
            const quote = fallbackQuote();
            expect(quote.premiumBps).to.equal(FALLBACK_PREMIUM_BPS);
            expect(quote.delayRate).to.equal(null);
            expect(quote.sampleSize).to.equal(0);
            expect(quote.source).to.equal("fallback");
        });

        it("shrinks toward the flat fallback rate, so no evidence prices exactly at the fallback", () => {
            expect(premiumBpsFromRiskRate(estimateRiskRate([]))).to.equal(FALLBACK_PREMIUM_BPS);
        });

        it("trusts a thin clean sample less than a large one", () => {
            // Both routes observed zero severe events; the smaller sample is weaker evidence
            // and must therefore price higher (closer to the fallback).
            const thin = quoteFromObservations(
                sample(5, () => obs(0)),
                ROUTE
            );
            const thick = quoteFromObservations(
                sample(40, () => obs(0)),
                ROUTE
            );
            expect(thin.premiumBps).to.be.greaterThan(thick.premiumBps);
            expect(thin.delayRate).to.equal(thick.delayRate); // same observed rate, different confidence
        });

        it("gives partial credit to near-miss delays, since 2h+ events are rare at free-tier sample sizes", () => {
            const alwaysOnTime = quoteFromObservations(
                sample(20, () => obs(0)),
                ROUTE
            );
            const chronicallyLate = quoteFromObservations(
                sample(20, () => obs(75)),
                ROUTE
            );

            // Neither route triggered a payout in-sample...
            expect(alwaysOnTime.delayedCount).to.equal(0);
            expect(chronicallyLate.delayedCount).to.equal(0);
            // ...but the chronically-late one carries more tail risk and costs more.
            expect(chronicallyLate.premiumBps).to.be.greaterThan(alwaysOnTime.premiumBps);
        });
    });

    describe("codeshare deduplication", () => {
        it("counts one physical flight once, however many codeshares report it", () => {
            // KL2501 / DL5994 / AF6753 / VS4 are the same aircraft on the same slot - real
            // airlabs behaviour, and counting them separately would quadruple the sample.
            const slot = "JFK|LHR|2026-08-01 18:10";
            const deduped = dedupeObservations([obs(16, slot), obs(16, slot), obs(16, slot), obs(16, slot)]);
            expect(deduped).to.have.length(1);
        });

        it("keeps the worst reading when codeshare rows disagree", () => {
            const slot = "DXB|BOM|2026-08-01 09:00";
            const deduped = dedupeObservations([obs(10, slot), obs(445, slot), obs(0, slot)]);
            expect(deduped).to.have.length(1);
            expect(deduped[0].delayMinutes).to.equal(445);
        });

        it("keeps genuinely distinct flights apart", () => {
            const deduped = dedupeObservations([obs(30, "slot-a"), obs(30, "slot-b"), obs(30, "slot-c")]);
            expect(deduped).to.have.length(3);
        });

        it("does not let codeshare duplication inflate confidence in a route", () => {
            const slots = sample(4, (i) => obs(0, `slot-${i}`));
            const duplicated = [...slots, ...slots, ...slots, ...slots, ...slots];
            const quote = quoteFromObservations(dedupeObservations(duplicated), ROUTE);
            expect(quote.sampleSize).to.equal(4);
        });
    });
});
