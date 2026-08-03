# FlightGuard

**Parametric flight-delay insurance that settles itself — no claims, no adjuster.**

Buy cover for a flight in USDT0 (or pay the premium in FXRP). When the flight is delayed 2+ hours or cancelled, Flare's Data Connector cryptographically attests the flight's real status onchain and the contract pays the cover amount automatically. No claim form, no human in the loop.

- **Live app:** https://flightguard.vercel.app
- **Repo:** https://github.com/ace-coderr/flightguard
- **Network:** Flare Testnet Coston2 (chain ID 114)
- **Demo video:** _[link — coming]_

---

## Bounty

**Bounty 1 — Interoperable Asset Products.**

FlightGuard is an interoperable asset product built on the FAsset thesis: it prices and accepts **FXRP** (the XRP FAsset) as a first-class payment asset, denominates cover in **USDT0**, and settles trustlessly using **FDC** and **FTSO** — three enshrined Flare protocols, each doing real work rather than decoration.

## Product description

Flight-delay compensation is real money that travelers almost never collect — claims are manual, slow, and insurers profit from the friction. FlightGuard removes the claim entirely.

1. **Backers** deposit USDT0 into a shared pool and earn premiums (ERC-4626-style shares).
2. **Travelers** buy cover for a specific flight and date, paying a **risk-based premium** (8–15%, priced from the route's recent delay history) — in USDT0, or in FXRP priced live via FTSO.
3. After the flight's scheduled arrival, FlightGuard's autonomous **keeper** (or anyone) submits an FDC Web2Json attestation of the flight-status API onchain.
4. If the flight was **delayed ≥ 2 hours or cancelled**, the contract pays the cover amount to the traveler in the same transaction. Otherwise the premium stays with the pool.

Every settled policy has a **public, wallet-free receipt page** exposing the FDC voting round, settle transaction, request hash, and contract — verifiable by anyone.

## Target user

- **Travelers** who want automatic flight-delay compensation with no claims process.
- **USDT0 / FXRP holders** who back the pool to earn premiums.

Judges can obtain everything needed to test — **C2FLR, USDT0, and FXRP** — from the official Flare faucet at https://faucet.flare.network.

---

## How FlightGuard uses Flare

| Protocol | Role | Where |
| --- | --- | --- |
| **FDC (Web2Json)** | Settlement truth. The flight-status API is fetched, attested by Flare's validator set, and delivered onchain as a Merkle proof. `settle()` verifies it and pays automatically. | `contracts/FlightGuard.sol` (`settle`), `web/lib/server/fdc.ts` |
| **FTSO** | Premium pricing in FXRP. The FXRP premium amount is computed live from FTSO price feeds at purchase time. | `contracts/FlightGuard.sol` (`buyCoverWithFXRP`, `previewFxrpPremium`) |
| **FAssets (FXRP)** | Interoperable payment asset. Travelers can pay the premium in FXRP, the XRP FAsset. | `buyCoverWithFXRP` |
| **USDT0** | Cover denomination and pool asset (the official Coston2 faucet stablecoin). | pool accounting |

### FDC integration detail

Settlement attests a **first-party proxy URL** (`/api/flight-proxy`) rather than the flight API directly, so no API key ever appears in public onchain calldata. The proxy holds the key server-side and returns the flight JSON; the `postProcessJq` extracts `{flightStatus, delayMinutes}` and the response is ABI-decoded in `settle()`. Each policy stores a `requestHash` binding the exact request (URL + query + jq + ABI signature) so a proof for one flight can never settle another.

### FTSO integration detail

Coston2 exposes no `FXRP/USD` or `USDT0/USD` feed (verified against the full 64-feed list). Because both are 1:1-backed synthetic tokens, FlightGuard prices them via their underlying assets' feeds: **XRP/USD** (`0x015852502f55534400000000000000000000000000`) for FXRP and **USDT/USD** (`0x01555344542f555344000000000000000000000000`) for USDT0. Feed IDs and the FXRP token address were confirmed live onchain.

---

## Risk-based premium pricing

The premium is **not flat** — it reflects how often the route the traveler is flying actually triggers a payout (2h+ arrival delay or cancellation). Low-delay routes price at **8%**, scaling to a hard **15%** cap for high-delay routes.

**Where it happens.** `/api/flight-request` resolves the flight's real route (dep/arr IATA) via the first-party airlabs proxy, estimates the route's delay rate (`web/lib/server/riskPricing.ts`), and returns a `premiumBps` alongside the quote. The `/cover` page shows it directly — _"Premium: 9.29% — this route has a 7% observed 2h+ delay/cancel rate"_ — instead of the old flat "Premium (10%)" label.

**The premium is bounded onchain, not just in the UI.** `buyCover` / `buyCoverWithFXRP` take `premiumBps` as an argument and require `MIN_PREMIUM_BPS (500) <= premiumBps <= MAX_PREMIUM_BPS (1500)`, so a malicious or buggy frontend cannot drive the premium to zero or to an extortionate value. The risk-adjusted premium is computed **first**, and is the USD amount that then gets converted to FXRP by the FTSO read in `previewFxrpPremium` — one premium, two payment assets, not two independent calculations.

### How the delay rate is estimated (and its limits)

airlabs' free tier has no route-level history query: the historical endpoint requires a specific `flight_iata` and returns **at most 5 past instances** per flight (`limit` is ignored). Five observations cannot resolve a rare tail event like a 2h+ delay, so:

- **Widen to the city pair.** The schedules endpoint lists the flights serving `dep→arr`; we pull history for up to 6 of them, lifting the sample to roughly 10–30 flights on busy routes.
- **Collapse codeshares.** Those schedules are dense with codeshares — `KL2501` / `DL5994` / `AF6753` / `VS4` can be one physical aircraft, each reporting the same delay. Observations are deduped by (route, departure slot), so one real flight counts once. Without this, JFK→LHR reports 30 "independent" observations that are really 10.
- **Drop flights with no known outcome**, so scheduled-but-not-yet-flown rows can't be miscounted as on-time.
- **Shrink toward the base rate.** With small samples a raw frequency is unstable — 0/8 would price the floor with false confidence. The severity-weighted event count is shrunk toward the rate implied by the 10% fallback using 5 pseudo-observations, so _thin evidence prices near the flat rate and only real evidence moves the price_. A 5-flight clean sample therefore prices **above** a 40-flight clean sample.
- **Partial credit for near misses.** A 2h+ delay is the payout trigger but is rare in any free-tier sample, while a route that is routinely 45–90 minutes late plainly carries more tail risk than one that always lands on time. Shorter delays contribute a fraction of an event (a documented heuristic, not a fitted model).

**Known constraints, stated plainly:**

- **Small samples.** n is typically 10–30 per route and free-tier history covers only a few days, so these are genuinely noisy estimates. The shrinkage above is what keeps that noise from producing confident-looking nonsense; it is not a substitute for real data.
- **Narrow realistic spread.** Because 2h+ events are genuinely uncommon, observed live pricing lands in roughly the **8.8%–10%** band (e.g. JFK→LHR 8.95%, DXB→BOM 9.29%, LGA→ORD → fallback). The 15% cap is reachable by the model but not by most real routes on this data. That is the honest output, not a tuned demo.
- **No seasonality or weather.** A production model would price by season, time of day, weather forecast, and aircraft rotation. This prices the route only.
- **Sub-cap pricing.** For a route with a genuinely high payout rate, the 15% cap would be below the actuarially fair premium — deliberate, since the cap's job here is to bound frontend trust.
- **Fallback is a first-class path.** If the sample is unavailable or smaller than 4 usable observations, the quote falls back to the documented flat **10%** (`FALLBACK_PREMIUM_BPS`) and the UI says so. This is exercised live — LGA→ORD currently has too little history and quotes the fallback.

---

## What was newly built during the program

**FlightGuard was built entirely during Flare Summer Signal — nothing predated the program.** Everything below is new work:

- Solidity contract: pooled liquidity with shares, cover policies, FDC-verified settlement, expiry, FXRP-premium pricing via FTSO, and onchain-bounded risk-based premiums.
- Route-risk premium pricing: a delay-rate estimator over live flight history, with codeshare dedup, small-sample shrinkage, and a documented flat-rate fallback.
- 51-test Hardhat suite, including a regression test pinned to **real Coston2 proof bytes**, a real cancelled-flight response, and premium-bound/pricing-math coverage.
- FDC Web2Json attestation pipeline (TypeScript + a viem port for serverless), proven end-to-end against the live verifier.
- Autonomous settlement keeper (cron-driven) so policies settle with zero user action.
- First-party attestation proxy so no API key touches onchain calldata.
- Next.js 14 app: buy cover, my policies (with inline settlement trace), pool, public settlement receipts, and a live delay radar.
- Deployment to Coston2 (contract) and Vercel (app).

---

## Architecture

```
Traveler ──buyCover(USDT0)  ─┐
        └─buyCoverWithFXRP ──┤   FTSO price feeds (XRP/USD, USDT/USD)
                             ▼
                     FlightGuard.sol  ◄── USDT0 pool (backers earn premiums)
                             ▲
Keeper / anyone ──settle(proof)──┘
        │
        └─ /api/flight-proxy ──► airlabs flight API
                  │
                  ▼
        FDC Web2Json attestation ──► voting round ──► Merkle proof ──► settle()
```

- **Contract:** `contracts/FlightGuard.sol` — Solidity 0.8.25, Hardhat.
- **App:** `web/` — Next.js 14 (App Router), wagmi v2 + viem, Tailwind.
- **Keeper:** `web/app/api/keeper` — reads active past-due policies, drives the FDC cycle, calls `settle()` from a server wallet.

---

## How to test (for judges)

Everything needed to test is free from the official Flare faucet at https://faucet.flare.network — request **C2FLR**, **USDT0**, and **FXRP** for Coston2.

1. Open https://flightguard.vercel.app and connect a wallet on **Coston2** (chain 114).
2. **Buy Cover** — cover can only be bought for a flight that **hasn't landed yet** (you insure before the outcome is known). The page shows a few **currently coverable flights** you can click to auto-fill a working quote. Typing a flight that has already arrived returns a clear "already arrived" message — that's expected behavior, not an error.
   The quote shows a **risk-based premium** with the route's observed delay rate and sample size behind it (e.g. DXB→BOM quotes 9.29% off "2 of 28 recent flights"). Try a couple of different routes to see the premium move; a route with too little history says so and quotes the flat 10% fallback.
3. **My Policies** — see your cover and its status. The settled examples below (including flight **G58846**, delayed ~292 minutes, which **paid out automatically**) were settled on the [previous deployment](https://coston2-explorer.flare.network/address/0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63), before the contract was redeployed to add risk-based premiums — their transactions are still onchain and linked below, but they won't appear in this app's policy list, which reads the current contract. The settlement code itself is unchanged.
4. **Settlement receipts** — every settled policy has a public page (`/policy/[id]`, no wallet needed) linking the FDC voting round and settle transaction on the block explorer.
5. **Pool** — deposit USDT0 to back policies and earn premiums; withdraw free liquidity.
6. **Radar** — live flights delayed 2+ hours right now, as proof that these delays happen constantly.

Note: settlement runs against the **live FDC verifier** — a real attestation takes ~2–3 minutes (a voting round must finalize). The keeper settles delayed policies automatically; a manual "Settle" is also available.

---

## Onchain references (Coston2)

- **FlightGuard contract:** [`0x1126B59a867f44329de68b63d376305d3AF877a1`](https://coston2-explorer.flare.network/address/0x1126B59a867f44329de68b63d376305d3AF877a1)
- **FXRP token:** [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7)

**FTSO feed IDs** (bytes21, category `0x01` crypto + ASCII name):
- `XRP/USD`: `0x015852502f55534400000000000000000000000000`
- `USDT/USD`: `0x01555344542f555344000000000000000000000000`

**Settlement transactions** — all real, no mocks. These ran on the [previous deployment](https://coston2-explorer.flare.network/address/0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63) (`0xee52694D…e6A63`), before the redeploy that added risk-based premiums; the `settle()` / FDC / FTSO code paths they exercise are byte-for-byte unchanged in the current contract:

- **`settle()` → PAID OUT** — real FDC attestation of flight **G58846** (landed **292 min** late), policy paid the cover amount automatically: [`0xefab3688…d9cf`](https://coston2-explorer.flare.network/tx/0xefab368802f9d55b246b9ff68549eb87c975064630ca574fb641780cd9b1d9cf)
- `settle()` → NoPayout — real FDC attestation of an on-time flight (correctly pays nothing): [`0xfa4206f1…2cf79f`](https://coston2-explorer.flare.network/tx/0xfa4206f1c4687720e1c731565ba5a4960f2d38c19acb5f88c3cf3434ee2cf79f)
- `buyCoverWithFXRP()` — real FTSO read + real FXRP transfer: [`0xc7b8fc5d…91c152`](https://coston2-explorer.flare.network/tx/0xc7b8fc5dbbc09b2770ea61a254de697072ace9b32bcbda26c4bc509f0f91c152)

**Risk-based premium, proven live** (current deployment). Both buys are for **EK504 DXB→BOM**, whose route history returned 2 of 28 recent flights over the 2h+/cancel trigger — quoted at **929 bps (9.29%)**, not the flat 1000:

- `buyCover()` at a risk-adjusted premium — policy stores `premiumBps = 929`: [`0x88dceb25…03f350`](https://coston2-explorer.flare.network/tx/0x88dceb25f7d7adbf8969000072fec1a8156753bf824dbbdef9d51e717903f350)
- `buyCoverWithFXRP()` at the **same** 929 bps — the risk-adjusted USD premium (0.0929 USDT0) converted through the live FTSO read to 0.085882 FXRP, proving the risk step runs _before_ the FXRP conversion: [`0x6c24f1b2…89540d`](https://coston2-explorer.flare.network/tx/0x6c24f1b268049a9d0b0508628b2553da8afb8325c8590b36d81472c92989540d)

Reproduce either with `scripts/flightguard/buyRiskPricedPolicy.ts` or `scripts/flightguard/buyCoverWithFXRP.ts` — both quote the route live rather than hardcoding a premium.

Both payout outcomes are proven onchain: a delayed flight pays automatically, an on-time flight does not — settlement is driven purely by attested flight data, not discretion.

---

## Running locally

```bash
# contracts
yarn install
npx hardhat test          # 51 tests
npx hardhat run scripts/flightguard/deploy.ts --network coston2

# app
cd web
npm install
cp .env.local.example .env.local   # fill in values
npm run dev
```

Required env (see `web/.env.local.example`): `FLIGHT_API_KEY`, `SETTLER_PRIVATE_KEY`, `NEXT_PUBLIC_APP_URL`, `VERIFIER_URL_TESTNET`, `VERIFIER_API_KEY_TESTNET`, `COSTON2_DA_LAYER_URL`, `CRON_SECRET`.

---

## Known limitations & roadmap

Honest about what this is — a hackathon build with real, verified core mechanics and clear production gaps:

- **Single data source.** Settlement trusts one flight API (via the attested proxy). Production would attest multiple sources or a consensus feed.
- **Thin risk-pricing data.** Premiums are risk-based (see [Risk-based premium pricing](#risk-based-premium-pricing)), but the free API tier caps history at 5 instances per flight over a few days, so route samples are small (n ≈ 10–30) and noisy. Estimates are shrunk toward the flat base rate to avoid false confidence, and fall back to a flat 10% when a route has too little history. Production would use a paid multi-season feed and price seasonality and weather too.
- **Correlated pool risk.** One storm can delay many covered flights at once; production needs exposure caps and reinsurance-style tranching.
- **Keeper cadence.** On Vercel Hobby the keeper cron runs daily; production would use Vercel Pro (sub-hourly) or an external scheduler. The keeper endpoint is also manually triggerable.
- **Settler gas.** A server wallet pays FDC attestation fees today; production would use a relayer or user-funded attestation.
- **Testnet.** Coston2 only, pending FAssets/mainnet availability.

**Next steps:** FXRP payout option (not just premium), multi-source attestation, a paid multi-season delay feed to replace the free tier's thin route samples, FDC KV persistence for the keeper on serverless, and real user pilots.

---

## Deployment status

Deployed on **Coston2** (contract, verified at `0x1126B59a…877a1`) and **Vercel** (app). The core settlement flow is proven end-to-end against the **live FDC verifier** — a real delayed flight (G58846, 292 min) was attested onchain and paid out automatically, and an on-time flight correctly paid nothing. Not mocked. Deposit, withdraw (with locked-liquidity guard), USDT0 and FXRP premium payment, and autonomous keeper settlement are all verified onchain.

The contract was redeployed to add onchain-bounded risk-based premiums; settlement, FDC and FTSO logic are unchanged, so the settlement proofs above (on the prior address) still describe the code running today. Risk-based pricing is separately proven on the **current** deployment by the two buys linked above.
