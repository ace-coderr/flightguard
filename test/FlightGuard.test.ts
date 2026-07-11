import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Generic (non-secret) stand-in for the real airlabs.co request built by
// scripts/fdc-attest-flight.ts's buildFlightRequestBody - same shape, no API key.
// postProcessJq matches buildPostProcessJq's date-lock (keyed on dep_time_utc, matching
// FLIGHT_REF's "2026-07-10" below) byte-for-byte.
const REQUEST = {
    url: "https://airlabs.co/api/v9/flight",
    headers: "{}",
    queryParams: JSON.stringify({ flight_iata: "BA75" }),
    postProcessJq: `{flightStatus: (if (.response.dep_time_utc // "" | startswith("2026-07-10")) then (.response.status // .error.message // "EMPTY") else "EMPTY" end), delayMinutes: (if (.response.dep_time_utc // "" | startswith("2026-07-10")) then (.response.arr_delayed // 0) else 0 end)}`,
    abiSignature: `{"components":[{"internalType":"string","name":"flightStatus","type":"string"},{"internalType":"uint256","name":"delayMinutes","type":"uint256"}],"name":"dto","type":"tuple"}`,
};

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
// value (matching FlightDto), not two flat params.
function encodeDto(flightStatus: string, delayMinutes: number | bigint) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(string flightStatus, uint256 delayMinutes)"],
        [{ flightStatus, delayMinutes }]
    );
}

function buildProof(
    overrides: {
        flightStatus?: string;
        delayMinutes?: number | bigint;
        req?: typeof REQUEST;
        abiEncodedData?: string;
    } = {}
) {
    const req = overrides.req ?? REQUEST;
    const abiEncodedData =
        overrides.abiEncodedData ?? encodeDto(overrides.flightStatus ?? "scheduled", overrides.delayMinutes ?? 0);
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

async function deployFixture() {
    const [owner, backer, backer2, traveler, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDT0", "mUSDT0", 6);

    const MockFdcVerification = await ethers.getContractFactory("MockFdcVerification");
    const verifier = await MockFdcVerification.deploy();

    const FlightGuard = await ethers.getContractFactory("FlightGuard");
    const flightGuard = await FlightGuard.deploy(await token.getAddress(), await verifier.getAddress());

    const mintAmount = ethers.parseUnits("10000", 6);
    for (const s of [backer, backer2, traveler, other]) {
        await token.mint(s.address, mintAmount);
        await token.connect(s).approve(await flightGuard.getAddress(), ethers.MaxUint256);
    }

    return { owner, backer, backer2, traveler, other, token, verifier, flightGuard };
}

const FLIGHT_REF = "BA75|2026-07-10";

// Buys cover on REQUEST (or a custom request) and returns the resulting policyId +
// scheduledArrival, leaving the policy Active and ready to settle/expire.
async function buyActivePolicy(
    flightGuard: any,
    traveler: any,
    coverAmount = ethers.parseUnits("40", 6),
    req: typeof REQUEST = REQUEST,
    flightRef: string = FLIGHT_REF
) {
    const scheduledArrival = (await time.latest()) + 3600;
    const requestHash = computeRequestHash(req);
    await flightGuard.connect(traveler).buyCover(coverAmount, scheduledArrival, requestHash, flightRef);
    const policyId = (await flightGuard.policyCount()) - 1n;
    return { policyId, scheduledArrival, requestHash, coverAmount, flightRef };
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
            const premiumBps = await flightGuard.PREMIUM_BPS();
            const premium = (coverAmount * premiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();

            await expect(flightGuard.connect(traveler).buyCover(coverAmount, scheduledArrival, requestHash, FLIGHT_REF))
                .to.emit(flightGuard, "CoverBought")
                .withArgs(0n, traveler.address, coverAmount, premium, requestHash, FLIGHT_REF);

            expect(await flightGuard.totalLocked()).to.equal(coverAmount);
            const policy = await flightGuard.policies(0n);
            expect(policy.holder).to.equal(traveler.address);
            expect(policy.coverAmount).to.equal(coverAmount);
            expect(policy.premium).to.equal(premium);
            expect(policy.flightRef).to.equal(FLIGHT_REF);
            expect(policy.status).to.equal(0n); // Active
        });

        it("stores flightRef in the policy and emits it in CoverBought", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const coverAmount = ethers.parseUnits("25", 6);
            const premiumBps = await flightGuard.PREMIUM_BPS();
            const premium = (coverAmount * premiumBps) / 10_000n;
            const scheduledArrival = (await time.latest()) + 3600;
            const requestHash = computeRequestHash();
            const flightRef = "KL1631|2026-08-01";

            await expect(flightGuard.connect(traveler).buyCover(coverAmount, scheduledArrival, requestHash, flightRef))
                .to.emit(flightGuard, "CoverBought")
                .withArgs(0n, traveler.address, coverAmount, premium, requestHash, flightRef);

            const policy = await flightGuard.policies(0n);
            expect(policy.flightRef).to.equal(flightRef);
        });

        it("reverts when coverAmount is zero", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard.connect(traveler).buyCover(0, scheduledArrival, computeRequestHash(), FLIGHT_REF)
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
                    .buyCover(maxCover + 1n, scheduledArrival, computeRequestHash(), FLIGHT_REF)
            ).to.be.revertedWith("cover out of range");
        });

        it("reverts when scheduledArrival is not in the future", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const pastArrival = (await time.latest()) - 10;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(ethers.parseUnits("10", 6), pastArrival, computeRequestHash(), FLIGHT_REF)
            ).to.be.revertedWith("flight in past");
        });

        it("reverts when coverAmount exceeds free liquidity", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("10", 6));
            const scheduledArrival = (await time.latest()) + 3600;
            await expect(
                flightGuard
                    .connect(traveler)
                    .buyCover(ethers.parseUnits("11", 6), scheduledArrival, computeRequestHash(), FLIGHT_REF)
            ).to.be.revertedWith("insufficient pool");
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

    describe("real DA layer proof bytes (Coston2 live run regression)", () => {
        // Exact abiEncodedData captured from a live Coston2 Web2Json attestation (voting
        // round 1391457, 2026-07-10): {flightStatus: "scheduled", delayMinutes: 0}, ABI
        // encoded as the single wrapped "dto" tuple abiSignature actually declares. Before
        // the fix, FlightGuard decoded this flat as (string, uint256) and read delayMinutes
        // as 64 (garbage - actually the inner tuple's string-offset word).
        const REAL_ABI_ENCODED_DATA =
            "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000097363686564756c65640000000000000000000000000000000000000000000000";

        it("decodes real captured bytes as FlightDto (delayMinutes: 0, not the old garbage 64)", async () => {
            const { flightGuard, backer, traveler } = await loadFixture(deployFixture);
            await flightGuard.connect(backer).deposit(ethers.parseUnits("100", 6));
            const { policyId, scheduledArrival } = await buyActivePolicy(flightGuard, traveler);
            await time.increaseTo(scheduledArrival);

            const proof = buildProof({ abiEncodedData: REAL_ABI_ENCODED_DATA });
            await expect(flightGuard.settle(policyId, proof))
                .to.emit(flightGuard, "Settled")
                .withArgs(policyId, 3n, 0n, false); // NoPayout, delayMinutes: 0, cancelled: false
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
