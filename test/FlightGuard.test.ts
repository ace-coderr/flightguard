import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Generic (non-secret) stand-in for the real request built by
// scripts/fdc-attest-flight.ts's buildFlightRequestBody - same shape, no API key.
// postProcessJq mirrors buildPostProcessJq's date-lock (keyed on the proxy's resolved
// departure date, matching FLIGHT_REF's "2026-07-10" below).
const DTO_TUPLE = "tuple(string flightStatus, uint256 delayMinutes, string source, bool corroborated)";
const DATE_LOCK = `(.resolved.date // "") == "2026-07-10"`;
const REQUEST = {
    url: "https://airlabs.co/api/v9/flight",
    headers: "{}",
    queryParams: JSON.stringify({ flight_iata: "BA75" }),
    postProcessJq:
        `{flightStatus: (if ${DATE_LOCK} then (.resolved.flightStatus // "EMPTY") else "EMPTY" end), ` +
        `delayMinutes: (if ${DATE_LOCK} then (.resolved.delayMinutes // 0) else 0 end), ` +
        `source: (if ${DATE_LOCK} then (.resolved.source // "none") else "none" end), ` +
        `corroborated: (if ${DATE_LOCK} then (.resolved.corroborated // false) else false end)}`,
    abiSignature: `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"},{"internalType":"string","name":"source","type":"string"},{"internalType":"bool","name":"corroborated","type":"bool"}],"name":"dto","type":"tuple"}`,
};

enum Provenance {
    Unsettled = 0,
    Corroborated = 1,
    SingleSource = 2,
    DataUnavailable = 3,
}

// Mirrors FlightGuard.sol's requestHash formula exactly (and scripts/fdc-attest-flight.ts's
// computeRequestHash): keccak256(abi.encode(url, headers, queryParams, postProcessJq, abiSignature)).
function computeRequestHash(req: typeof REQUEST = REQUEST) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "string", "string", "string"],
            [req.url, req.headers, req.queryParams, req.postProcessJq, req.abiSignature]
        )
    );
}

// abiSignature declares a single "dto" tuple, so this must encode as ONE wrapped tuple
// value (matching FlightDto), not four flat params.
function encodeDto(flightStatus: string, delayMinutes: number | bigint, source = "airlabs", corroborated = false) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
        [DTO_TUPLE],
        [{ flightStatus, delayMinutes, source, corroborated }]
    );
}

function buildProof(
    overrides: {
        flightStatus?: string;
        delayMinutes?: number | bigint;
        source?: string;
        corroborated?: boolean;
        req?: typeof REQUEST;
        abiEncodedData?: string;
    } = {}
) {
    const req = overrides.req ?? REQUEST;
    const abiEncodedData =
        overrides.abiEncodedData ??
        encodeDto(
            overrides.flightStatus ?? "scheduled",
            overrides.delayMinutes ?? 0,
            overrides.source ?? "airlabs",
            overrides.corroborated ?? false
        );
    return {
        merkleProof: [] as string[],
        data: {
            attestationType: ethers.ZeroHash,
            sourceId: ethers.ZeroHash,
            votingRound: 0,
            lowestUsedTimestamp: 0,
            requestBody: {
                url: req.url,
                httpMethod: "GET",
                headers: req.headers,
                queryParams: req.queryParams,
                body: "{}",
                postProcessJq: req.postProcessJq,
                abiSignature: req.abiSignature,
            },
            responseBody: { abiEncodedData },
        },
    };
}

// Default mock FTSO prices: XRP ~$1.10, USDT ~$0.999 (close to real Coston2 values seen
// live), both 18-decimal-normalized like the real getFeedByIdInWei.
const XRP_USD_PRICE_WEI = ethers.parseUnits("1.10", 18);
const USDT_USD_PRICE_WEI = ethers.parseUnits("0.999", 18);
const FALLBACK_PREMIUM_BPS = 1000n;
const RISK_PREMIUM_BPS = 1200n;

