/**
 * Route-risk premium pricing.
 *
 * The premium a traveler pays should reflect how often the route they're flying actually
 * triggers a payout (2h+ arrival delay or cancellation). This module estimates that rate
 * from airlabs data and maps it to a premiumBps that the contract re-validates onchain
 * (FlightGuard.MIN_PREMIUM_BPS / MAX_PREMIUM_BPS).
 *
 * DATA-TIER CONSTRAINTS (documented honestly - this is a hackathon build on a free API key):
 *
 *  - airlabs' historical endpoint requires a specific `flight_iata` and returns at most 5
 *    past instances per flight. There is no route-level history query, and `limit` is
 *    ignored. So a single flight number yields n <= 5 - far too small to observe a rare
 *    tail event like a 2h+ delay.
 *  - To get a usable route sample we widen from "this flight" to "this city pair": the
 *    schedules endpoint lists the flights serving dep->arr, and we pull history for a
 *    handful of them. That lifts n into the 10-30 range for busy routes.
 *  - Those schedules are dense with codeshares - KL2501 / DL5994 / AF6753 / VS4 can all be
 *    the same physical aircraft, and each would otherwise be counted as an independent
 *    observation of the same delay. We dedupe by (route, departure slot) so one physical
 *    flight counts once.
 *  - Even so, n stays small, so a raw severe/n frequency is unstable (0/8 would price the
 *    floor with false confidence). We shrink toward a base rate and give partial credit to
 *    near-miss delays - see estimateRiskRate below.
 *
 * When no usable sample comes back we fall back to the flat 10% documented in the README.
 */

/** Matches FlightGuard.DELAY_THRESHOLD_MIN - the delay that actually triggers a payout. */
export const SEVERE_DELAY_MIN = 120;

export const MIN_PREMIUM_BPS = 500; // mirrors FlightGuard.MIN_PREMIUM_BPS (hard onchain floor)
export const LOW_RISK_PREMIUM_BPS = 800; // app pricing floor: an ideal, never-delayed route
export const FALLBACK_PREMIUM_BPS = 1000; // mirrors FlightGuard.FALLBACK_PREMIUM_BPS
export const MAX_PREMIUM_BPS = 1500; // mirrors FlightGuard.MAX_PREMIUM_BPS

/** premiumBps = LOW_RISK + rate * RISK_SPAN_BPS, capped at MAX. */
const RISK_SPAN_BPS = 1200;

/**
 * Rate implied by the flat fallback premium, used as the shrinkage prior: with no evidence
 * either way, a route prices exactly where the old flat-fee path priced it.
 */
const PRIOR_RATE = (FALLBACK_PREMIUM_BPS - LOW_RISK_PREMIUM_BPS) / RISK_SPAN_BPS; // 1/6

/**
 * Strength of the prior, in pseudo-observations. At n=5 the sample and the prior carry
 * roughly equal weight; by n=25 the sample dominates. Chosen to match the free tier's
 * realistic sample sizes rather than tuned against outcomes.
 */
const PRIOR_WEIGHT = 5;

/** Below this many usable observations we don't claim to know the route's risk at all. */
const MIN_OBSERVATIONS = 4;

/** How many flight numbers on the city pair to pull history for (1 API call each). */
const MAX_FLIGHTS_SAMPLED = 6;

const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Partial credit for near misses. A 2h+ delay is the payout trigger, but it's rare enough
 * that a <=30-observation sample often contains none - while a route that is routinely 45-90
 * minutes late clearly carries more tail risk than one that always lands on time. Shorter
 * delays therefore contribute a fraction of an event. These weights are a documented
 * heuristic, not a fitted model.
 */
const PARTIAL_CREDIT: ReadonlyArray<{ minDelay: number; weight: number }> = [
  { minDelay: SEVERE_DELAY_MIN, weight: 1 },
  { minDelay: 60, weight: 0.3 },
  { minDelay: 30, weight: 0.12 },
];

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

type AirlabsScheduleEntry = {
  flight_iata?: string;
  dep_iata?: string;
  arr_iata?: string;
};

/** One completed flight on the route. */
export type RouteObservation = {
  /** Identity of the physical flight, used to collapse codeshares. */
  key: string;
  delayMinutes: number;
  cancelled: boolean;
};

