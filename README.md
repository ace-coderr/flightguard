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
2. **Travelers** buy cover for a specific flight and date, paying a 10% premium — in USDT0, or in FXRP priced live via FTSO.
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

## What was newly built during the program

**FlightGuard was built entirely during Flare Summer Signal — nothing predated the program.** Everything below is new work:

- Solidity contract: pooled liquidity with shares, cover policies, FDC-verified settlement, expiry, and FXRP-premium pricing via FTSO.
- 31-test Hardhat suite, including a regression test pinned to **real Coston2 proof bytes** and a real cancelled-flight response.
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

## Onchain references (Coston2)

- **FlightGuard contract:** [`0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63`](https://coston2-explorer.flare.network/address/0xee52694D2C324C03e8AC4490C9675b3bFdFe6A63)
- **FXRP token:** [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7)

**FTSO feed IDs** (bytes21, category `0x01` crypto + ASCII name):
- `XRP/USD`: `0x015852502f55534400000000000000000000000000`
- `USDT/USD`: `0x01555344542f555344000000000000000000000000`

**Live transactions** (same deployment, all real — no mocks):
- **`settle()` → PAID OUT** — real FDC attestation of flight **G58846** (landed **292 min** late), policy paid the cover amount automatically: [`0xefab3688…d9cf`](https://coston2-explorer.flare.network/tx/0xefab368802f9d55b246b9ff68549eb87c975064630ca574fb641780cd9b1d9cf)
- `settle()` → NoPayout — real FDC attestation of an on-time flight (correctly pays nothing): [`0xfa4206f1…2cf79f`](https://coston2-explorer.flare.network/tx/0xfa4206f1c4687720e1c731565ba5a4960f2d38c19acb5f88c3cf3434ee2cf79f)
- `buyCoverWithFXRP()` — real FTSO read + real FXRP transfer: [`0xc7b8fc5d…91c152`](https://coston2-explorer.flare.network/tx/0xc7b8fc5dbbc09b2770ea61a254de697072ace9b32bcbda26c4bc509f0f91c152)

Both payout outcomes are proven onchain: a delayed flight pays automatically, an on-time flight does not — settlement is driven purely by attested flight data, not discretion.

---

## Running locally

```bash
# contracts
yarn install
npx hardhat test          # 31 tests
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
- **Flat 10% premium.** No risk-based pricing yet; a delay-history model would price by route/season.
- **Correlated pool risk.** One storm can delay many covered flights at once; production needs exposure caps and reinsurance-style tranching.
- **Keeper cadence.** On Vercel Hobby the keeper cron runs daily; production would use Vercel Pro (sub-hourly) or an external scheduler. The keeper endpoint is also manually triggerable.
- **Settler gas.** A server wallet pays FDC attestation fees today; production would use a relayer or user-funded attestation.
- **Testnet.** Coston2 only, pending FAssets/mainnet availability.

**Next steps:** FXRP payout option (not just premium), multi-source attestation, risk-based premiums, FDC KV persistence for the keeper on serverless, and real user pilots.

---

## Deployment status

Deployed on **Coston2** (contract, verified) and **Vercel** (app). The core settlement flow is proven end-to-end against the **live FDC verifier** — a real delayed flight (G58846, 292 min) was attested onchain and paid out automatically, and an on-time flight correctly paid nothing. Not mocked. Deposit, withdraw (with locked-liquidity guard), USDT0 and FXRP premium payment, and autonomous keeper settlement are all verified onchain.