async function deployFixture() {
    const [owner, backer, backer2, traveler, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDT0", "mUSDT0", 6);
    const fxrp = await MockERC20.deploy("Mock FXRP", "mFXRP", 6);

    const MockFdcVerification = await ethers.getContractFactory("MockFdcVerification");
    const verifier = await MockFdcVerification.deploy();

    const MockFtsoV2 = await ethers.getContractFactory("MockFtsoV2");
    const ftso = await MockFtsoV2.deploy();

    const FlightGuard = await ethers.getContractFactory("FlightGuard");
    const flightGuard = await FlightGuard.deploy(
        await token.getAddress(),
        await verifier.getAddress(),
        await ftso.getAddress(),
        await fxrp.getAddress()
    );

    const [fxrpFeedId, usdtFeedId] = await Promise.all([
        flightGuard.FXRP_PROXY_FEED_ID(),
        flightGuard.USDT0_PROXY_FEED_ID(),
    ]);
    await ftso.setPriceWei(fxrpFeedId, XRP_USD_PRICE_WEI);
    await ftso.setPriceWei(usdtFeedId, USDT_USD_PRICE_WEI);

    const mintAmount = ethers.parseUnits("10000", 6);
    const fxrpMintAmount = ethers.parseUnits("1000", 6);
    // owner included: it's the account that funds the FXRP payout reserve.
    for (const s of [owner, backer, backer2, traveler, other]) {
        await token.mint(s.address, mintAmount);
        await token.connect(s).approve(await flightGuard.getAddress(), ethers.MaxUint256);
        await fxrp.mint(s.address, fxrpMintAmount);
        await fxrp.connect(s).approve(await flightGuard.getAddress(), ethers.MaxUint256);
    }

    return { owner, backer, backer2, traveler, other, token, fxrp, verifier, ftso, flightGuard };
}

const FLIGHT_REF = "BA75|2026-07-10";

// Buys cover on REQUEST (or a custom request) and returns the resulting policyId +
// scheduledArrival, leaving the policy Active and ready to settle/expire.
async function buyActivePolicy(
    flightGuard: any,
    traveler: any,
    coverAmount = ethers.parseUnits("40", 6),
    req: typeof REQUEST = REQUEST,
    flightRef: string = FLIGHT_REF,
    payoutInFxrp = false
) {
    const scheduledArrival = (await time.latest()) + 3600;
    const requestHash = computeRequestHash(req);
    await flightGuard
        .connect(traveler)
        .buyCover(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, requestHash, flightRef, payoutInFxrp);
    const policyId = (await flightGuard.policyCount()) - 1n;
    return { policyId, scheduledArrival, requestHash, coverAmount, flightRef };
}

// FXRP the contract will hand over for `usdt0Amount` of cover at the given (mock) FTSO
// rates. Deliberately written out here rather than read back from the contract, so the
// expected payout is independently derived: USDT0 value -> USD via USDT/USD -> XRP via
// XRP/USD. FXRP and USDT0 both have 6 decimals, so the scale factors cancel.
function expectedFxrpFor(usdt0Amount: bigint, xrpPriceWei = XRP_USD_PRICE_WEI, usdtPriceWei = USDT_USD_PRICE_WEI) {
    return (usdt0Amount * usdtPriceWei) / xrpPriceWei;
}

describe("FlightGuard", () => {
    describe("deposit / withdraw", () => {
        it("mints shares 1:1 on the first deposit", async () => {
            const { flightGuard, backer } = await loadFixture(deployFixture);
            const amount = ethers.parseUnits("100", 6);

            await expect(flightGuard.connect(backer).deposit(amount))
                .to.emit(flightGuard, "Deposited")
                .withArgs(backer.address, amount, amount);

            expect(await flightGuard.shares(backer.address)).to.equal(amount);
            expect(await flightGuard.totalShares()).to.equal(amount);
        });

        it("mints proportional shares on a second deposit at the same price", async () => {
            const { flightGuard, backer, backer2 } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            await flightGuard.connect(backer2).deposit(ethers.parseUnits("50", 6));

            expect(await flightGuard.shares(backer2.address)).to.equal(ethers.parseUnits("50", 6));
            expect(await flightGuard.totalShares()).to.equal(ethers.parseUnits("150", 6));
        });

        it("prices new shares off pool balance, so premium accrual raises price per share", async () => {
            const { flightGuard, backer, backer2, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            // premium = 50 * 1000bps/10000 = 5 USDT0, accrues to pool without minting shares
            await buyActivePolicy(flightGuard, traveler, ethers.parseUnits("50", 6));

            const totalSharesBefore = await flightGuard.totalShares();
            const poolBalanceBefore = await flightGuard.poolBalance();
            const depositAmount = ethers.parseUnits("21", 6);
            const expectedMinted = (depositAmount * totalSharesBefore) / poolBalanceBefore;

            await flightGuard.connect(backer2).deposit(depositAmount);

            expect(await flightGuard.shares(backer2.address)).to.equal(expectedMinted);
            expect(expectedMinted).to.be.lessThan(depositAmount);
        });

        it("burns shares and returns a proportional amount on withdraw", async () => {
            const { flightGuard, token, backer } = await loadFixture(deployFixture);
            const depositAmount = ethers.parseUnits("100", 6);
            await flightGuard.connect(backer).deposit(depositAmount);

            await expect(flightGuard.connect(backer).withdraw(depositAmount)).to.changeTokenBalance(
                token,
                backer,
                depositAmount
            );
            expect(await flightGuard.shares(backer.address)).to.equal(0n);
            expect(await flightGuard.totalShares()).to.equal(0n);
        });

        it("reverts withdraw for more shares than the caller owns", async () => {
            const { flightGuard, backer } = await loadFixture(deployFixture);
            await expect(flightGuard.connect(backer).withdraw(1)).to.be.revertedWith("bad shares");
        });

        it("reverts withdraw beyond free liquidity when funds are locked", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            await buyActivePolicy(flightGuard, traveler, ethers.parseUnits("90", 6));

            await expect(flightGuard.connect(backer).withdraw(ethers.parseUnits("100", 6))).to.be.revertedWith(
                "liquidity locked"
            );
        });
    });

    describe("buyCover", () => {
        it("locks coverAmount and charges the premium", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));

            const coverAmount = ethers.parseUnits("40", 6);
            const premiumBps = await flightGuard.FALLBACK_PREMIUM_BPS();
            const premium = (coverAmount * premiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(coverAmount, premiumBps, scheduledArrival, requestHash, FLIGHT_REF, false)
            )
                .to.emit(flightGuard, "CoverBought")
                .withArgs(0n, traveler.address, coverAmount, premium, premiumBps, requestHash, FLIGHT_REF, false);

            expect(await flightGuard.totalLocked()).to.equal(coverAmount);
            const policy = await flightGuard.policies(0n);
            expect(policy.holder).to.equal(traveler.address);
            expect(policy.coverAmount).to.equal(coverAmount);
            expect(policy.premium).to.equal(premium);
            expect(policy.premiumBps).to.equal(premiumBps);
            expect(policy.flightRef).to.equal(FLIGHT_REF);
            expect(policy.status).to.equal(0n); // Active
            expect(policy.payoutInFxrp).to.equal(false); // default: pay out in USDT0
        });

        it("stores flightRef in the policy and emits it in CoverBought", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const coverAmount = ethers.parseUnits("25", 6);
            const premiumBps = RISK_PREMIUM_BPS;
            const premium = (coverAmount * premiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();
            const flightRef = "KL1631|2026-08-01";

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(coverAmount, premiumBps, scheduledArrival, requestHash, flightRef, false)
            )
                .to.emit(flightGuard, "CoverBought")
                .withArgs(0n, traveler.address, coverAmount, premium, premiumBps, requestHash, flightRef, false);

            const policy = await flightGuard.policies(0n);
            expect(policy.flightRef).to.equal(flightRef);
            expect(policy.premiumBps).to.equal(premiumBps);
        });

        it("reverts when coverAmount is zero", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(0, FALLBACK_PREMIUM_BPS, scheduledArrival, computeRequestHash(), FLIGHT_REF, false)
            ).to.be.revertedWith("cover out of range");
        });

        it("reverts when coverAmount exceeds MAX_COVER", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            const maxCover = await flightGuard.MAX_COVER();
            await flightGuard.connect(backer).deposit(maxCover * 2n);
            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(
                        maxCover + 1n,
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("cover out of range");
        });

        it("reverts when scheduledArrival is not in the future", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const pastArrival = (await time.latest()) - 10;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(
                        ethers.parseUnits("10", 6),
                        FALLBACK_PREMIUM_BPS,
                        pastArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("flight in past");
        });

        it("reverts when coverAmount exceeds free liquidity", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("10", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(
                        ethers.parseUnits("11", 6),
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("insufficient pool");
        });

        it("reverts when premiumBps is below the onchain minimum", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            const minPremiumBps = await flightGuard.MIN_PREMIUM_BPS();

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(
                        ethers.parseUnits("10", 6),
                        Number(minPremiumBps) - 1,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("premium out of range");
        });

        it("reverts when premiumBps is above the onchain maximum", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            const maxPremiumBps = await flightGuard.MAX_PREMIUM_BPS();

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(
                        ethers.parseUnits("10", 6),
                        Number(maxPremiumBps) + 1,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("premium out of range");
        });

        it("keeps the 10% flat-fee fallback path available when risk data is unavailable", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const coverAmount = ethers.parseUnits("40", 6);
            const fallbackPremiumBps = await flightGuard.FALLBACK_PREMIUM_BPS();
            const expectedPremium = (coverAmount * fallbackPremiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;

            await flightGuard
                .connect(traveler)
                .buyCover(coverAmount, fallbackPremiumBps, scheduledArrival, computeRequestHash(), FLIGHT_REF, false);

            const policy = await flightGuard.policies(0n);
            expect(policy.premium).to.equal(expectedPremium);
            expect(policy.premiumBps).to.equal(fallbackPremiumBps);
        });
    });

    describe("buyCoverWithFXRP", () => {
        // Hand-computed against the fixture's mock prices (XRP $1.10, USDT $0.999) so the
        // exact expected fxrpAmount is independently verified, not just re-derived from the
        // contract's own formula.
        function expectedFxrpAmount(
            coverAmount: bigint,
            premiumBps: bigint = FALLBACK_PREMIUM_BPS,
            xrpPriceWei = XRP_USD_PRICE_WEI,
            usdtPriceWei = USDT_USD_PRICE_WEI
        ) {
            const premiumUsdt0 = (coverAmount * premiumBps) / 10_000n;
            return (premiumUsdt0 * usdtPriceWei) / xrpPriceWei; // FXRP_DECIMALS == USDT0_DECIMALS (6), so they cancel
        }

        it("converts the USDT0 premium to FXRP at the mock FTSO rate and transfers it", async () => {
            const { flightGuard, backer, traveler, fxrp } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));

            const coverAmount = ethers.parseUnits("40", 6);
            const premiumBps = RISK_PREMIUM_BPS;
            const premiumUsdt0 = (coverAmount * premiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();
            const expectedFxrp = expectedFxrpAmount(coverAmount, premiumBps);

            const travelerFxrpBefore = await fxrp.balanceOf(traveler.address);
            const contractFxrpBefore = await fxrp.balanceOf(await flightGuard.getAddress());

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(coverAmount, premiumBps, scheduledArrival, requestHash, FLIGHT_REF, false)
            )
                .to.emit(flightGuard, "CoverBoughtWithFXRP")
                .withArgs(
                    0n,
                    traveler.address,
                    coverAmount,
                    premiumUsdt0,
                    premiumBps,
                    expectedFxrp,
                    XRP_USD_PRICE_WEI,
                    USDT_USD_PRICE_WEI,
                    false
                );

            expect(await fxrp.balanceOf(traveler.address)).to.equal(travelerFxrpBefore - expectedFxrp);
            expect(await fxrp.balanceOf(await flightGuard.getAddress())).to.equal(contractFxrpBefore + expectedFxrp);
            expect(await flightGuard.fxrpPremiums()).to.equal(expectedFxrp);

            // Cover is still locked from the USDT0 pool exactly like buyCover - the FXRP
            // premium never touches poolBalance/totalLocked/freeLiquidity.
            expect(await flightGuard.totalLocked()).to.equal(coverAmount);

            const policy = await flightGuard.policies(0n);
            expect(policy.holder).to.equal(traveler.address);
            expect(policy.coverAmount).to.equal(coverAmount);
            expect(policy.premium).to.equal(premiumUsdt0); // stored as the USDT0-equivalent, not the FXRP amount
            expect(policy.premiumBps).to.equal(premiumBps);
            expect(policy.status).to.equal(0n); // Active
            expect(policy.premiumInFxrp).to.equal(true);
            // Paying in FXRP does not imply being paid out in FXRP - the two directions are
            // independent choices.
            expect(policy.payoutInFxrp).to.equal(false);
        });

        it("previewFxrpPremium quotes the same amount buyCoverWithFXRP charges", async () => {
            const { flightGuard, traveler } = await loadFixture(deployFixture);
            const coverAmount = ethers.parseUnits("40", 6);
            const [premiumUsdt0Equivalent, fxrpAmount, xrpUsdPriceWei, usdtUsdPriceWei] = await flightGuard
                .connect(traveler)
                .previewFxrpPremium.staticCall(coverAmount, RISK_PREMIUM_BPS);

            expect(premiumUsdt0Equivalent).to.equal((coverAmount * RISK_PREMIUM_BPS) / 10_000n);
            expect(fxrpAmount).to.equal(expectedFxrpAmount(coverAmount, RISK_PREMIUM_BPS));
            expect(xrpUsdPriceWei).to.equal(XRP_USD_PRICE_WEI);
            expect(usdtUsdPriceWei).to.equal(USDT_USD_PRICE_WEI);
        });

        it("reflects a moved FTSO price immediately (no caching)", async () => {
            const { flightGuard, backer, traveler, ftso } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));

            const doubledXrpPrice = XRP_USD_PRICE_WEI * 2n;
            const fxrpFeedId = await flightGuard.FXRP_PROXY_FEED_ID();
            await ftso.setPriceWei(fxrpFeedId, doubledXrpPrice);

            const coverAmount = ethers.parseUnits("40", 6);
            const scheduledArrival = (await time.latest()) + 3600;
            const expectedFxrp = expectedFxrpAmount(coverAmount, FALLBACK_PREMIUM_BPS, doubledXrpPrice);

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        coverAmount,
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            )
                .to.emit(flightGuard, "CoverBoughtWithFXRP")
                .withArgs(
                    0n,
                    traveler.address,
                    coverAmount,
                    (coverAmount * 1000n) / 10_000n,
                    FALLBACK_PREMIUM_BPS,
                    expectedFxrp,
                    doubledXrpPrice,
                    USDT_USD_PRICE_WEI,
                    false
                );

            // Doubling XRP's price should have halved the FXRP the premium costs.
            expect(expectedFxrp).to.equal(expectedFxrpAmount(coverAmount) / 2n);
        });

        it("reverts like buyCover on out-of-range cover/timing/liquidity, before touching FXRP", async () => {
            const { flightGuard, backer, traveler, fxrp } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            const travelerFxrpBefore = await fxrp.balanceOf(traveler.address);

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        0,
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("cover out of range");

            const pastArrival = (await time.latest()) - 10;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        ethers.parseUnits("10", 6),
                        FALLBACK_PREMIUM_BPS,
                        pastArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("flight in past");

            expect(await fxrp.balanceOf(traveler.address)).to.equal(travelerFxrpBefore);
        });

        it("reverts buyCoverWithFXRP when premiumBps is outside the onchain bounds", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            const minPremiumBps = await flightGuard.MIN_PREMIUM_BPS();
            const maxPremiumBps = await flightGuard.MAX_PREMIUM_BPS();

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        ethers.parseUnits("10", 6),
                        Number(minPremiumBps) - 1,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("premium out of range");

            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        ethers.parseUnits("10", 6),
                        Number(maxPremiumBps) + 1,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("premium out of range");
        });

        it("reverts if a stale/zero FTSO price is returned", async () => {
            const { flightGuard, backer, traveler, ftso } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const fxrpFeedId = await flightGuard.FXRP_PROXY_FEED_ID();
            await ftso.setPriceWei(fxrpFeedId, 0n);

            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCoverWithFXRP(
                        ethers.parseUnits("10", 6),
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    )
            ).to.be.revertedWith("bad FTSO price");
        });

        it("settles an FXRP-premium policy exactly like a USDT0-premium one - payout still comes from the USDT0 pool", async () => {
            const { flightGuard, backer, traveler, token } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));

            const coverAmount = ethers.parseUnits("40", 6);
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();
            await flightGuard
                .connect(traveler)
                .buyCoverWithFXRP(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, requestHash, FLIGHT_REF, false);

            await time.increaseTo(scheduledArrival);
            const holderBalanceBefore = await token.balanceOf(traveler.address);

            await flightGuard.settle(0n, buildProof({ flightStatus: "cancelled", delayMinutes: 0 }));

            expect(await token.balanceOf(traveler.address)).to.equal(holderBalanceBefore + coverAmount);
            const policy = await flightGuard.policies(0n);
            expect(policy.status).to.equal(1n); // PaidOut
        });
    });

    describe("buyCover vs buyCoverWithFXRP requestHash parity", () => {
        // Regression for a bug where scripts/flightguard/buyCoverWithFXRP.ts computed a
        // throwaway requestHash unrelated to the flight request, instead of reusing
        // buildFlightRequestBody/computeRequestHash like buyCover's callers do - leaving
        // FXRP-bought policies permanently unsettleable ("requestHash matches neither
        // current nor legacy scheme"). Both paths must hash the same (url, headers,
        // queryParams, postProcessJq, abiSignature) tuple for the same flight+date, and
        // both must settle off that one requestHash.
        it("computes an identical requestHash for the same flight+date on both paths, and both settle", async () => {
            const { flightGuard, backer, traveler, token } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("200", 6));

            const coverAmount = ethers.parseUnits("40", 6);
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash(); // same REQUEST (same flight+date) for both paths

            await flightGuard
                .connect(traveler)
                .buyCover(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, requestHash, FLIGHT_REF, false);
            const usdt0PolicyId = (await flightGuard.policyCount()) - 1n;

            await flightGuard
                .connect(traveler)
                .buyCoverWithFXRP(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, requestHash, FLIGHT_REF, false);
            const fxrpPolicyId = (await flightGuard.policyCount()) - 1n;

            expect((await flightGuard.policies(usdt0PolicyId)).requestHash).to.equal(
                (await flightGuard.policies(fxrpPolicyId)).requestHash
            );

            await time.increaseTo(scheduledArrival);
            const proof = buildProof({ flightStatus: "cancelled", delayMinutes: 0 });

            await expect(flightGuard.settle(usdt0PolicyId, proof)).to.changeTokenBalance(token, traveler, coverAmount);
            await expect(flightGuard.settle(fxrpPolicyId, proof)).to.changeTokenBalance(token, traveler, coverAmount);

            expect((await flightGuard.policies(usdt0PolicyId)).status).to.equal(1n); // PaidOut
            expect((await flightGuard.policies(fxrpPolicyId)).status).to.equal(1n); // PaidOut
        });
    });

    describe("FXRP payout (payoutInFxrp)", () => {
        const COVER = ethers.parseUnits("40", 6);
        const RESERVE = ethers.parseUnits("500", 6);

        // Pool + funded FXRP payout reserve, ready for a policy to be bought and settled.
        async function fundedFixture() {
            const f = await loadFixture(deployFixture);
            await f.flightGuard.connect(f.backer).deposit(ethers.parseUnits("100", 6));
            await f.flightGuard.connect(f.owner).fundFxrpPayoutReserve(RESERVE);
            return f;
        }

        async function buyFxrpPayoutPolicy(f: any, coverAmount = COVER) {
            const scheduledArrival = (await time.latest()) + 3600;
            await f.flightGuard
                .connect(f.traveler)
                .buyCover(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, computeRequestHash(), FLIGHT_REF, true);
            return { policyId: (await f.flightGuard.policyCount()) - 1n, scheduledArrival, coverAmount };
        }

        const payoutProof = () => buildProof({ flightStatus: "cancelled", delayMinutes: 0 });

        it("records the payout choice on the policy and in CoverBought", async () => {
            const f = await fundedFixture();
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();

            await expect(
                f.flightGuard
                    .connect(f.traveler)
                    .buyCover(COVER, FALLBACK_PREMIUM_BPS, scheduledArrival, requestHash, FLIGHT_REF, true)
            )
                .to.emit(f.flightGuard, "CoverBought")
                .withArgs(
                    0n,
                    f.traveler.address,
                    COVER,
                    (COVER * FALLBACK_PREMIUM_BPS) / 10_000n,
                    FALLBACK_PREMIUM_BPS,
                    requestHash,
                    FLIGHT_REF,
                    true
                );

            expect((await f.flightGuard.policies(0n)).payoutInFxrp).to.equal(true);
        });

        it("pays the FTSO-converted FXRP amount and no USDT0", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await time.increaseTo(scheduledArrival);

            const expectedFxrp = expectedFxrpFor(COVER);
            const fxrpBefore = await f.fxrp.balanceOf(f.traveler.address);
            const usdt0Before = await f.token.balanceOf(f.traveler.address);

            await expect(f.flightGuard.settle(policyId, payoutProof()))
                .to.emit(f.flightGuard, "PaidOutInFxrp")
                .withArgs(policyId, f.traveler.address, COVER, expectedFxrp, XRP_USD_PRICE_WEI, USDT_USD_PRICE_WEI);

            expect(await f.fxrp.balanceOf(f.traveler.address)).to.equal(fxrpBefore + expectedFxrp);
            expect(await f.token.balanceOf(f.traveler.address)).to.equal(usdt0Before); // not a cent of USDT0
            expect((await f.flightGuard.policies(policyId)).status).to.equal(1n); // PaidOut
            expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE - expectedFxrp);
            expect(await f.flightGuard.usdt0SwapProceeds()).to.equal(COVER);
        });

        // The whole point of doing the conversion inside settle(): the rate is the one live
        // at payout, so an XRP move between purchase and settlement changes what lands in the
        // wallet. Purchase-time pricing would have paid the pre-move amount.
        it("converts at the settlement-time rate, not the purchase-time rate", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);

            const purchaseTimeFxrp = expectedFxrpFor(COVER); // what XRP $1.10 would have paid

            // XRP halves after purchase -> the same USDT0 cover is now worth twice the FXRP.
            const halvedXrpPrice = XRP_USD_PRICE_WEI / 2n;
            await f.ftso.setPriceWei(await f.flightGuard.FXRP_PROXY_FEED_ID(), halvedXrpPrice);
            const settlementTimeFxrp = expectedFxrpFor(COVER, halvedXrpPrice);
            // ~2x, off by at most one base unit: each conversion truncates independently.
            expect(settlementTimeFxrp - purchaseTimeFxrp * 2n).to.be.lessThanOrEqual(1n);
            expect(settlementTimeFxrp).to.be.greaterThan(purchaseTimeFxrp);

            await time.increaseTo(scheduledArrival);
            const fxrpBefore = await f.fxrp.balanceOf(f.traveler.address);

            await expect(f.flightGuard.settle(policyId, payoutProof()))
                .to.emit(f.flightGuard, "PaidOutInFxrp")
                .withArgs(policyId, f.traveler.address, COVER, settlementTimeFxrp, halvedXrpPrice, USDT_USD_PRICE_WEI);

            expect(await f.fxrp.balanceOf(f.traveler.address)).to.equal(fxrpBefore + settlementTimeFxrp);
        });

        it("previewFxrpPayout quotes exactly what settle() pays at the same rate", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);

            const [quotedFxrp, xrpUsdPriceWei, usdtUsdPriceWei] =
                await f.flightGuard.previewFxrpPayout.staticCall(COVER);
            expect(quotedFxrp).to.equal(expectedFxrpFor(COVER));
            expect(xrpUsdPriceWei).to.equal(XRP_USD_PRICE_WEI);
            expect(usdtUsdPriceWei).to.equal(USDT_USD_PRICE_WEI);

            await time.increaseTo(scheduledArrival);
            await expect(f.flightGuard.settle(policyId, payoutProof())).to.changeTokenBalance(
                f.fxrp,
                f.traveler,
                quotedFxrp
            );
        });

        // Backer solvency is the thing that must not move: an FXRP payout keeps the cover's
        // USDT0 inside the contract, so poolBalance() has to net it out or backers would see
        // a windfall that isn't theirs.
        it("leaves the pool in exactly the state a USDT0 payout would have left it", async () => {
            // Control run first, with its numbers captured as plain values: the second
            // fundedFixture() reverts the chain to the fixture snapshot, so nothing can be
            // read back off the first run afterwards.
            const usdt0Run = await fundedFixture();
            const usdt0Policy = await buyActivePolicy(usdt0Run.flightGuard, usdt0Run.traveler, COVER);
            await time.increaseTo(usdt0Policy.scheduledArrival);
            await usdt0Run.flightGuard.settle(usdt0Policy.policyId, payoutProof());
            const control = {
                poolBalance: await usdt0Run.flightGuard.poolBalance(),
                freeLiquidity: await usdt0Run.flightGuard.freeLiquidity(),
                totalLocked: await usdt0Run.flightGuard.totalLocked(),
                totalShares: await usdt0Run.flightGuard.totalShares(),
                contractUsdt0: await usdt0Run.token.balanceOf(await usdt0Run.flightGuard.getAddress()),
            };

            const fxrpRun = await fundedFixture();
            const fxrpPolicy = await buyFxrpPayoutPolicy(fxrpRun);
            await time.increaseTo(fxrpPolicy.scheduledArrival);
            await fxrpRun.flightGuard.settle(fxrpPolicy.policyId, payoutProof());

            expect(await fxrpRun.flightGuard.poolBalance()).to.equal(control.poolBalance);
            expect(await fxrpRun.flightGuard.freeLiquidity()).to.equal(control.freeLiquidity);
            expect(await fxrpRun.flightGuard.totalLocked()).to.equal(control.totalLocked);
            expect(await fxrpRun.flightGuard.totalShares()).to.equal(control.totalShares);

            // The contract still physically holds the cover's USDT0 in the FXRP run - it is
            // just booked to the reserve provider rather than to the pool.
            expect(await fxrpRun.token.balanceOf(await fxrpRun.flightGuard.getAddress())).to.equal(
                control.contractUsdt0 + COVER
            );
        });

        it("lets the backer withdraw their full share after an FXRP payout", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await time.increaseTo(scheduledArrival);
            await f.flightGuard.settle(policyId, payoutProof());

            const backerShares = await f.flightGuard.shares(f.backer.address);
            const expectedUsdt0 =
                (backerShares * (await f.flightGuard.poolBalance())) / (await f.flightGuard.totalShares());

            await expect(f.flightGuard.connect(f.backer).withdraw(backerShares)).to.changeTokenBalance(
                f.token,
                f.backer,
                expectedUsdt0
            );
            // Deposited 100, premium +4, cover -40 -> 64 back out.
            expect(expectedUsdt0).to.equal(ethers.parseUnits("64", 6));
        });

        it("lets the reserve provider reclaim the swapped USDT0, and no more", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await time.increaseTo(scheduledArrival);
            await f.flightGuard.settle(policyId, payoutProof());

            await expect(
                f.flightGuard.connect(f.owner).withdrawSwapProceeds(f.owner.address, COVER + 1n)
            ).to.be.revertedWith("exceeds swap proceeds");

            const poolBalanceBefore = await f.flightGuard.poolBalance();
            await expect(
                f.flightGuard.connect(f.owner).withdrawSwapProceeds(f.owner.address, COVER)
            ).to.changeTokenBalance(f.token, f.owner, COVER);

            expect(await f.flightGuard.usdt0SwapProceeds()).to.equal(0n);
            // Claiming the proceeds never draws on backer funds - poolBalance() had already
            // excluded them.
            expect(await f.flightGuard.poolBalance()).to.equal(poolBalanceBefore);
        });

        it("is fully bidirectional: premium in FXRP and payout in FXRP on one policy", async () => {
            const f = await fundedFixture();
            const scheduledArrival = (await time.latest()) + 3600;
            await f.flightGuard
                .connect(f.traveler)
                .buyCoverWithFXRP(
                    COVER,
                    FALLBACK_PREMIUM_BPS,
                    scheduledArrival,
                    computeRequestHash(),
                    FLIGHT_REF,
                    true
                );
            const policyId = (await f.flightGuard.policyCount()) - 1n;

            const policy = await f.flightGuard.policies(policyId);
            expect(policy.premiumInFxrp).to.equal(true);
            expect(policy.payoutInFxrp).to.equal(true);

            await time.increaseTo(scheduledArrival);
            await expect(f.flightGuard.settle(policyId, payoutProof())).to.changeTokenBalance(
                f.fxrp,
                f.traveler,
                expectedFxrpFor(COVER)
            );
        });

        it("falls back to USDT0 when the reserve is short, without stranding the claim", async () => {
            const f = await loadFixture(deployFixture);
            await f.flightGuard.connect(f.backer).deposit(ethers.parseUnits("100", 6));
            const shortReserve = expectedFxrpFor(COVER) - 1n; // one base unit too little
            await f.flightGuard.connect(f.owner).fundFxrpPayoutReserve(shortReserve);

            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await time.increaseTo(scheduledArrival);

            await expect(f.flightGuard.settle(policyId, payoutProof()))
                .to.emit(f.flightGuard, "FxrpPayoutUnavailable")
                .withArgs(policyId, expectedFxrpFor(COVER), shortReserve);

            expect(await f.fxrp.balanceOf(f.traveler.address)).to.equal(ethers.parseUnits("1000", 6)); // untouched
            expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(shortReserve); // untouched
            expect(await f.flightGuard.usdt0SwapProceeds()).to.equal(0n);
            expect((await f.flightGuard.policies(policyId)).status).to.equal(1n); // PaidOut, in USDT0
        });

        it("falls back to USDT0 when the FTSO feed returns zero at settlement", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await f.ftso.setPriceWei(await f.flightGuard.FXRP_PROXY_FEED_ID(), 0n);
            await time.increaseTo(scheduledArrival);

            const usdt0Before = await f.token.balanceOf(f.traveler.address);
            await expect(f.flightGuard.settle(policyId, payoutProof()))
                .to.emit(f.flightGuard, "FxrpPayoutUnavailable")
                .withArgs(policyId, 0n, RESERVE);

            expect(await f.token.balanceOf(f.traveler.address)).to.equal(usdt0Before + COVER);
            expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE);
        });

        it("falls back to USDT0 when the FTSO read itself reverts at settlement", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await f.ftso.setShouldRevert(true);
            await time.increaseTo(scheduledArrival);

            const usdt0Before = await f.token.balanceOf(f.traveler.address);
            await expect(f.flightGuard.settle(policyId, payoutProof()))
                .to.emit(f.flightGuard, "FxrpPayoutUnavailable")
                .withArgs(policyId, 0n, RESERVE);

            expect(await f.token.balanceOf(f.traveler.address)).to.equal(usdt0Before + COVER);
            expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE);
        });

        it("touches neither reserve nor swap proceeds when the flight is on time", async () => {
            const f = await fundedFixture();
            const { policyId, scheduledArrival } = await buyFxrpPayoutPolicy(f);
            await time.increaseTo(scheduledArrival);

            await expect(
                f.flightGuard.settle(policyId, buildProof({ flightStatus: "scheduled", delayMinutes: 0 }))
            ).to.changeTokenBalance(f.fxrp, f.traveler, 0n);

            expect((await f.flightGuard.policies(policyId)).status).to.equal(3n); // NoPayout
            expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE);
            expect(await f.flightGuard.usdt0SwapProceeds()).to.equal(0n);
        });

        describe("reserve administration", () => {
            it("funds the reserve by pulling FXRP from the owner", async () => {
                const f = await loadFixture(deployFixture);
                const ownerFxrpBefore = await f.fxrp.balanceOf(f.owner.address);

                await expect(f.flightGuard.connect(f.owner).fundFxrpPayoutReserve(RESERVE))
                    .to.emit(f.flightGuard, "FxrpPayoutReserveFunded")
                    .withArgs(f.owner.address, RESERVE, RESERVE);

                expect(await f.fxrp.balanceOf(f.owner.address)).to.equal(ownerFxrpBefore - RESERVE);
                expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE);
            });

            it("recycles FXRP premiums into the reserve without moving tokens", async () => {
                const f = await fundedFixture();
                const scheduledArrival = (await time.latest()) + 3600;
                await f.flightGuard
                    .connect(f.traveler)
                    .buyCoverWithFXRP(
                        COVER,
                        FALLBACK_PREMIUM_BPS,
                        scheduledArrival,
                        computeRequestHash(),
                        FLIGHT_REF,
                        false
                    );
                const premiums = await f.flightGuard.fxrpPremiums();
                expect(premiums).to.be.greaterThan(0n);

                await expect(f.flightGuard.connect(f.owner).moveFxrpPremiumsToReserve(premiums)).to.changeTokenBalance(
                    f.fxrp,
                    await f.flightGuard.getAddress(),
                    0n
                );

                expect(await f.flightGuard.fxrpPremiums()).to.equal(0n);
                expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(RESERVE + premiums);
            });

            it("withdraws from the reserve, bounded by its balance", async () => {
                const f = await fundedFixture();
                await expect(
                    f.flightGuard.connect(f.owner).withdrawFxrpPayoutReserve(f.owner.address, RESERVE + 1n)
                ).to.be.revertedWith("exceeds reserve");

                await expect(
                    f.flightGuard.connect(f.owner).withdrawFxrpPayoutReserve(f.owner.address, RESERVE)
                ).to.changeTokenBalance(f.fxrp, f.owner, RESERVE);
                expect(await f.flightGuard.fxrpPayoutReserve()).to.equal(0n);
            });

            it("restricts every reserve function to the owner", async () => {
                const f = await fundedFixture();
                await expect(f.flightGuard.connect(f.other).fundFxrpPayoutReserve(1n)).to.be.revertedWith("not owner");
                await expect(
                    f.flightGuard.connect(f.other).withdrawFxrpPayoutReserve(f.other.address, 1n)
                ).to.be.revertedWith("not owner");
                await expect(f.flightGuard.connect(f.other).moveFxrpPremiumsToReserve(0n)).to.be.revertedWith(
                    "not owner"
                );
                await expect(
                    f.flightGuard.connect(f.other).withdrawSwapProceeds(f.other.address, 0n)
                ).to.be.revertedWith("not owner");
            });
        });
    });

    describe("settle", () => {
        it("pays out when delayMinutes >= DELAY_THRESHOLD_MIN", async () => {
            const { flightGuard, token, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const threshold = await flightGuard.DELAY_THRESHOLD_MIN();
            const { policyId, scheduledArrival, coverAmount } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const proof = buildProof({ flightStatus: "active", delayMinutes: threshold });
            await expect(flightGuard.settle(policyId, proof)).to.changeTokenBalance(token, traveler, coverAmount);

            const policy = await flightGuard.policies(policyId);
            expect(policy.status).to.equal(1n); // PaidOut
            expect(await flightGuard.totalLocked()).to.equal(0n);
        });

        it("pays out when flightStatus is cancelled regardless of delay", async () => {
            const { flightGuard, token, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival, coverAmount } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const proof = buildProof({ flightStatus: "cancelled", delayMinutes: 0 });
            await expect(flightGuard.settle(policyId, proof)).to.changeTokenBalance(token, traveler, coverAmount);

            const policy = await flightGuard.policies(policyId);
            expect(policy.status).to.equal(1n); // PaidOut
        });

        // Regression guard for the default path: adding the FXRP payout option must not
        // change what a normal policy does, even on a contract that has FXRP sitting in its
        // payout reserve ready to be spent.
        it("pays USDT0 and leaves the FXRP reserve alone when payoutInFxrp is false", async () => {
            const { flightGuard, token, fxrp, owner, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const reserve = ethers.parseUnits("500", 6);
            await flightGuard.connect(owner).fundFxrpPayoutReserve(reserve);

            const { policyId, scheduledArrival, coverAmount } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);
            const travelerFxrpBefore = await fxrp.balanceOf(traveler.address);

            await expect(
                flightGuard.settle(policyId, buildProof({ flightStatus: "cancelled", delayMinutes: 0 }))
            ).to.changeTokenBalance(token, traveler, coverAmount);

            expect(await fxrp.balanceOf(traveler.address)).to.equal(travelerFxrpBefore);
            expect(await flightGuard.fxrpPayoutReserve()).to.equal(reserve);
            expect(await flightGuard.usdt0SwapProceeds()).to.equal(0n);
            expect(await flightGuard.poolBalance()).to.equal(await token.balanceOf(await flightGuard.getAddress()));
        });

        it("does not pay out for an on-time, non-cancelled flight", async () => {
            const { flightGuard, token, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const proof = buildProof({ flightStatus: "scheduled", delayMinutes: 0 });
            await expect(flightGuard.settle(policyId, proof)).to.changeTokenBalance(token, traveler, 0n);

            const policy = await flightGuard.policies(policyId);
            expect(policy.status).to.equal(3n); // NoPayout
        });

        it("reverts when the proof's request doesn't match the policy's requestHash", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            // Same url/jq/abiSignature, different queryParams (different flight) - this is
            // exactly the binding the requestHash fix protects: without headers/queryParams
            // in the hash, this proof would have wrongly settled the policy above.
            const otherReq = { ...REQUEST, queryParams: JSON.stringify({ flight_iata: "XX999" }) };
            const proof = buildProof({ req: otherReq });
            await expect(flightGuard.settle(policyId, proof)).to.be.revertedWith("proof/policy mismatch");
        });

        it("reverts when the FDC proof itself is invalid", async () => {
            const { flightGuard, verifier, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);
            await verifier.setValid(false);

            await expect(flightGuard.settle(policyId, buildProof())).to.be.revertedWith("invalid FDC proof");
        });

        it("keeps flightRef readable via policies() unchanged after settle", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival, flightRef } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            await flightGuard.settle(policyId, buildProof({ flightStatus: "cancelled" }));

            const policy = await flightGuard.policies(policyId);
            expect(policy.flightRef).to.equal(flightRef);
            expect(policy.status).to.equal(1n); // PaidOut
        });

        it("reverts settle before scheduledArrival", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId } = await buyActivePolicy(flightGuard, traveler);

            await expect(flightGuard.settle(policyId, buildProof())).to.be.revertedWith("too early");
        });
    });

    describe("expire", () => {
        it("expires an active policy after the claim window and unlocks funds", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            const claimWindow = await flightGuard.CLAIM_WINDOW();
            await time.increaseTo(scheduledArrival + Number(claimWindow) + 1);

            await expect(flightGuard.expire(policyId))
                .to.emit(flightGuard, "Settled")
                .withArgs(policyId, 2n, 0n, false); // Expired

            const policy = await flightGuard.policies(policyId);
            expect(policy.status).to.equal(2n);
            expect(await flightGuard.totalLocked()).to.equal(0n);
        });

        it("reverts expire while the claim window is still open", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            await expect(flightGuard.expire(policyId)).to.be.revertedWith("window open");
        });
    });

    describe("pre-provenance proof bytes (Coston2 live run regression)", () => {
        // Exact abiEncodedData captured from a live Coston2 Web2Json attestation (voting
        // round 1391457, 2026-07-10) under the OLD two-field scheme:
        // {flightStatus: "scheduled", delayMinutes: 0}, ABI encoded as the single wrapped
        // "dto" tuple that abiSignature declared at the time.
        const PRE_PROVENANCE_ABI_ENCODED_DATA =
            "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000097363686564756c65640000000000000000000000000000000000000000000000";

        // The DTO gained `source`/`corroborated`, so these bytes are two words short of the
        // current struct. This asserts the safe outcome: abi.decode reverts on bounds rather
        // than reading past the payload and inventing a source/corroboration that was never
        // attested. A policy carrying a pre-provenance requestHash therefore cannot settle at
        // all on this contract (it expires and unlocks) - which is why the keeper skips those
        // schemes explicitly instead of paying for an attestation that can never land.
        it("rejects two-field bytes rather than misreading them as provenance fields", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const proof = buildProof({ abiEncodedData: PRE_PROVENANCE_ABI_ENCODED_DATA });
            await expect(flightGuard.settle(policyId, proof)).to.be.reverted;

            // Untouched: still Active, still locked, still settleable by a valid proof.
            expect((await flightGuard.policies(policyId)).status).to.equal(0n);
            expect(await flightGuard.totalLocked()).to.equal(ethers.parseUnits("40", 6));
        });
    });

    describe("settlement provenance (single-source auditability)", () => {
        async function settledWith(overrides: Parameters<typeof buildProof>[0]) {
            const f = await loadFixture(deployFixture);
            await f.flightGuard.connect(f.backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival, coverAmount } = await buyActivePolicy(f.flightGuard, f.traveler);
            await time.increaseTo(scheduledArrival);
            const tx = await f.flightGuard.settle(policyId, buildProof(overrides));
            return { ...f, policyId, coverAmount, tx };
        }

        it("records a corroborated payout as Corroborated and emits the source", async () => {
            const { flightGuard, policyId, tx } = await settledWith({
                flightStatus: "cancelled",
                source: "airlabs",
                corroborated: true,
            });

            await expect(tx)
                .to.emit(flightGuard, "SettlementEvidence")
                .withArgs(policyId, Provenance.Corroborated, "airlabs");
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.Corroborated);
        });

        it("records an uncorroborated payout as SingleSource", async () => {
            const { flightGuard, policyId, tx } = await settledWith({
                flightStatus: "active",
                delayMinutes: 300,
                source: "airlabs",
                corroborated: false,
            });

            await expect(tx)
                .to.emit(flightGuard, "SettlementEvidence")
                .withArgs(policyId, Provenance.SingleSource, "airlabs");
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.SingleSource);
            expect((await flightGuard.policies(policyId)).status).to.equal(1n); // still PaidOut
        });

        it("names the fallback source when it was the one that answered", async () => {
            const { flightGuard, policyId, tx } = await settledWith({
                flightStatus: "cancelled",
                source: "aviationstack",
                corroborated: false,
            });

            await expect(tx)
                .to.emit(flightGuard, "SettlementEvidence")
                .withArgs(policyId, Provenance.SingleSource, "aviationstack");
        });

        // The whole point of the flag: before it, these two settled identically and were
        // indistinguishable onchain, so a data outage silently looked like a fine flight.
        it("distinguishes a data outage from a genuinely on-time flight", async () => {
            const outage = await settledWith({ flightStatus: "EMPTY", delayMinutes: 0, source: "none" });
            expect((await outage.flightGuard.policies(outage.policyId)).status).to.equal(3n); // NoPayout
            expect((await outage.flightGuard.policies(outage.policyId)).provenance).to.equal(
                Provenance.DataUnavailable
            );
            await expect(outage.tx)
                .to.emit(outage.flightGuard, "SettlementEvidence")
                .withArgs(outage.policyId, Provenance.DataUnavailable, "none");

            const onTime = await settledWith({ flightStatus: "landed", delayMinutes: 12, source: "airlabs" });
            expect((await onTime.flightGuard.policies(onTime.policyId)).status).to.equal(3n); // NoPayout too...
            // ...but no longer indistinguishable.
            expect((await onTime.flightGuard.policies(onTime.policyId)).provenance).to.equal(Provenance.SingleSource);
        });

        it("treats a corroborated on-time flight as corroborated, not as missing data", async () => {
            const { flightGuard, policyId } = await settledWith({
                flightStatus: "landed",
                delayMinutes: 0,
                source: "airlabs",
                corroborated: true,
            });
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.Corroborated);
        });

        it("never pays out on EMPTY, however the corroboration flag is set", async () => {
            // A source claiming corroboration cannot turn missing data into a payout - the
            // payout conditions are unchanged and EMPTY satisfies neither.
            const { flightGuard, token, traveler, policyId, coverAmount, tx } = await settledWith({
                flightStatus: "EMPTY",
                delayMinutes: 0,
                source: "none",
                corroborated: true,
            });
            await expect(tx).to.changeTokenBalance(token, traveler, 0n);
            expect((await flightGuard.policies(policyId)).status).to.equal(3n); // NoPayout
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.DataUnavailable);
            expect(coverAmount).to.be.greaterThan(0n);
        });

        it("leaves provenance Unsettled on an active policy and on expiry", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.Unsettled);

            const claimWindow = await flightGuard.CLAIM_WINDOW();
            await time.increaseTo(scheduledArrival + Number(claimWindow) + 1);
            await flightGuard.expire(policyId);

            expect((await flightGuard.policies(policyId)).status).to.equal(2n); // Expired
            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.Unsettled);
        });

        it("records provenance on an FXRP payout too", async () => {
            const { flightGuard, owner, backer, traveler, fxrp } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            await flightGuard.connect(owner).fundFxrpPayoutReserve(ethers.parseUnits("500", 6));
            const coverAmount = ethers.parseUnits("40", 6);
            const scheduledArrival = (await time.latest()) + 3600;
            await flightGuard
                .connect(traveler)
                .buyCover(coverAmount, FALLBACK_PREMIUM_BPS, scheduledArrival, computeRequestHash(), FLIGHT_REF, true);
            const policyId = (await flightGuard.policyCount()) - 1n;
            await time.increaseTo(scheduledArrival);

            await expect(
                flightGuard.settle(
                    policyId,
                    buildProof({ flightStatus: "cancelled", source: "aviationstack", corroborated: true })
                )
            ).to.changeTokenBalance(fxrp, traveler, expectedFxrpFor(coverAmount));

            expect((await flightGuard.policies(policyId)).provenance).to.equal(Provenance.Corroborated);
        });
    });

    describe("real cancelled flight (airlabs live capture)", () => {
        // Raw airlabs.co /v9/flight response for B6869 (JFK -> PUJ), captured live on
        // 2026-07-11 via https://airlabs.co/api/v9/flight?flight_iata=B6869. Confirms the
        // shape buildPostProcessJq relies on for a real cancelled flight: status is
        // "cancelled", arr_delayed is null (-> `// 0` fallback) since it never departed,
        // and - the point of the date-lock fix - dep_time_utc is present and stable even
        // though the flight was cancelled, unlike arr_time_utc which flaw (b) noted can be
        // absent entirely for cancellations.
        const REAL_CANCELLED_FLIGHT_RESPONSE = {
            response: {
                airline_iata: "B6",
                flight_iata: "B6869",
                flight_number: "869",
                dep_iata: "JFK",
                dep_time_utc: "2026-07-11 10:15",
                arr_iata: "PUJ",
                arr_time_utc: "2026-07-11 14:11",
                status: "cancelled",
                dep_delayed: null,
                arr_delayed: null,
            },
        };

        // JS mirror of buildPostProcessJq's jq expression (web/lib/server/flightRequest.ts
        // and scripts/fdc-attest-flight.ts). `??` stands in for jq's `//` alternative
        // operator - equivalent here since these fields are only ever string, number, or
        // null/undefined, never `false`.
        function applyPostProcessJq(raw: typeof REAL_CANCELLED_FLIGHT_RESPONSE, date: string) {
            const match = (raw.response?.dep_time_utc ?? "").startsWith(date);
            return {
                flightStatus: match ? (raw.response?.status ?? "EMPTY") : "EMPTY",
                delayMinutes: match ? (raw.response?.arr_delayed ?? 0) : 0,
            };
        }

        it("encodes a real cancelled flight as (cancelled, 0) when the date matches dep_time_utc", () => {
            const dto = applyPostProcessJq(REAL_CANCELLED_FLIGHT_RESPONSE, "2026-07-11");
            expect(dto).to.deep.equal({ flightStatus: "cancelled", delayMinutes: 0 });
        });

        it("locks to EMPTY when the date doesn't match dep_time_utc", () => {
            const dto = applyPostProcessJq(REAL_CANCELLED_FLIGHT_RESPONSE, "2026-07-12");
            expect(dto).to.deep.equal({ flightStatus: "EMPTY", delayMinutes: 0 });
        });

        it("pays out a policy settled with this real cancelled-flight shape", async () => {
            const { flightGuard, token, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival, coverAmount } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const dto = applyPostProcessJq(REAL_CANCELLED_FLIGHT_RESPONSE, "2026-07-11");
            const proof = buildProof({ flightStatus: dto.flightStatus, delayMinutes: dto.delayMinutes });
            await expect(flightGuard.settle(policyId, proof)).to.changeTokenBalance(token, traveler, coverAmount);

            const policy = await flightGuard.policies(policyId);
            expect(policy.status).to.equal(1n); // PaidOut
        });
    });
});
