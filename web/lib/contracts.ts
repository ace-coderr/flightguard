import flightGuardAbi from "./abi/FlightGuard.json";
import usdt0Abi from "./abi/USDT0.json";
import fxrpAbi from "./abi/FXRP.json";

export const flightGuardAddress = "0x374F52c6cbe43f092453e95E4580016aD9ff5fc3" as const;
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

export const MIN_PREMIUM_BPS = 500; // mirrors FlightGuard.MIN_PREMIUM_BPS
export const LOW_RISK_PREMIUM_BPS = 800; // app pricing floor for low-delay routes
export const FALLBACK_PREMIUM_BPS = 1000; // mirrors FlightGuard.FALLBACK_PREMIUM_BPS
export const MAX_PREMIUM_BPS = 1500; // mirrors FlightGuard.MAX_PREMIUM_BPS
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

/** Mirrors FlightGuard.Provenance — how well-evidenced a settlement was. */
export enum Provenance {
    Unsettled = 0,
    Corroborated = 1,
    SingleSource = 2,
    DataUnavailable = 3,
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
    [Provenance.Unsettled]: "Not settled",
    [Provenance.Corroborated]: "Corroborated by 2 sources",
    [Provenance.SingleSource]: "Single source",
    [Provenance.DataUnavailable]: "No flight data available",
};

export const PROVENANCE_DETAIL: Record<Provenance, string> = {
    [Provenance.Unsettled]: "No settlement proof has been consumed for this policy yet.",
    [Provenance.Corroborated]:
        "Two independent flight-data sources were queried and agreed on the payout decision. Both readings are covered by the same FDC proof.",
    [Provenance.SingleSource]:
        "Exactly one flight-data source answered for this flight, so nothing independently confirmed it. The reading is still cryptographically attested by FDC — it just wasn't cross-checked.",
    [Provenance.DataUnavailable]:
        "No source had a usable record for this flight and date, so the policy settled without a payout on absence of data rather than on a confirmed on-time arrival.",
};
