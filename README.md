# FlightGuard

**Parametric flight-delay insurance that settles itself — no claims, no adjuster.**

Buy cover for a flight, paying the premium in USDT0 **or FXRP**, and choose to be paid out in USDT0 **or FXRP**. When the flight is delayed 2+ hours or cancelled, Flare's Data Connector cryptographically attests the flight's real status onchain and the contract pays automatically. No claim form, no human in the loop.

FlightGuard is **bidirectional with FXRP**: FXRP goes in as premium and comes out as payout, both priced live by FTSO — the premium at purchase, the payout at the moment of settlement.

- **Live app:** https://flightguard.vercel.app
- **Repo:** https://github.com/ace-coderr/flightguard
- **Network:** Flare Testnet Coston2 (chain ID 114)

---

## Recent upgrades

Two upgrades landed after the core build. Both are live on the current deployment
[`0x374F52c6…5fc3`](https://coston2-explorer.flare.network/address/0x374F52c6cbe43f092453e95E4580016aD9ff5fc3) and proven onchain.

**1. Bidirectional FXRP.** FXRP is now a first-class asset in _both_ directions: pay the premium in it, receive the payout in it, chosen independently — so all four combinations are valid. The payout is not fixed at purchase; `settle()` converts the USDT0 cover at the **live FTSO rate read inside the settlement transaction itself**, so the traveler receives the XRP-denominated value of their cover as of the moment the claim is paid.

> Proof — flight **AF5694**, landed **620 minutes** late, **1.927243 FXRP** delivered to the traveler and **0 USDT0**:
> [`0xca60eeab…fa4e`](https://coston2-explorer.flare.network/tx/0xca60eeabc2bedfda07bbba4e204992b300bd98348624ba56217959c166acfa4e)

The pool stays USDT0-only, so backer solvency and share pricing are untouched — see [Bidirectional FXRP](#bidirectional-fxrp) for how that swap is funded and the tradeoff it carries.

**2. Settlement provenance.** This fixes a real bug. When the flight API had no usable record, the attested status resolved to `EMPTY`, which failed both payout conditions and settled as a bare `NoPayout` — **indistinguishable onchain from a flight that simply arrived on time**. A traveler whose claim was denied by a data gap had no way to tell, and neither did anyone auditing the contract.

Every settlement now records how well-evidenced it was — `SingleSource`, `Corroborated`, or `DataUnavailable` — as `Policy.provenance` and via a `SettlementEvidence` event with `provenance` **indexed**, so the whole history can be filtered for uncorroborated or data-starved settlements. The `source` and `corroborated` fields travel inside the attested payload, so they are covered by the FDC proof rather than asserted by our server afterwards.

> Proof — a real data gap: flight **SQ23** had already rolled out of the upstream's record by settlement time, so the claim settled `NoPayout` and said exactly why:
> [`0x06f9a8f0…3ade`](https://coston2-explorer.flare.network/tx/0x06f9a8f08d3e043af8043b41b0a0500626d6bc642c9c50348d425bdc982a3ade)

Alongside it, settlement data now falls back to a second source when the primary has no record — inside the one attested request, since jq cannot make HTTP calls. What that does and does not buy is documented honestly in [Data sources, and the single-source risk](#data-sources-and-the-single-source-risk).

---

## Bounty

**Bounty 1 — Interoperable Asset Products.**

FlightGuard is an interoperable asset product built on the FAsset thesis: **FXRP** (the XRP FAsset) is a first-class asset in _both_ directions — travelers can pay the premium in it and be paid the claim in it — while cover stays denominated in **USDT0** and settlement is trustless via **FDC** and **FTSO**. Three enshrined Flare protocols, each doing real work rather than decoration.

## Product description

Flight-delay compensation is real money that travelers almost never collect — claims are manual, slow, and insurers profit from the friction. FlightGuard removes the claim entirely.

1. **Backers** deposit USDT0 into a shared pool and earn premiums (ERC-4626-style shares).
2. **Travelers** buy cover for a specific flight and date, paying a **risk-based premium** (8–15%, priced from the route's recent delay history) — in USDT0, or in FXRP priced live via FTSO — and pick the asset they want to be **paid out** in: USDT0 or FXRP.
3. After the flight's scheduled arrival, FlightGuard's autonomous **keeper** (or anyone) submits an FDC Web2Json attestation of the flight-status API onchain.
4. If the flight was **delayed ≥ 2 hours or cancelled**, the contract pays the cover amount to the traveler in the same transaction — in USDT0, or converted to FXRP at the FTSO rate read _inside that settlement transaction_. Otherwise the premium stays with the pool.

Every settled policy has a **public, wallet-free receipt page** exposing the FDC voting round, settle transaction, request hash, and contract — verifiable by anyone.

## Target user

- **Travelers** who want automatic flight-delay compensation with no claims process.
- **USDT0 / FXRP holders** who back the pool to earn premiums.

Judges can obtain everything needed to test — **C2FLR, USDT0, and FXRP** — from the official Flare faucet at https://faucet.flare.network.

---

## How FlightGuard uses Flare

| Protocol           | Role                                                                                                                                                                                                                 | Where                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **FDC (Web2Json)** | Settlement truth. The flight-status API is fetched, attested by Flare's validator set, and delivered onchain as a Merkle proof. `settle()` verifies it and pays automatically.                                       | `contracts/FlightGuard.sol` (`settle`), `web/lib/server/fdc.ts`                                                 |
| **FTSO**           | Pricing both FXRP legs. The FXRP premium is computed from live feeds at purchase; the FXRP payout is computed from live feeds **again, inside `settle()`**, so the claim is converted at the settlement-moment rate. | `contracts/FlightGuard.sol` (`buyCoverWithFXRP`, `previewFxrpPremium`, `settle`/`_payOut`, `previewFxrpPayout`) |
| **FAssets (FXRP)** | Interoperable asset in both directions. Travelers pay the premium in FXRP and/or receive the payout in FXRP, the XRP FAsset.                                                                                         | `buyCoverWithFXRP`, `Policy.payoutInFxrp`                                                                       |
| **USDT0**          | Cover denomination and pool asset (the official Coston2 faucet stablecoin).                                                                                                                                          | pool accounting                                                                                                 |

### FDC integration detail

Settlement attests a **first-party proxy URL** (`/api/flight-proxy`) rather than the flight API directly, so no API key ever appears in public onchain calldata. The proxy holds the key server-side and returns the flight JSON; the `postProcessJq` extracts `{flightStatus, delayMinutes, source, corroborated}` and the response is ABI-decoded in `settle()`. Each policy stores a `requestHash` binding the exact request (URL + query + jq + ABI signature) so a proof for one flight can never settle another.

---

## Data sources, and the single-source risk

This is the weakest link in the system, so it is documented rather than glossed.

### What the data path actually is

`postProcessJq` **cannot make HTTP calls** — FDC Web2Json fetches exactly one URL and applies jq to that one response. So a "try source A, fall back to source B" chain cannot live in the jq. It lives in the first-party proxy that FDC attests: the proxy queries the primary source, falls back to a secondary when the primary has no usable record, and returns one pre-resolved block (`.resolved`) that the attested jq reads. From FDC's side that is still one URL, one proof, one settlement.

|               | source                      | when                                                                                                                  |
| ------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Primary**   | airlabs `/v9/flight`        | always                                                                                                                |
| **Secondary** | aviationstack `/v1/flights` | only when the primary has no usable record for that flight+date — or on every settlement if `FLIGHT_CORROBORATE=true` |

The secondary is **optional and off by default**. With no `AVIATIONSTACK_API_KEY` set the proxy is single-source and says so in the attested payload rather than pretending otherwise.

Historical note: an early version of this project tried attesting aviationstack **directly** and abandoned it because the FDC verifier itself could not fetch it (`INVALID: FETCH ERROR`, recorded in `scripts/fdc-attest-flight.ts`). That failure mode doesn't apply to this design — the verifier only ever fetches our proxy, and the proxy fetches aviationstack server-side.

### What multi-sourcing does and does not buy

- **It buys availability.** A flight the primary has no record of no longer settles as a silent "no payout" — the secondary can answer for it.
- **It does not buy integrity.** FDC attests _"this URL returned these bytes"_. The proxy is still the single trusted aggregator either way. A compromised or buggy proxy can still report anything, and no amount of source-merging inside it changes that.

Genuine integrity would need **two independently attested URLs, cross-checked onchain** — two attestations per settlement, which is a different (and more expensive) design. That is the honest fix, and it is not what this is.

### So the settlement says what it was based on

Because single-sourcing can't be engineered away here, it is made **auditable** instead. The attested DTO carries its own provenance — `source` (which upstream answered) and `corroborated` (whether a second, independent source produced the same payout decision) — so those facts are covered by the FDC proof rather than asserted by our server afterwards. `settle()` records them as `Policy.provenance` and emits `SettlementEvidence(policyId, provenance, source)` with `provenance` **indexed**, so the whole history can be filtered for uncorroborated or data-starved settlements.

| `Provenance`      | meaning                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Corroborated`    | two independent sources agreed on the payout decision                                                                          |
| `SingleSource`    | exactly one source answered; nothing independently confirmed it                                                                |
| `DataUnavailable` | **no source had a usable record** — the policy settled without payout on _absence of data_, not on a confirmed on-time arrival |
| `Unsettled`       | no proof consumed yet, or expired without one                                                                                  |

`DataUnavailable` is the one that matters most. Before it, a data outage resolved to `flightStatus: "EMPTY"`, failed both payout conditions, and settled as a bare `NoPayout` — **indistinguishable onchain from a flight that simply arrived on time**. A traveler whose claim was denied by an API gap had no way to tell, and neither did anyone auditing the contract. Now the receipt page and the policy list both call it out explicitly.

`corroborated` is deliberately strict: absence of a second source and _disagreement_ between sources both yield `false`. In neither case has the reading actually been corroborated, and collapsing "unavailable" into "contradicted" would overclaim. On disagreement the primary's reading is the one used, so a secondary can never silently flip a payout either way — it is logged server-side and lands onchain as `SingleSource`.

### Known limits of this, stated plainly

- **Single trusted aggregator.** Covered above: this improves availability, not integrity.
- **The payout semantics on a data outage are unchanged.** `DataUnavailable` records the outage; it does not pay the claim. Whether a data outage should instead leave the policy `Active` for retry inside the 3-day claim window is a real design question and is deliberately _not_ decided quietly inside `settle()` — it's a roadmap item.
- **The secondary is not truly free.** aviationstack's free tier is 100 requests/month, its signup requires card-on-file billing details, and it bills overage past the quota. FlightAware's "free tier" is a $5/month credit with the same shape. OpenSky is genuinely free but was ruled out on capability, not cost: its arrival data is ADS-B derived (`icao24`, `callsign`, `firstSeen`/`lastSeen`) with no scheduled time, no IATA flight number and no delay field, so it cannot produce `{flightStatus, delayMinutes}` at all.
- **A public proxy in front of a metered upstream is an abuse vector.** The proxy must be unauthenticated (FDC verifiers fetch it with no credentials), so requests for non-existent flights could force fallback calls and drive overage. Mitigated by only falling back when the primary genuinely has nothing, by the existing per-IP rate limit, and by a 10-minute fallback cache — which also collapses the several verifier fetches of one attestation onto one upstream call, and keeps verifiers consistent with each other.
- **Both sources are commercial free tiers.** Neither is an aviation authority. Production would attest a consensus feed or a contractual data provider.

### FTSO integration detail

Coston2 exposes no `FXRP/USD` or `USDT0/USD` feed (verified against the full 64-feed list). Because both are 1:1-backed synthetic tokens, FlightGuard prices them via their underlying assets' feeds: **XRP/USD** (`0x015852502f55534400000000000000000000000000`) for FXRP and **USDT/USD** (`0x01555344542f555344000000000000000000000000`) for USDT0. Feed IDs and the FXRP token address were confirmed live onchain.

---

## Bidirectional FXRP

FXRP is not just an accepted payment method — it is an accepted _settlement_ asset. The two directions are independent choices at purchase, so all four combinations are valid (pay USDT0 / receive FXRP, pay FXRP / receive USDT0, and both matching).

|                | asset         | priced by                 | priced when                          |
| -------------- | ------------- | ------------------------- | ------------------------------------ |
| **Premium in** | USDT0 or FXRP | FTSO (XRP/USD ÷ USDT/USD) | at purchase, in `buyCoverWithFXRP`   |
| **Payout out** | USDT0 or FXRP | FTSO (XRP/USD ÷ USDT/USD) | **at settlement**, inside `settle()` |

The payout rate is deliberately _not_ fixed at purchase. `Policy.payoutInFxrp` stores only the choice; `settle()` reads the feeds in the same transaction that pays, so a traveler electing FXRP receives the XRP-denominated value of their cover as of the moment the claim is paid. In the live run below, the estimate shown at purchase (1.916888 FXRP) and the amount actually paid ~4 minutes later (1.918053 FXRP) differ exactly because XRP/USD moved in between.

### How an FXRP payout is funded, and why it's built this way

Cover stays USDT0-denominated and the backer pool stays **USDT0-only**. When an FXRP-payout policy pays out, the cover's USDT0 does not leave the contract: it is booked to `usdt0SwapProceeds` (which `poolBalance()` nets out) and an FTSO-equivalent amount of FXRP is sent to the holder from a pre-funded `fxrpPayoutReserve`. Economically that is one fair, FTSO-priced swap between the pool and the reserve provider.

The alternative — a second, FXRP-denominated backer pool — was rejected as both more complex and less safe: it needs a parallel set of shares/locked/free-liquidity accounting, a per-policy choice of which pool underwrites the cover, and it pushes FX risk onto backers, since an FXRP-pool backer's stake is XRP-denominated while the policy it underwrites is priced in USDT0, with no way to rebalance between the pools.

**The tradeoff, stated plainly:** this design requires someone to pre-fund the FXRP reserve, and that reserve provider — not backers — carries the XRP/USD move between funding the reserve and reclaiming the USDT0 via `withdrawSwapProceeds`. What is bought with that is the property that matters most: backer solvency, share pricing, and the entire USDT0 settlement path are provably unchanged (a test asserts an FXRP payout leaves `poolBalance`, `freeLiquidity`, `totalLocked` and `totalShares` byte-identical to what a USDT0 payout would have left). And a short or empty reserve can never strand a claim — `settle()` emits `FxrpPayoutUnavailable` and pays USDT0 instead of reverting. The same fallback covers a failed or zero FTSO read, so an oracle hiccup can never block a payout either.

---

## Risk-based premium pricing

The premium is **not flat** — it reflects how often the route the traveler is flying actually triggers a payout (2h+ arrival delay or cancellation). Low-delay routes price at **8%**, scaling to a hard **15%** cap for high-delay routes.

Live pricing across 15 real routes currently spans **8.00% – 13.88%**, every route distinct — FRA→MUC 8.00%, NRT→ICN 8.64%, JFK→LHR 9.91%, DXB→BOM 11.02%, ATL→MCO 13.21%, DFW→LAX 13.86%, ORD→DFW 13.88%.

**Where it happens.** `/api/flight-request` resolves the flight's real route (dep/arr IATA) via the first-party airlabs proxy, estimates the route's risk (`web/lib/server/riskPricing.ts`), and returns a `premiumBps` alongside the quote. The `/cover` page shows it directly — _"Premium: 13.88% — 28% of recent flights on this route ran 30min+ late"_, with _"Based on 57 historical flights across 25 days on this route"_ underneath — instead of the old flat "Premium (10%)" label.

**The premium is bounded onchain, not just in the UI.** `buyCover` / `buyCoverWithFXRP` take `premiumBps` as an argument and require `MIN_PREMIUM_BPS (500) <= premiumBps <= MAX_PREMIUM_BPS (1500)`, so a malicious or buggy frontend cannot drive the premium to zero or to an extortionate value. The risk-adjusted premium is computed **first**, and is the USD amount that then gets converted to FXRP by the FTSO read in `previewFxrpPremium` — one premium, two payment assets, not two independent calculations.

### Why it doesn't just count 2h+ delays

The obvious estimator — _"what fraction of recent flights on this route ran 2h+ late"_ — was measured against real data and is close to useless at free-tier sample sizes.

Splitting each route's history by day and correlating one half against the other gives each statistic's **split-half reliability**: how much of its route-to-route variation is real signal rather than sampling noise. Measured over 30 routes / ~1,500 real flights:

| statistic                       | reliability                                   |
| ------------------------------- | --------------------------------------------- |
| severe (2h+/cancel) rate        | **0.11** — roughly 90% noise                  |
| p90 of non-severe delay minutes | 0.37                                          |
| moderate (30min+) rate          | **0.59** — the most reliable signal available |

The reason is visible in the raw data: **2h+ events are episodic weather shocks, not a stable property of a route.** Across those 30 routes, 51% of a route's severe events fell on its single worst day, and HKG→TPE had _all 16_ of its severe events on one day and zero on the other four. Pricing off that number mostly prices which storm happened to land inside the sample window. Confirming it: removing severe events from a route's mean delay drops the mean-delay/severe-rate correlation from 0.809 to **0.246** — the apparent relationship was mostly mechanical.

So the estimate is built primarily from the **moderate-delay signal**, converted to an expected 2h+ rate through relationships fitted on that same calibration set, with each component weighted by its measured reliability. Concretely:

- **Widen to the city pair.** The historical endpoint takes only a `flight_iata`, so the schedules endpoint supplies the other flights serving `dep→arr` and history is pulled for up to 40 of them — lifting n from ~10 to **~60–100** on busy routes.
- **Collapse codeshares.** `KL2501` / `DL5994` / `AF6753` / `VS4` can be one physical aircraft each reporting the same delay. Observations are deduped by (route, departure slot); without this JFK→LHR reports 150 "independent" observations that are really 45.
- **Drop flights with no known outcome**, so scheduled-but-not-yet-flown rows aren't miscounted as on-time.
- **Shrink by days, not flights.** Because severe events cluster by weather day, days are the real independent unit — and a day holding one flight isn't worth a day holding ten, so effective evidence is capped by both (`min(days, n/3)`). A 5-flight/5-day sample is pulled firmly back toward the base rate.
- **Price as a multiple of expected loss.** The premium is a fixed loading (≈1.79×) on the estimated payout probability, so every route pays the same multiple of _its own_ expected loss. That loading is derived, not hand-picked: it's the value that makes a route at the pooled base rate price at exactly the legacy flat 10%.

**This is a better estimator, not a wider dial.** Out-of-sample — fitting on half a route's days and predicting the severe rate on the other half — the new model tracks reality at **r = 0.193** versus **0.119** for the severe-count model it replaces. The spread widened _and_ the ordering got more accurate.

**Known constraints, stated plainly:**

- **The calibration constants are a single-window fit.** `BASE_SEVERE_RATE`, the two regression fits, and the reliability weights all come from 30 routes in one fixed multi-day window. They are not a multi-season model, and they are hardcoded in `riskPricing.ts` rather than refitted live.
- **Absolute skill is low.** r ≈ 0.19 out-of-sample is real but weak — it explains a few percent of variance. The model reliably separates chronically-congested routes from clean ones; it cannot predict which specific flight gets hit.
- **The historical window is fixed and stale.** The free tier returns the same few archived days regardless of `date_from`/`date_to`/`offset`/`page` (all verified as accepted-but-ignored), so this measures one past window, not current conditions.
- **The 2h+ rate shown in the UI is not the price driver.** It's displayed for transparency, but it is the least reliable number on the card — which is exactly why the price doesn't lean on it.
- **No seasonality or weather.** A production model would price by season, time of day, weather forecast, and aircraft rotation. This prices the route only.
- **Sub-cap pricing.** For a route with a genuinely high payout rate, the 15% cap would be below the actuarially fair premium — deliberate, since the cap's job here is to bound frontend trust.
- **Fallback is a first-class path.** If the sample is unavailable or smaller than 4 usable observations, the quote falls back to the documented flat **10%** (`FALLBACK_PREMIUM_BPS`) and the UI says so. This is exercised live — LGA→ORD currently has too little history and quotes the fallback.

---

## What was newly built during the program

**FlightGuard was built entirely during Flare Summer Signal — nothing predated the program.** Everything below is new work:

- Solidity contract: pooled liquidity with shares, cover policies, FDC-verified settlement, expiry, FXRP premiums _and_ FXRP payouts priced via FTSO, and onchain-bounded risk-based premiums.
- Bidirectional FXRP: `Policy.payoutInFxrp`, settlement-time FTSO conversion, an FXRP payout reserve with USDT0-neutral swap accounting, and a USDT0 fallback that keeps a claim payable even if the reserve or the oracle is unavailable.
- Route-risk premium pricing: a delay-rate estimator over live flight history, with codeshare dedup, small-sample shrinkage, and a documented flat-rate fallback.
- Multi-source settlement data: a primary/secondary resolver inside the attested proxy, with the source and whether it was corroborated carried in the attested payload and recorded onchain as `Policy.provenance`.
- 101-test Hardhat suite, including a regression test pinned to **real Coston2 proof bytes**, a real cancelled-flight response, premium-bound/pricing-math coverage, FXRP-payout tests asserting the settlement-time rate, pool neutrality and every fallback path, and provenance tests pinning that a data outage is distinguishable from an on-time flight.
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
             + payoutInFxrp  │      ▲ premium rate            ▲ payout rate
                             ▼      │                         │
                     FlightGuard.sol  ◄── USDT0 pool (backers earn premiums)
                             ▲        └── FXRP payout reserve ──► FXRP to traveler
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
   The quote card has two independent toggles: **Pay premium in** `USDT0 | FXRP` and **Receive payout in** `USDT0 | FXRP`. Switching the payout toggle to FXRP shows the live FTSO-converted payout estimate and the exact feed prices behind it, plus a note that the binding rate is the one read at settlement.
3. **My Policies** — see your cover and its status. The settled examples below (including flight **G58846**, delayed ~292 minutes, which **paid out automatically**) were settled on the [previous deployment](https://coston2-explorer.flare.network/address/0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63), before the contract was redeployed to add risk-based premiums — their transactions are still onchain and linked below, but they won't appear in this app's policy list, which reads the current contract. The settlement code itself is unchanged.
4. **Settlement receipts** — every settled policy has a public page (`/policy/[id]`, no wallet needed) linking the FDC voting round and settle transaction on the block explorer.
5. **Pool** — deposit USDT0 to back policies and earn premiums; withdraw free liquidity.
6. **Radar** — live flights delayed 2+ hours right now, as proof that these delays happen constantly.

Note: settlement runs against the **live FDC verifier** — a real attestation takes ~2–3 minutes (a voting round must finalize). The keeper settles delayed policies automatically; a manual "Settle" is also available.

---

## Onchain references (Coston2)

- **FlightGuard contract:** [`0x374F52c6cbe43f092453e95E4580016aD9ff5fc3`](https://coston2-explorer.flare.network/address/0x374F52c6cbe43f092453e95E4580016aD9ff5fc3) (verified)
- **FXRP token:** [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7)

**FTSO feed IDs** (bytes21, category `0x01` crypto + ASCII name):

- `XRP/USD`: `0x015852502f55534400000000000000000000000000`
- `USDT/USD`: `0x01555344542f555344000000000000000000000000`

**Settlement transactions** — all real, no mocks. These ran on the [previous deployment](https://coston2-explorer.flare.network/address/0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63) (`0xee52694D…e6A63`), before the redeploy that added risk-based premiums; the `settle()` / FDC / FTSO code paths they exercise are byte-for-byte unchanged in the current contract:

- **`settle()` → PAID OUT** — real FDC attestation of flight **G58846** (landed **292 min** late), policy paid the cover amount automatically: [`0xefab3688…d9cf`](https://coston2-explorer.flare.network/tx/0xefab368802f9d55b246b9ff68549eb87c975064630ca574fb641780cd9b1d9cf)
- `settle()` → NoPayout — real FDC attestation of an on-time flight (correctly pays nothing): [`0xfa4206f1…2cf79f`](https://coston2-explorer.flare.network/tx/0xfa4206f1c4687720e1c731565ba5a4960f2d38c19acb5f88c3cf3434ee2cf79f)
- `buyCoverWithFXRP()` — real FTSO read + real FXRP transfer: [`0xc7b8fc5d…91c152`](https://coston2-explorer.flare.network/tx/0xc7b8fc5dbbc09b2770ea61a254de697072ace9b32bcbda26c4bc509f0f91c152)

**Settlement provenance, proven live end-to-end** (current deployment `0x374F52c6…5fc3`). One run of `scripts/flightguard/provenanceE2E.ts` against flight **OH5026** on 2026-08-07 — a flight that airlabs records as having landed **942 minutes late**, i.e. one that should pay out:

- **`settle()` → NoPayout, recorded as `DataUnavailable`**: [`0x0079943c…e690`](https://coston2-explorer.flare.network/tx/0x0079943c5fde094f431eac62637c7429dd08753fbfaffbe2a4d44eefd854e690)

The attested DTO came back `flightStatus: "EMPTY", delayMinutes: 0, source: "none", corroborated: false`, and `SettlementEvidence(policyId, 3, "none")` was emitted. The reason is worth stating exactly: the deployed proxy at the time of the run predates the multi-source resolver, so it returned no `.resolved` block, every jq field fell through to its safe default, and the contract settled on absence of data. **A genuinely delayed flight was denied because of a data gap — and that is now visible onchain instead of being indistinguishable from an on-time arrival.** It also demonstrates the degradation property end to end: a stale or broken data path can only ever produce "no data", never a spurious payout.

That first one was self-inflicted — the contract shipped ahead of the app. Here is the same flag firing on an **organic** data gap, with the resolver fully deployed: flight **SQ23** had simply rolled out of the upstream's record by the time it was settled, since the free tier only exposes a flight's most recent instance.

- **`settle()` → NoPayout, `DataUnavailable`, organic outage**: [`0x06f9a8f0…3ade`](https://coston2-explorer.flare.network/tx/0x06f9a8f08d3e043af8043b41b0a0500626d6bc642c9c50348d425bdc982a3ade)

Both are the honest outcome: no source could say what happened to the flight, so nothing was paid — and the contract records _that_, rather than letting it read as a confirmed on-time arrival.

**FXRP payout on the current deployment** (`0x374F52c6…5fc3`). `scripts/flightguard/fxrpPayoutE2E.ts` picked flight **AF5694** off the live delay feed — landed **620 minutes** late — bought cover with `payoutInFxrp = true`, ran the full FDC attestation cycle, and settled:

- **`settle()` → PAID OUT IN FXRP** — **1.927243 FXRP** delivered, **0 USDT0**, at XRP/USD **$1.037023** read inside that transaction: [`0xca60eeab…fa4e`](https://coston2-explorer.flare.network/tx/0xca60eeabc2bedfda07bbba4e204992b300bd98348624ba56217959c166acfa4e)

The same policy also carries `provenance = SingleSource, source = "airlabs"` — one settlement demonstrating both upgrades at once. A second FXRP payout, run manually against an existing policy with `scripts/flightguard/settlePolicy.ts`, paid **1.928902 FXRP** on flight **U6322** (landed 573 min late): [`0xd19cc8e6…075e`](https://coston2-explorer.flare.network/tx/0xd19cc8e6088f48e3c41f9f4bcc47ff121ff55d74bd18bccd79b07d3bcd5f075e)

**The first FXRP payout** ran earlier on the [superseded deployment](https://coston2-explorer.flare.network/address/0x92619A6687681CF59E9f6896b656Ac30b9f25b1B) (`0x92619A66…5b1B`), before the provenance redeploy; the FXRP payout path is unchanged since. It picked **OH5026**, landed **942 minutes** late, bought cover with `payoutInFxrp = true`, and settled:

- `buyCover(..., payoutInFxrp: true)` — 2 USDT0 of cover, policy stores `payoutInFxrp = true`: [`0x56c78f23…1f53d`](https://coston2-explorer.flare.network/tx/0x56c78f23cfdcc71bbd930a949ea6f251f4be2ff7de5a72b78c55e6ac6751f53d)
- **`settle()` → PAID OUT IN FXRP** — real FDC proof (`flightStatus: landed`, `delayMinutes: 942`), real FTSO read inside the settlement tx, **1.918053 FXRP** delivered to the traveler's wallet and **0 USDT0**: [`0xa6ebe8e2…7a9c`](https://coston2-explorer.flare.network/tx/0xa6ebe8e2c480d0baf71d6018340a3decd2ae4db6e8d21c82aeaca715bed37a9c)
- `fundFxrpPayoutReserve(5 FXRP)` — the reserve the payout came out of: [`0x7990f43f…b8c7`](https://coston2-explorer.flare.network/tx/0x7990f43f55af48cd460802650ca2dcd15aac3261ae2db34ef0992b6ab1dab8c7)

The settlement paid at **XRP/USD $1.041926 / USDT/USD $0.999235**, the rates read in that transaction — against **$1.0427** quoted a few minutes earlier at purchase, which is why the amount paid (1.918053 FXRP) differs from the purchase-time estimate (1.916888 FXRP). Same transaction: `fxrpPayoutReserve` fell by exactly the FXRP paid, `usdt0SwapProceeds` absorbed the 2 USDT0 of cover, and `poolBalance()` fell by exactly 2 USDT0 — identical to what a USDT0 payout would have done to the pool. Reproduce with `npx hardhat run scripts/flightguard/fxrpPayoutE2E.ts --network coston2` (it discovers a currently-qualifying flight itself and asserts every one of those invariants).

**Risk-based premium, proven live.** Both buys are for **EK504 DXB→BOM**, whose route history returned 2 of 28 recent flights over the 2h+/cancel trigger — quoted at **929 bps (9.29%)**, not the flat 1000. These ran on the [previous deployment](https://coston2-explorer.flare.network/address/0x1126B59a867f44329de68b63d376305d3AF877a1) (`0x1126B59a…877a1`), before the redeploy that added the FXRP payout option; the pricing path they exercise is unchanged in the current contract:

- `buyCover()` at a risk-adjusted premium — policy stores `premiumBps = 929`: [`0x88dceb25…03f350`](https://coston2-explorer.flare.network/tx/0x88dceb25f7d7adbf8969000072fec1a8156753bf824dbbdef9d51e717903f350)
- `buyCoverWithFXRP()` at the **same** 929 bps — the risk-adjusted USD premium (0.0929 USDT0) converted through the live FTSO read to 0.085882 FXRP, proving the risk step runs _before_ the FXRP conversion: [`0x6c24f1b2…89540d`](https://coston2-explorer.flare.network/tx/0x6c24f1b268049a9d0b0508628b2553da8afb8325c8590b36d81472c92989540d)

Reproduce either with `scripts/flightguard/buyRiskPricedPolicy.ts` or `scripts/flightguard/buyCoverWithFXRP.ts` — both quote the route live rather than hardcoding a premium.

Both payout outcomes are proven onchain: a delayed flight pays automatically, an on-time flight does not — settlement is driven purely by attested flight data, not discretion.

---

## Running locally

```bash
# contracts
yarn install
npx hardhat test          # 101 tests
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

- **Single trusted aggregator.** The proxy now resolves across a primary and an optional secondary source (see [Data sources, and the single-source risk](#data-sources-and-the-single-source-risk)), and every settlement records onchain which source answered and whether anything corroborated it. That buys availability, not integrity — FDC attests what the proxy returned, so the proxy remains trusted. Production would cross-check two independently attested URLs.
- **Thin risk-pricing data.** Premiums are risk-based (see [Risk-based premium pricing](#risk-based-premium-pricing)) and currently span 8.00–13.88% across real routes, but the free API tier caps history at 5 instances per flight over a fixed archived window. Widening to sibling flights on the same city pair lifts n to ~60–100, yet out-of-sample skill is still only r ≈ 0.19 — enough to separate chronically-congested routes from clean ones, not to predict individual flights. Estimates are shrunk toward the base rate by how many days the sample covers, and fall back to a flat 10% when a route has too little history. Production would use a paid multi-season feed and price seasonality and weather too.
- **Correlated pool risk.** One storm can delay many covered flights at once; production needs exposure caps and reinsurance-style tranching.
- **Keeper cadence.** On Vercel Hobby the keeper cron runs daily; production would use Vercel Pro (sub-hourly) or an external scheduler. The keeper endpoint is also manually triggerable.
- **Settler gas.** A server wallet pays FDC attestation fees today; production would use a relayer or user-funded attestation.
- **FXRP payout reserve is owner-funded.** FXRP payouts are funded from a reserve the contract owner tops up (and reclaims the matching USDT0 from), which is what keeps backers out of FX risk — but it means FXRP payout capacity is capped by that reserve rather than scaling with the pool, and the owner carries the XRP/USD move on the swap. Production would either market-make the reserve or route the swap through an FAssets-aware DEX. A short reserve degrades gracefully: the claim pays in USDT0.
- **Testnet.** Coston2 only, pending FAssets/mainnet availability.

**Next steps:** two independently attested data URLs cross-checked onchain (real multi-source integrity, not just availability), a decision on whether a `DataUnavailable` settlement should be retryable inside the claim window rather than final, a paid multi-season delay feed to replace the free tier's thin route samples, an automatically replenished FXRP payout reserve, FDC KV persistence for the keeper on serverless, and real user pilots.

---

## Deployment status

Deployed on **Coston2** (contract, verified at `0x374F52c6…5fc3`) and **Vercel** (app).

> **Deploy the app and the contract together.** The attested request scheme changed with the provenance DTO, so a frontend/proxy older than the contract makes every settlement resolve to `DataUnavailable` (safely — never a spurious payout — but no claim pays). The live `DataUnavailable` run linked above is exactly that state, captured deliberately. The core settlement flow is proven end-to-end against the **live FDC verifier** — a real delayed flight was attested onchain and paid out automatically, and an on-time flight correctly paid nothing. Not mocked. Deposit, withdraw (with locked-liquidity guard), USDT0 and FXRP premium payment, **FXRP payout at the settlement-time FTSO rate**, and autonomous keeper settlement are all verified onchain.

The contract was redeployed to add the FXRP payout option (and before that, onchain-bounded risk-based premiums). The FDC settlement path is unchanged across those redeploys, so the settlement proofs on prior addresses still describe the code running today; the FXRP payout is separately proven on the **current** deployment by the live end-to-end run linked above.
