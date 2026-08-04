/**
 * Route-risk premium pricing.
 *
 * The premium reflects how often the traveler's route actually triggers a payout (2h+ arrival
 * delay or cancellation). The estimate is produced here and re-validated onchain against
 * FlightGuard.MIN_PREMIUM_BPS / MAX_PREMIUM_BPS.
 *
 * WHY THIS DOESN'T JUST COUNT 2h+ DELAYS
 * --------------------------------------
 * The obvious estimator - "what fraction of recent flights on this route ran 2h+ late" - was
 * measured against real data and is close to useless at free-tier sample sizes. Splitting each
 * route's history by day and correlating one half against the other (see the calibration notes
 * in the README), the observed statistics have these split-half reliabilities - how much of
 * their route-to-route variation is real signal rather than sampling noise:
 *
 *     severe (2h+/cancel) rate   0.11    <- ~90% noise
 *     p90 of non-severe delays   0.37
 *     moderate (30min+) rate     0.59    <- most reliable
 *
 * The reason is visible in the raw data: 2h+ events are episodic weather shocks, not a stable
 * property of a route. Across 30 calibration routes, 51% of a route's severe events fell on its
 * single worst day, and one route (HKG-TPE) had all 16 of its severe events on one day and zero
 * on the other four. Pricing off that number mostly prices which storm happened to land inside
 * the sample window.
 *
 * So the risk estimate is built primarily from the *moderate*-delay signal, which is far better
 * measured, and converted into an expected 2h+ rate using relationships fitted on the same
 * calibration set. Each component is weighted by its measured reliability. This is not a wider
 * output range dressed up - out-of-sample, this estimator tracks the next period's severe rate
 * better than the severe-count estimator it replaces (0.172 vs 0.119).
 *
 * DATA-TIER CONSTRAINTS (stated honestly - a hackathon build on a free API key):
 *
 *  - airlabs' historical endpoint requires a specific `flight_iata` and returns at most 5 past
 *    instances. Date-range and pagination parameters are accepted but ignored - verified by
 *    probing `date_from`/`date_to`, `from`/`to`, `offset`, `skip`, `page` and `date`, all of
 *    which returned the identical 5 rows. 5 per flight is a hard cap.
 *  - The only way to enlarge a route sample is therefore more flight numbers on the same city
 *    pair, which is what MAX_FLIGHTS_SAMPLED does (n rises from ~10 to ~60 on busy routes).
 *  - Those schedules are dense with codeshares - KL2501 / DL5994 / AF6753 / VS4 can be one
 *    physical aircraft each reporting the same delay - so observations are deduped by
 *    (route, departure slot).
 *  - The returned window is a fixed handful of calendar days, so observations cluster by day and
 *    are NOT independent. Shrinkage is therefore applied per distinct day, not per flight.
 *  - Calibration constants below come from 30 routes / ~1500 real flights in that window. They
 *    are a single-window fit, not a multi-season model.
 *
 * If no usable sample comes back, the quote falls back to the flat 10% documented in the README.
 */

/** Matches FlightGuard.DELAY_THRESHOLD_MIN - the delay that actually triggers a payout. */
export const SEVERE_DELAY_MIN = 120;
/** A "moderate" delay: the well-measured signal the estimate leans on. */
export const MODERATE_DELAY_MIN = 30;

export const MIN_PREMIUM_BPS = 500; // mirrors FlightGuard.MIN_PREMIUM_BPS (hard onchain floor)
export const LOW_RISK_PREMIUM_BPS = 800; // app pricing floor
export const FALLBACK_PREMIUM_BPS = 1000; // mirrors FlightGuard.FALLBACK_PREMIUM_BPS
export const MAX_PREMIUM_BPS = 1500; // mirrors FlightGuard.MAX_PREMIUM_BPS

// ---- calibration constants (fitted on the 30-route sample; see README) ----

/** Pooled 2h+/cancel rate across the calibration routes - the shrinkage target. */
const BASE_SEVERE_RATE = 0.0559;
/** severeRate ~ moderateRate, least squares. */
const MOD_INTERCEPT = 0.0396, MOD_SLOPE = 0.118;
/** severeRate ~ p90 of non-severe delay minutes, least squares. */
const P90_INTERCEPT = 0.0228, P90_SLOPE = 0.000823;
/** Component weights = each statistic's measured split-half reliability. */
const W_MODERATE = 0.589, W_P90 = 0.371, W_SEVERE = 0.109;

/**
 * Shrinkage strength in *days*. Severe events cluster by weather day, so a route observed
 * across 25 days is far better evidenced than one seen across 5, regardless of flight count.
 */
const PRIOR_DAYS = 6;

/**
 * Flights per day required before a day counts as a full day of evidence. Days are the right
 * clustering unit, but a "day" holding a single flight is not worth as much as one holding ten
 * - without this, a 5-flight/5-day sample earns the same confidence as a 50-flight/5-day one
 * and can price far from the base rate off almost nothing.
 */
const FLIGHTS_PER_FULL_DAY = 3;

