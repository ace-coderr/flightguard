import { formatUnits } from "viem";
import { USDT0_DECIMALS } from "./contracts";

function toFixedDp(raw: bigint, decimals: number, dp: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** USDT0 amounts (premium, cover, pool balances) — 6 decimals, shown to 2dp. */
export function formatAmount(value: bigint | undefined | null, dp = 2): string {
  return toFixedDp(value ?? 0n, USDT0_DECIMALS, dp);
}

/** Pool shares are minted 1:1 with deposited USDT0 units on first deposit and scale
 * proportionally after, so they live in the same 6-decimal fixed-point space as the
 * token — divide by 1e6 the same way, not display the raw integer. */
export function formatShares(value: bigint | undefined | null, dp = 2): string {
  return toFixedDp(value ?? 0n, USDT0_DECIMALS, dp);
}

/** "Oct 20, 2026" */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "18:45 UTC" from airlabs' "YYYY-MM-DD HH:MM" UTC timestamp format. */
export function formatUtcTime(timeUtc: string): string {
  const time = timeUtc.split(" ")[1];
  return time ? `${time} UTC` : timeUtc;
}

/** "BA75|2026-07-11" -> { flightIata, date } — tolerant of malformed data since it's
 *  purely for display; the keeper does its own strict parsing server-side. */
export function parsePolicyFlightRef(flightRef: string): { flightIata: string; date: string } | null {
  const [flightIata, date] = flightRef.split("|");
  return flightIata && date ? { flightIata, date } : null;
}
