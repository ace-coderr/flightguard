import flightGuardAbi from "./abi/FlightGuard.json";
import usdt0Abi from "./abi/USDT0.json";

export const flightGuardAddress = "0xd4A21D4C9ed26e78eaCcE21Ce6064D4A2be13fc5" as const;
export const usdt0Address = "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F" as const;

export const flightGuardConfig = {
  address: flightGuardAddress,
  abi: flightGuardAbi,
} as const;

export const usdt0Config = {
  address: usdt0Address,
  abi: usdt0Abi,
} as const;

export const USDT0_DECIMALS = 6;

export const PREMIUM_BPS = 1000n; // 10%, mirrors FlightGuard.PREMIUM_BPS
export const MAX_COVER = 500_000_000n; // 500 USDT0, mirrors FlightGuard.MAX_COVER
export const CLAIM_WINDOW_SECONDS = 3 * 24 * 60 * 60; // 3 days, mirrors FlightGuard.CLAIM_WINDOW

export enum PolicyStatus {
  Active = 0,
  PaidOut = 1,
  Expired = 2,
  NoPayout = 3,
}

export const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = {
  [PolicyStatus.Active]: "Active",
  [PolicyStatus.PaidOut]: "Paid out",
  [PolicyStatus.Expired]: "Expired",
  [PolicyStatus.NoPayout]: "No payout",
};
