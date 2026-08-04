import { expect } from "chai";
import {
    FALLBACK_PREMIUM_BPS,
    LOW_RISK_PREMIUM_BPS,
    MAX_PREMIUM_BPS,
    MIN_PREMIUM_BPS,
    MODERATE_DELAY_MIN,
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
// re-validates it against MIN_PREMIUM_BPS/MAX_PREMIUM_BPS. These tests pin the pricing math so
// the app can never quote a premium the contract would reject, and so the model's honesty
// properties - lean on the well-measured moderate-delay signal, shrink by days observed, fall
// back when the sample is thin - can't silently regress.

const ROUTE = "DXB-BOM";
const DAY = "2026-08-04";

function obs(delayMinutes: number, day = DAY, key = `slot-${Math.random()}`): RouteObservation {
    return { key, day, delayMinutes, cancelled: false };
}

function cancelled(day = DAY, key = `slot-${Math.random()}`): RouteObservation {
    return { key, day, delayMinutes: 0, cancelled: true };
}

/** Spreads observations across `days` distinct days, so shrinkage sees real evidence. */
function sample(count: number, build: (i: number) => RouteObservation, days = 20) {
    return Array.from({ length: count }, (_, i) => {
        const o = build(i);
        return { ...o, day: `2026-08-${String((i % days) + 1).padStart(2, "0")}` };
    });
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
            // Any sample the estimator can see - all clean, all catastrophic, or mixed - must
            // still map into [MIN_PREMIUM_BPS, MAX_PREMIUM_BPS] or buyCover reverts.
            const samples: RouteObservation[][] = [
                sample(60, () => obs(0)),
                sample(60, () => obs(600)),
                sample(60, (i) => (i % 2 === 0 ? cancelled() : obs(0))),
                sample(4, () => cancelled()),
                sample(100, () => obs(SEVERE_DELAY_MIN)),
                sample(100, () => obs(MODERATE_DELAY_MIN)),
            ];
            for (const observations of samples) {
                const quote = quoteFromObservations(observations, ROUTE);
                expect(quote).to.not.equal(null);
                expect(quote.premiumBps).to.be.at.least(MIN_PREMIUM_BPS);
                expect(quote.premiumBps).to.be.at.most(MAX_PREMIUM_BPS);
            }
        });

        it("prices monotonically - a worse route never costs less", () => {
            const rates = [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1];
            const quoted = rates.map(premiumBpsFromRiskRate);
            for (let i = 1; i < quoted.length; i++) {
                expect(quoted[i]).to.be.at.least(quoted[i - 1]);
            }
        });

        it("prices as a fixed multiple of the estimated payout probability, between the bounds", () => {
            // The spread between routes is only meaningful because every route pays the same
            // multiple of its own expected loss.
            const a = premiumBpsFromRiskRate(0.05);
            const b = premiumBpsFromRiskRate(0.075);
            expect(a).to.be.greaterThan(LOW_RISK_PREMIUM_BPS);
            expect(b).to.be.lessThan(MAX_PREMIUM_BPS);
            expect(b / a).to.be.closeTo(1.5, 0.02);
        });
    });

    describe("payout trigger semantics", () => {
        it("counts a 2h+ delay or a cancellation as a severe event, and 119 minutes as not", () => {
            expect(isSevere(obs(SEVERE_DELAY_MIN))).to.equal(true);
            expect(isSevere(obs(SEVERE_DELAY_MIN - 1))).to.equal(false);
            expect(isSevere(cancelled())).to.equal(true);
        });

        it("reports the raw observed rates honestly alongside the price", () => {
            const observations = [...sample(3, () => obs(300)), ...sample(9, () => obs(0))];
            const quote = quoteFromObservations(observations, ROUTE);
            expect(quote.delayRate).to.equal(0.25);
            expect(quote.delayedCount).to.equal(3);
            expect(quote.sampleSize).to.equal(12);
        });

        it("reports the moderate-delay rate, which is what actually drives the price", () => {
            const observations = [...sample(5, () => obs(45)), ...sample(15, () => obs(0))];
            const quote = quoteFromObservations(observations, ROUTE);
            expect(quote.moderateRate).to.equal(0.25);
            expect(quote.delayRate).to.equal(0); // no 2h+ events at all
        });
    });

    describe("signal quality - moderate delays drive the price, severe events barely do", () => {
        it("prices a chronically-late route above an on-time one with the same zero severe count", () => {
            const onTime = quoteFromObservations(
                sample(40, () => obs(0)),
                ROUTE
            );
            const chronicallyLate = quoteFromObservations(
                sample(40, () => obs(75)),
                ROUTE
            );

            expect(onTime.delayedCount).to.equal(0);
            expect(chronicallyLate.delayedCount).to.equal(0);
            expect(chronicallyLate.premiumBps).to.be.greaterThan(onTime.premiumBps);
        });

        it("does not let a single storm day dominate the price", () => {
            // Real case from calibration: HKG-TPE had every one of its severe events on one
            // day. A route like that must not price near the cap off one bad day.
            const stormDay = Array.from({ length: 16 }, (_, i) => ({
                key: `storm-${i}`,
                day: "2026-08-05",
                delayMinutes: 400,
                cancelled: false,
            }));
            const calmDays = sample(80, () => obs(5), 20);
            const quote = quoteFromObservations([...stormDay, ...calmDays], ROUTE);
            expect(quote.premiumBps).to.be.lessThan(MAX_PREMIUM_BPS);
        });

        it("can price a route with MORE severe events below one with a higher moderate rate", () => {
            // This inversion is real, not hypothetical: live, HKG-TPE (17 severe, 17% moderate)
            // prices 11.57% while ORD-DFW (6 severe, 28% moderate) prices 13.88%. HKG-TPE's
            // severe events were one storm; ORD-DFW is chronically late, which is the signal
            // that actually repeats. If this ever flips, the severe rate has crept back into
            // dominating the price.
            const stormyButOtherwiseFine = [
                ...sample(17, () => obs(400), 2), // severe, concentrated on 2 days
                ...sample(83, () => obs(5), 10),
            ];
            const chronicallyLate = [
                ...sample(6, () => obs(400), 25), // few severe, spread out
                ...sample(22, () => obs(50), 25), // but a high moderate rate
                ...sample(72, () => obs(5), 25),
            ];
            const stormy = quoteFromObservations(stormyButOtherwiseFine, ROUTE);
            const chronic = quoteFromObservations(chronicallyLate, ROUTE);

            expect(stormy.delayedCount).to.be.greaterThan(chronic.delayedCount);
            expect(chronic.premiumBps).to.be.greaterThan(stormy.premiumBps);
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
            expect(quote.moderateRate).to.equal(null);
            expect(quote.sampleSize).to.equal(0);
            expect(quote.dayCount).to.equal(0);
            expect(quote.source).to.equal("fallback");
        });

        it("prices an empty sample at exactly the flat fallback rate", () => {
            expect(premiumBpsFromRiskRate(estimateRiskRate([]))).to.equal(FALLBACK_PREMIUM_BPS);
        });

        it("shrinks by DAYS observed, not flight count - clustered data is weaker evidence", () => {
            // Same 60 flights and same moderate rate, but one route was seen across 20 days and
            // the other across 2. The 2-day sample must sit closer to the base rate.
            const many = sample(60, () => obs(60), 20);
            const few = sample(60, () => obs(60), 2);
            const qMany = quoteFromObservations(many, ROUTE);
            const qFew = quoteFromObservations(few, ROUTE);
            expect(qMany.sampleSize).to.equal(qFew.sampleSize);
            expect(qMany.moderateRate).to.equal(qFew.moderateRate);
            expect(qMany.dayCount).to.be.greaterThan(qFew.dayCount);
            expect(qMany.premiumBps).to.be.greaterThan(qFew.premiumBps);
        });

        it("reports the day count so the UI can show how much evidence there is", () => {
            const quote = quoteFromObservations(
                sample(30, () => obs(0), 7),
                ROUTE
            );
            expect(quote.dayCount).to.equal(7);
            expect(quote.sampleSize).to.equal(30);
        });
    });

    describe("codeshare deduplication", () => {
        it("counts one physical flight once, however many codeshares report it", () => {
            // KL2501 / DL5994 / AF6753 / VS4 are the same aircraft on the same slot - real
            // airlabs behaviour, and counting them separately would quadruple the sample.
            const slot = "JFK|LHR|2026-08-01 18:10";
            const deduped = dedupeObservations([
                obs(16, DAY, slot),
                obs(16, DAY, slot),
                obs(16, DAY, slot),
                obs(16, DAY, slot),
            ]);
            expect(deduped).to.have.length(1);
        });

        it("keeps the worst reading when codeshare rows disagree", () => {
            const slot = "DXB|BOM|2026-08-01 09:00";
            const deduped = dedupeObservations([obs(10, DAY, slot), obs(445, DAY, slot), obs(0, DAY, slot)]);
            expect(deduped).to.have.length(1);
            expect(deduped[0].delayMinutes).to.equal(445);
        });

        it("prefers a cancellation over a delayed codeshare row for the same slot", () => {
            const slot = "DXB|BOM|2026-08-01 09:00";
            const deduped = dedupeObservations([obs(20, DAY, slot), cancelled(DAY, slot)]);
            expect(deduped).to.have.length(1);
            expect(deduped[0].cancelled).to.equal(true);
        });

        it("keeps genuinely distinct flights apart", () => {
            const deduped = dedupeObservations([
                obs(30, DAY, "slot-a"),
                obs(30, DAY, "slot-b"),
                obs(30, DAY, "slot-c"),
            ]);
            expect(deduped).to.have.length(3);
        });

        it("does not let codeshare duplication inflate confidence in a route", () => {
            const slots = sample(4, (i) => obs(0, DAY, `slot-${i}`));
            const duplicated = [...slots, ...slots, ...slots, ...slots, ...slots];
            const quote = quoteFromObservations(dedupeObservations(duplicated), ROUTE);
            expect(quote.sampleSize).to.equal(4);
        });
    });
});
