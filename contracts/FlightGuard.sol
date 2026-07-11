// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * FlightGuard — parametric flight-delay cover on Flare (Coston2)
 *
 * Flow:
 *  1. Backers deposit USDT0 -> pool shares, earn premiums
 *  2. Traveler buys cover for a flight (flight number + date), pays premium
 *  3. After scheduled arrival, anyone submits an FDC Web2Json proof of the
 *     flight-status API response. Delay >= threshold or cancelled -> auto payout.
 *  4. No proof within claim window -> cover expires, locked funds return to pool.
 */

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IWeb2Json } from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import { IFdcVerification } from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import { FtsoV2Interface } from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

// Mirrors the single "dto" tuple declared by the request's abiSignature - abiEncodedData
// is the ABI encoding of ONE tuple-typed value, not two flat top-level params, so it must
// be decoded as this struct (same pattern as weatherInsurance's DataTransportObject).
struct FlightDto {
    string flightStatus;
    uint256 delayMinutes;
}

contract FlightGuard {
    using SafeERC20 for IERC20;

    // ---------- config ----------
    IERC20 public immutable token; // USDT0 (6 decimals on Coston2)
    IFdcVerification public fdcVerification;
    address public owner;

    uint256 public constant DELAY_THRESHOLD_MIN = 120; // >= 2h delay pays out
    uint256 public constant PREMIUM_BPS = 1000; // 10% of cover amount
    uint256 public constant MAX_COVER = 500e6; // 500 USDT0 cap per policy (demo)
    uint256 public constant CLAIM_WINDOW = 3 days; // after scheduledArrival

    // ---------- FTSO-priced FXRP premium ----------
    // FXRP (the FAsset wrapping XRP) and USDT0 have no FTSO feeds of their own - Flare's
    // full feed list (dev.flare.network/ftso/feeds, confirmed live against Coston2's
    // FtsoFeedIdConverter) has 64 crypto feeds and neither "FXRP/USD" nor "USDT0/USD" is
    // among them. Both are 1:1-backed synthetic tokens (FXRP is an FAsset fully
    // collateralized against real XRP; USDT0 tracks USDT), so their USD value is read via
    // the underlying real asset's feed instead. Feed IDs are a deterministic encoding
    // (category byte 0x01 = crypto, then the ASCII feed name right-padded to 20 bytes) -
    // these two were independently confirmed live via IFtsoFeedIdConverter.getFeedId.
    bytes21 public constant FXRP_PROXY_FEED_ID = 0x015852502f55534400000000000000000000000000; // "XRP/USD"
    bytes21 public constant USDT0_PROXY_FEED_ID = 0x01555344542f555344000000000000000000000000; // "USDT/USD"

    uint256 private constant USDT0_DECIMALS = 6;
    uint256 private constant FXRP_DECIMALS = 6;

    FtsoV2Interface public ftsoV2;
    IERC20 public immutable fxrpToken;
    // FXRP collected from FXRP-paid premiums - tracked entirely separately from the USDT0
    // pool (poolBalance/totalLocked/shares), which is the only thing settle()/expire() ever
    // pay out from. This balance just accumulates; withdrawFxrpPremiums lets the owner move
    // it out.
    uint256 public fxrpPremiums;

    // ---------- pool (simple share model) ----------
    uint256 public totalShares;
    uint256 public totalLocked; // sum of active coverAmounts
    mapping(address => uint256) public shares;

    // ---------- policies ----------
    enum Status {
        Active,
        PaidOut,
        Expired,
        NoPayout
    }

    struct Policy {
        address holder;
        uint256 coverAmount;
        uint256 premium; // always the USDT0-equivalent amount, even when paid in FXRP
        uint64 scheduledArrival; // unix ts
        bytes32 requestHash; // keccak of expected FDC request (url+headers+queryParams+jq+abiSig)
        string flightRef; // "IATA|YYYY-MM-DD", lets a keeper rebuild the FDC request without offchain state
        Status status;
        bool premiumInFxrp; // true if premium was paid in FXRP instead of USDT0 (informational only)
    }

    Policy[] public policies;

    event Deposited(address indexed backer, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed backer, uint256 amount, uint256 sharesBurned);
    event CoverBought(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmount,
        uint256 premium,
        bytes32 requestHash,
        string flightRef
    );
    event CoverBoughtWithFXRP(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmount,
        uint256 premiumUsdt0Equivalent,
        uint256 fxrpAmount,
        uint256 xrpUsdPriceWei,
        uint256 usdtUsdPriceWei,
        bytes32 requestHash,
        string flightRef
    );
    event Settled(uint256 indexed policyId, Status result, uint256 delayMinutes, bool cancelled);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(IERC20 _token, IFdcVerification _fdcVerification, FtsoV2Interface _ftsoV2, IERC20 _fxrpToken) {
        token = _token;
        fdcVerification = _fdcVerification;
        ftsoV2 = _ftsoV2;
        fxrpToken = _fxrpToken;
        owner = msg.sender;
    }

    // ---------- backer side ----------

    function poolBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function freeLiquidity() public view returns (uint256) {
        return poolBalance() - totalLocked;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "zero");
        uint256 minted = totalShares == 0 ? amount : (amount * totalShares) / poolBalance();
        token.safeTransferFrom(msg.sender, address(this), amount);
        shares[msg.sender] += minted;
        totalShares += minted;
        emit Deposited(msg.sender, amount, minted);
    }

    function withdraw(uint256 shareAmount) external {
        require(shareAmount > 0 && shares[msg.sender] >= shareAmount, "bad shares");
        uint256 amount = (shareAmount * poolBalance()) / totalShares;
        require(amount <= freeLiquidity(), "liquidity locked");
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shareAmount);
    }

    // ---------- traveler side ----------

    /**
     * requestHash = keccak256(abi.encode(url, headers, queryParams, postProcessJq, abiSignature))
     * computed off-chain from the exact FDC request that will settle this flight.
     * Prevents settling policy A with a proof about flight B. headers/queryParams are part
     * of the hash because the flight identity (e.g. flight_iata) can live in either the url
     * or queryParams depending on the API - omitting queryParams lets a proof about a
     * different flight settle any policy that shares the same url/jq/abiSignature.
     */
    function buyCover(
        uint256 coverAmount,
        uint64 scheduledArrival,
        bytes32 requestHash,
        string calldata flightRef
    ) external returns (uint256 policyId) {
        require(coverAmount > 0 && coverAmount <= MAX_COVER, "cover out of range");
        require(scheduledArrival > block.timestamp, "flight in past");
        require(coverAmount <= freeLiquidity(), "insufficient pool");

        uint256 premium = (coverAmount * PREMIUM_BPS) / 10_000;
        token.safeTransferFrom(msg.sender, address(this), premium); // premium accrues to pool

        totalLocked += coverAmount;
        policies.push(
            Policy({
                holder: msg.sender,
                coverAmount: coverAmount,
                premium: premium,
                scheduledArrival: scheduledArrival,
                requestHash: requestHash,
                flightRef: flightRef,
                status: Status.Active,
                premiumInFxrp: false
            })
        );
        policyId = policies.length - 1;
        emit CoverBought(policyId, msg.sender, coverAmount, premium, requestHash, flightRef);
    }

    /**
     * Same terms as buyCover (cover stays USDT0-denominated, same 10% PREMIUM_BPS), but the
     * premium is paid in FXRP instead, converted at the live FTSO XRP/USD and USDT/USD rates
     * (see FXRP_PROXY_FEED_ID/USDT0_PROXY_FEED_ID above). The FXRP collected is tracked in
     * fxrpPremiums, entirely separate from the USDT0 pool - settle()/expire() and all payout
     * math are untouched, since payouts always come from the USDT0 pool regardless of how
     * the premium was paid.
     */
    function buyCoverWithFXRP(
        uint256 coverAmount,
        uint64 scheduledArrival,
        bytes32 requestHash,
        string calldata flightRef
    ) external returns (uint256 policyId) {
        require(coverAmount > 0 && coverAmount <= MAX_COVER, "cover out of range");
        require(scheduledArrival > block.timestamp, "flight in past");
        require(coverAmount <= freeLiquidity(), "insufficient pool");

        (uint256 premiumUsdt0, uint256 fxrpAmount, uint256 xrpUsdPrice, uint256 usdtUsdPrice) = previewFxrpPremium(
            coverAmount
        );
        require(fxrpAmount > 0, "premium rounds to zero FXRP");

        fxrpToken.safeTransferFrom(msg.sender, address(this), fxrpAmount);
        fxrpPremiums += fxrpAmount;

        totalLocked += coverAmount;
        policies.push(
            Policy({
                holder: msg.sender,
                coverAmount: coverAmount,
                premium: premiumUsdt0,
                scheduledArrival: scheduledArrival,
                requestHash: requestHash,
                flightRef: flightRef,
                status: Status.Active,
                premiumInFxrp: true
            })
        );
        policyId = policies.length - 1;
        emit CoverBoughtWithFXRP(
            policyId,
            msg.sender,
            coverAmount,
            premiumUsdt0,
            fxrpAmount,
            xrpUsdPrice,
            usdtUsdPrice,
            requestHash,
            flightRef
        );
    }

    /**
     * Quotes the FXRP amount buyCoverWithFXRP(coverAmount, ...) would currently charge, plus
     * the raw 18-decimal-normalized FTSO prices used (so the UI can show its source). Not
     * `view`: FtsoV2's getFeedByIdInWei is declared `payable` (some feeds carry a
     * FeeCalculator fee; ours don't, so this is called with 0 value), which Solidity treats
     * as non-view - but it performs no state writes, so callers still read it with a plain
     * eth_call.
     */
    function previewFxrpPremium(
        uint256 coverAmount
    )
        public
        returns (uint256 premiumUsdt0Equivalent, uint256 fxrpAmount, uint256 xrpUsdPriceWei, uint256 usdtUsdPriceWei)
    {
        premiumUsdt0Equivalent = (coverAmount * PREMIUM_BPS) / 10_000;

        // getFeedByIdInWei normalizes every feed to 18 decimals regardless of its native
        // precision, so no raw `decimals` field needs handling here.
        (uint256 xrpPriceWei, ) = ftsoV2.getFeedByIdInWei(FXRP_PROXY_FEED_ID);
        (uint256 usdtPriceWei, ) = ftsoV2.getFeedByIdInWei(USDT0_PROXY_FEED_ID);
        require(xrpPriceWei > 0 && usdtPriceWei > 0, "bad FTSO price");

        // fxrpAmount = premium (USDT0 base units) * usdtPrice / xrpPrice, rescaled from
        // USDT0's decimals to FXRP's decimals in the same multiply-then-divide chain to
        // avoid compounding rounding error across separate steps.
        fxrpAmount =
            (premiumUsdt0Equivalent * usdtPriceWei * (10 ** FXRP_DECIMALS)) /
            ((10 ** USDT0_DECIMALS) * xrpPriceWei);
        xrpUsdPriceWei = xrpPriceWei;
        usdtUsdPriceWei = usdtPriceWei;
    }

    // ---------- settlement ----------

    /**
     * Anyone can settle with a valid FDC proof after scheduled arrival.
     * abiSignature expected: a single "dto" tuple matching FlightDto (string flightStatus, uint256 delayMinutes).
     */
    function settle(uint256 policyId, IWeb2Json.Proof calldata proof) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Active, "not active");
        require(block.timestamp >= p.scheduledArrival, "too early");
        require(block.timestamp <= p.scheduledArrival + CLAIM_WINDOW, "window closed");

        // 1. proof is valid per FDC merkle root
        require(fdcVerification.verifyWeb2Json(proof), "invalid FDC proof");

        // 2. proof is about THIS flight
        bytes32 h = keccak256(
            abi.encode(
                proof.data.requestBody.url,
                proof.data.requestBody.headers,
                proof.data.requestBody.queryParams,
                proof.data.requestBody.postProcessJq,
                proof.data.requestBody.abiSignature
            )
        );
        require(h == p.requestHash, "proof/policy mismatch");

        // 3. decode attested API data
        FlightDto memory dto = abi.decode(proof.data.responseBody.abiEncodedData, (FlightDto));

        bool cancelled = keccak256(bytes(dto.flightStatus)) == keccak256(bytes("cancelled"));
        bool delayed = dto.delayMinutes >= DELAY_THRESHOLD_MIN;

        totalLocked -= p.coverAmount;

        if (cancelled || delayed) {
            p.status = Status.PaidOut;
            token.safeTransfer(p.holder, p.coverAmount);
        } else {
            p.status = Status.NoPayout; // premium stays in pool
        }
        emit Settled(policyId, p.status, dto.delayMinutes, cancelled);
    }

    /** After claim window with no settlement, unlock funds back to pool. */
    function expire(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Active, "not active");
        require(block.timestamp > p.scheduledArrival + CLAIM_WINDOW, "window open");
        p.status = Status.Expired;
        totalLocked -= p.coverAmount;
        emit Settled(policyId, Status.Expired, 0, false);
    }

    // ---------- admin ----------
    function setFdcVerification(IFdcVerification v) external onlyOwner {
        fdcVerification = v;
    }

    function setFtsoV2(FtsoV2Interface v) external onlyOwner {
        ftsoV2 = v;
    }

    /** Moves accumulated FXRP premiums out - separate from the USDT0 pool, so this never
     *  touches backer funds or anything settle()/expire() depend on. */
    function withdrawFxrpPremiums(address to, uint256 amount) external onlyOwner {
        require(amount <= fxrpPremiums, "exceeds fxrpPremiums");
        fxrpPremiums -= amount;
        fxrpToken.safeTransfer(to, amount);
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }
}
