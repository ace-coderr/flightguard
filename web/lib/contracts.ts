import flightGuardAbi from "./abi/FlightGuard.json";
import usdt0Abi from "./abi/USDT0.json";
import fxrpAbi from "./abi/FXRP.json";

export const flightGuardAddress = "0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63" as const;
export const usdt0Address = "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F" as const;
// FXRP (FAsset wrapping XRP) - resolved live via AssetManagerFXRP.fAsset() at deploy time,
// see scripts/flightguard/deploy.ts / scripts/fassets/getFXRP.ts.
export const fxrpAddress = "0x0b6A3645c240605887a5532109323A3E12273dc7" as const;

export const flightGuardConfig = {
    address: flightGuardAddress,
    abi: flightGuardAbi,
} as const;

export const usdt0Config = {
    address: usdt0Address,
    abi: usdt0Abi,
} as const;

export const fxrpConfig = {
    address: fxrpAddress,
    abi: fxrpAbi,
} as const;

export const USDT0_DECIMALS = 6;
export const FXRP_DECIMALS = 6;

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