export type RiskQuote = {
  premiumBps: number;
  /** Raw observed severe-delay/cancel frequency - what we show the user. null when unknown. */
  delayRate: number | null;
  sampleSize: number;
  delayedCount: number;
  source: "route-history" | "fallback";
  description: string;
};

type CacheEntry = { fetchedAt: number; quote: RiskQuote };

const cache = new Map<string, CacheEntry>();

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function premiumBpsFromRiskRate(riskRate: number) {
  const rate = clamp(riskRate, 0, 1);
  return clamp(Math.round(LOW_RISK_PREMIUM_BPS + rate * RISK_SPAN_BPS), LOW_RISK_PREMIUM_BPS, MAX_PREMIUM_BPS);
}

function severityWeight(obs: RouteObservation) {
  if (obs.cancelled) return 1;
  for (const { minDelay, weight } of PARTIAL_CREDIT) {
    if (obs.delayMinutes >= minDelay) return weight;
  }
  return 0;
}

export function isSevere(obs: RouteObservation) {
  return obs.cancelled || obs.delayMinutes >= SEVERE_DELAY_MIN;
}

/**
 * Severity-weighted event frequency, shrunk toward PRIOR_RATE by PRIOR_WEIGHT
 * pseudo-observations. Small samples stay near the flat-fee rate instead of swinging to
 * either bound; large samples move the price where the evidence points.
 */
export function estimateRiskRate(observations: RouteObservation[]) {
  const weighted = observations.reduce((sum, obs) => sum + severityWeight(obs), 0);
  return (weighted + PRIOR_WEIGHT * PRIOR_RATE) / (observations.length + PRIOR_WEIGHT);
}

/** Builds the quote from an already-collected route sample. Pure - no network. */
export function quoteFromObservations(observations: RouteObservation[], routeLabel: string): RiskQuote | null {
  if (observations.length < MIN_OBSERVATIONS) return null;

  const delayedCount = observations.filter(isSevere).length;
  const delayRate = delayedCount / observations.length;
  const premiumBps = premiumBpsFromRiskRate(estimateRiskRate(observations));

  return {
    premiumBps,
    delayRate,
    sampleSize: observations.length,
    delayedCount,
    source: "route-history",
    description:
      `${routeLabel}: ${delayedCount} of ${observations.length} recent flights hit the 2h+/cancel trigger` +
      ` (free-tier sample, shorter delays counted partially)`,
  };
}

export function fallbackQuote(): RiskQuote {
  return {
    premiumBps: FALLBACK_PREMIUM_BPS,
    delayRate: null,
    sampleSize: 0,
    delayedCount: 0,
    source: "fallback",
    description: "Route-risk sample unavailable - using the documented 10% flat fallback",
  };
}

function observedDelayMinutes(entry: AirlabsHistoricalEntry) {
  return Math.max(entry.arr_delayed ?? 0, entry.dep_delayed ?? 0, entry.delayed ?? 0);
}

/**
 * Keeps only flights whose outcome is actually known. Scheduled-but-not-yet-flown rows
 * report no delay, and counting them as on-time would drag every route to the floor.
 */
function hasCompleted(entry: AirlabsHistoricalEntry) {
  if (entry.status === "cancelled") return true;
  if (entry.status && entry.status !== "landed") return false;
  return Boolean(entry.dep_actual || entry.arr_actual) || observedDelayMinutes(entry) > 0;
}

function toObservation(entry: AirlabsHistoricalEntry): RouteObservation {
  return {
    // Codeshares of one physical flight share a route and departure slot, so this collapses
    // them into a single observation.
    key: `${entry.dep_iata}|${entry.arr_iata}|${entry.dep_time ?? ""}`,
    delayMinutes: observedDelayMinutes(entry),
    cancelled: entry.status === "cancelled",
  };
}

export function dedupeObservations(observations: RouteObservation[]) {
  const seen = new Map<string, RouteObservation>();
  for (const obs of observations) {
    const existing = seen.get(obs.key);
    // Keep the worst reading for a slot - codeshare rows occasionally disagree.
    if (!existing || severityWeight(obs) > severityWeight(existing)) seen.set(obs.key, obs);
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
    _fields: "flight_iata,dep_iata,arr_iata",
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