/**
 * Expected-loss loading. The premium is this multiple of the estimated payout probability, so
 * every route pays the same multiple of its own expected loss - which is what makes the spread
 * between routes meaningful rather than arbitrary. Derived (not hand-picked) so that a route
 * sitting exactly at the pooled base rate prices at the legacy flat 10%, keeping continuity
 * with the documented fallback: 0.0559 * 1.789 = 10.00%.
 */
const EXPECTED_LOSS_LOADING = FALLBACK_PREMIUM_BPS / (10_000 * BASE_SEVERE_RATE);

/** Below this many usable observations we don't claim to know the route's risk at all. */
const MIN_OBSERVATIONS = 4;

/** Flight numbers per city pair to pull history for. Each is one cached API call. */
const MAX_FLIGHTS_SAMPLED = 40;

const CACHE_TTL_MS = 30 * 60 * 1000;

type AirlabsHistoricalEntry = {
  dep_iata?: string;
  arr_iata?: string;
  dep_time?: string;
  dep_actual?: string | null;
  arr_actual?: string | null;
  status?: string;
  delayed?: number | null;
  dep_delayed?: number | null;
  arr_delayed?: number | null;
};

type AirlabsScheduleEntry = { flight_iata?: string };

/** One completed flight on the route. */
export type RouteObservation = {
  /** Identity of the physical flight, used to collapse codeshares. */
  key: string;
  /** Calendar day (YYYY-MM-DD) - the clustering unit for shrinkage. */
  day: string;
  delayMinutes: number;
  cancelled: boolean;
};

export type RiskQuote = {
  premiumBps: number;
  /** Observed 2h+/cancel frequency. Reported for transparency, NOT the main price driver. */
  delayRate: number | null;
  /** Observed 30min+ frequency - the signal that actually drives the price. */
  moderateRate: number | null;
  sampleSize: number;
  /** Distinct calendar days covered - the honest measure of how much evidence there is. */
  dayCount: number;
  delayedCount: number;
  source: "route-history" | "fallback";
  description: string;
};

type CacheEntry = { fetchedAt: number; quote: RiskQuote };

const cache = new Map<string, CacheEntry>();

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Premium = loading x estimated payout probability, bounded by the app/contract range. */
export function premiumBpsFromRiskRate(riskRate: number) {
  const rate = clamp(riskRate, 0, 1);
  return clamp(
    Math.round(10_000 * rate * EXPECTED_LOSS_LOADING),
    LOW_RISK_PREMIUM_BPS,
    MAX_PREMIUM_BPS
  );
}

export function isSevere(obs: RouteObservation) {
  return obs.cancelled || obs.delayMinutes >= SEVERE_DELAY_MIN;
}

function isModerate(obs: RouteObservation) {
  return !isSevere(obs) && obs.delayMinutes >= MODERATE_DELAY_MIN;
}

function p90NonSevere(observations: RouteObservation[]) {
  const delays = observations
    .filter((o) => !isSevere(o))
    .map((o) => o.delayMinutes)
    .sort((a, b) => a - b);
  return delays.length ? delays[Math.floor(0.9 * delays.length)] : 0;
}

/**
 * Estimated probability that a flight on this route triggers a payout.
 *
 * Blends three views of the sample, weighted by how reliable each proved to be, then shrinks
 * toward the pooled base rate by the number of distinct days observed.
 */
export function estimateRiskRate(observations: RouteObservation[]) {
  const n = observations.length;
  if (n === 0) return BASE_SEVERE_RATE;

  const severeRate = observations.filter(isSevere).length / n;
  const moderateRate = observations.filter(isModerate).length / n;

  const fromModerate = MOD_INTERCEPT + MOD_SLOPE * moderateRate;
  const fromP90 = P90_INTERCEPT + P90_SLOPE * p90NonSevere(observations);
  const blended =
    (W_MODERATE * fromModerate + W_P90 * fromP90 + W_SEVERE * severeRate) / (W_MODERATE + W_P90 + W_SEVERE);

  // Evidence is limited by BOTH how many days were seen (clustering) and how many flights
  // filled them (sampling error) - whichever is scarcer.
  const days = new Set(observations.map((o) => o.day)).size;
  const effectiveDays = Math.min(days, n / FLIGHTS_PER_FULL_DAY);
  return (blended * effectiveDays + BASE_SEVERE_RATE * PRIOR_DAYS) / (effectiveDays + PRIOR_DAYS);
}

/** Builds the quote from an already-collected route sample. Pure - no network. */
export function quoteFromObservations(observations: RouteObservation[], routeLabel: string): RiskQuote | null {
  if (observations.length < MIN_OBSERVATIONS) return null;

  const n = observations.length;
  const delayedCount = observations.filter(isSevere).length;
  const moderateCount = observations.filter(isModerate).length;
  const dayCount = new Set(observations.map((o) => o.day)).size;
  const premiumBps = premiumBpsFromRiskRate(estimateRiskRate(observations));

  return {
    premiumBps,
    delayRate: delayedCount / n,
    moderateRate: moderateCount / n,
    sampleSize: n,
    dayCount,
    delayedCount,
    source: "route-history",
    description:
      `${routeLabel}: ${moderateCount} of ${n} recent flights ran 30min+ late` +
      ` and ${delayedCount} hit the 2h+/cancel trigger, across ${dayCount} days`,
  };
}

export function fallbackQuote(): RiskQuote {
  return {
    premiumBps: FALLBACK_PREMIUM_BPS,
    delayRate: null,
    moderateRate: null,
    sampleSize: 0,
    dayCount: 0,
    delayedCount: 0,
    source: "fallback",
    description: "Route-risk sample unavailable - using the documented 10% flat fallback",
  };
}

function observedDelayMinutes(entry: AirlabsHistoricalEntry) {
  return Math.max(entry.arr_delayed ?? 0, entry.dep_delayed ?? 0, entry.delayed ?? 0);
}

/**
 * Keeps only flights whose outcome is actually known. Scheduled-but-not-yet-flown rows report
 * no delay, and counting them as on-time would drag every route toward the floor.
 */
function hasCompleted(entry: AirlabsHistoricalEntry) {
  if (entry.status === "cancelled") return true;
  if (entry.status && entry.status !== "landed") return false;
  return Boolean(entry.dep_actual || entry.arr_actual) || observedDelayMinutes(entry) > 0;
}

function toObservation(entry: AirlabsHistoricalEntry): RouteObservation {
  const depTime = entry.dep_time ?? "";
  return {
    // Codeshares of one physical flight share a route and departure slot.
    key: `${entry.dep_iata}|${entry.arr_iata}|${depTime}`,
    day: depTime.slice(0, 10),
    delayMinutes: observedDelayMinutes(entry),
    cancelled: entry.status === "cancelled",
  };
}

export function dedupeObservations(observations: RouteObservation[]) {
  const seen = new Map<string, RouteObservation>();
  for (const obs of observations) {
    const existing = seen.get(obs.key);
    // Keep the worst reading for a slot - codeshare rows occasionally disagree.
    if (!existing || obs.delayMinutes > existing.delayMinutes || obs.cancelled) seen.set(obs.key, obs);
  }
  return [...seen.values()];
}

async function getJson<T>(url: string): Promise<T[] | null> {
  const res = await fetch(url, { next: { revalidate: 1800 } });
  if (!res.ok) return null;
  const json = (await res.json()) as { response?: unknown };
  return Array.isArray(json.response) ? (json.response as T[]) : null;
}

/** Flight numbers serving this city pair, used to widen the history sample beyond one flight. */
async function routeFlightNumbers(depIata: string, arrIata: string, apiKey: string): Promise<string[]> {
  const url = `https://airlabs.co/api/v9/schedules?${new URLSearchParams({
    api_key: apiKey,
    dep_iata: depIata,
    arr_iata: arrIata,
    _fields: "flight_iata",
  })}`;
  const entries = await getJson<AirlabsScheduleEntry>(url);
  if (!entries) return [];
  return [...new Set(entries.map((e) => e.flight_iata).filter((f): f is string => Boolean(f)))];
}

async function flightHistory(
  flightIata: string,
  depIata: string,
  arrIata: string,
  apiKey: string
): Promise<RouteObservation[]> {
  const url = `https://airlabs.co/api/v10/historical?${new URLSearchParams({
    api_key: apiKey,
    flight_iata: flightIata,
  })}`;
  const entries = await getJson<AirlabsHistoricalEntry>(url);
  if (!entries) return [];
  return entries
    .filter((e) => e.dep_iata === depIata && e.arr_iata === arrIata && hasCompleted(e))
    .map(toObservation);
}

async function routeHistoryQuote(
  flightIata: string,
  depIata: string,
  arrIata: string,
  apiKey: string
): Promise<RiskQuote | null> {
  const siblings = await routeFlightNumbers(depIata, arrIata, apiKey);
  // The flight being insured always leads the sample; siblings fill it out.
  const toSample = [flightIata, ...siblings.filter((f) => f !== flightIata)].slice(0, MAX_FLIGHTS_SAMPLED);

  const batches = await Promise.all(toSample.map((f) => flightHistory(f, depIata, arrIata, apiKey)));
  const observations = dedupeObservations(batches.flat());

  return quoteFromObservations(observations, `${depIata}-${arrIata}`);
}

export async function quoteRouteRisk({
  flightIata,
  depIata,
  arrIata,
  apiKey,
}: {
  flightIata: string;
  depIata: string | null;
  arrIata: string | null;
  apiKey: string;
}): Promise<RiskQuote> {
  if (!depIata || !arrIata) return fallbackQuote();

  const key = `${flightIata}|${depIata}|${arrIata}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.quote;

  let quote: RiskQuote | null = null;
  try {
    quote = await routeHistoryQuote(flightIata, depIata, arrIata, apiKey);
  } catch {
    // Any API failure prices at the documented flat fallback rather than blocking the quote.
    quote = null;
  }

  const finalQuote = quote ?? fallbackQuote();
  cache.set(key, { fetchedAt: Date.now(), quote: finalQuote });
  return finalQuote;
}
