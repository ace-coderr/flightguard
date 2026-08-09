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
//
// `source` and `corroborated` carry the settlement's evidentiary basis INSIDE the attested
// payload, so they are covered by the FDC proof rather than asserted by our server after the
// fact: `source` names which upstream actually answered ("airlabs" / "aviationstack" /
// "none"), and `corroborated` is true only when a second, independent source produced the
// same payout decision. See web/lib/server/flightSources.ts.
struct FlightDto {
    string flightStatus;
    uint256 delayMinutes;
    string source;
    bool corroborated;
}

contract FlightGuard {
    using SafeERC20 for IERC20;

    // ---------- config ----------
    IERC20 public immutable token; // USDT0 (6 decimals on Coston2)
    IFdcVerification public fdcVerification;
    address public owner;

    uint256 public constant DELAY_THRESHOLD_MIN = 120; // >= 2h delay pays out
    uint16 public constant MIN_PREMIUM_BPS = 500; // onchain guardrail: 5%
    uint16 public constant FALLBACK_PREMIUM_BPS = 1000; // 10% flat fallback when route-risk data is unavailable
    uint16 public constant MAX_PREMIUM_BPS = 1500; // onchain guardrail: 15%
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
    // pool (poolBalance/totalLocked/shares) and from the payout reserve below. This balance
    // just accumulates; withdrawFxrpPremiums moves it out, moveFxrpPremiumsToReserve
    // recycles it into the payout reserve.
    uint256 public fxrpPremiums;

    // ---------- FXRP payout side (internal FTSO-priced swap) ----------
    // A traveler can elect to be PAID in FXRP (Policy.payoutInFxrp). Two designs were
    // possible; this is the second, chosen for being both simpler and safer:
    //
    //  (a) A second, FXRP-denominated backer pool (backers deposit FXRP, FXRP policies are
    //      locked against it). This means a parallel set of shares/totalLocked/freeLiquidity,
    //      a per-policy choice of which pool underwrites it, and - the real problem - it puts
    //      FX risk on backers: an FXRP-pool backer's stake is denominated in XRP, so a policy
    //      priced in USDT0 can become under- or over-collateralized purely from XRP moving,
    //      with no way to rebalance between the two pools.
    //
    //  (b) (chosen) The pool stays USDT0-only and 100% of the existing share math is
    //      untouched. When an FXRP-payout policy pays out, the cover's USDT0 does NOT leave
    //      the contract - it is booked to usdt0SwapProceeds (deliberately excluded from
    //      poolBalance()) and an FTSO-equivalent amount of FXRP is sent to the holder out of
    //      fxrpPayoutReserve instead. Economically that is one fair, FTSO-priced swap between
    //      the pool and whoever funded the reserve: the pool pays exactly the USDT0 it always
    //      owed, backers see an identical poolBalance/freeLiquidity either way, and the
    //      reserve provider gives up FXRP and gains an equal-value USDT0 claim.
    //
    // Tradeoff: (b) needs someone to pre-fund fxrpPayoutReserve, and that reserve provider -
    // not backers - carries the XRP/USD move between funding the reserve and reclaiming the
    // USDT0. The upside is that backer solvency, share pricing and the whole USDT0 settlement
    // path are provably unchanged, and an empty/short reserve can never strand a claim:
    // _payOut falls back to paying USDT0 rather than reverting (see FxrpPayoutUnavailable).
    uint256 public fxrpPayoutReserve; // FXRP available to fund FXRP-denominated payouts
    uint256 public usdt0SwapProceeds; // USDT0 held for the reserve provider, NOT part of the pool

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

    /**
     * How well-evidenced a settlement was. Recorded because "the flight was fine" and "we
     * could not find out what happened to the flight" both used to settle as NoPayout and
     * were indistinguishable onchain - a data outage silently denied the claim and looked
     * exactly like an on-time arrival. DataUnavailable makes that case auditable.
     *
     * SingleSource is not a fault condition, just an honest statement: exactly one upstream
     * answered, so nothing independently confirmed it.
     */
    enum Provenance {
        Unsettled, // no proof consumed yet (Active), or expired without one
        Corroborated, // two independent sources agreed on the payout decision
        SingleSource, // one source answered; uncorroborated
        DataUnavailable // no source had a usable record for this flight+date
    }

    string private constant EMPTY_STATUS = "EMPTY";

    struct Policy {
        address holder;
        uint256 coverAmount;
        uint256 premium; // always the USDT0-equivalent amount, even when paid in FXRP
        uint16 premiumBps; // route-risk premium used at purchase time
        uint64 scheduledArrival; // unix ts
        bytes32 requestHash; // keccak of expected FDC request (url+headers+queryParams+jq+abiSig)
        string flightRef; // "IATA|YYYY-MM-DD", lets a keeper rebuild the FDC request without offchain state
        Status status;
        bool premiumInFxrp; // true if premium was paid in FXRP instead of USDT0 (informational only)
        bool payoutInFxrp; // true if a payout should be delivered in FXRP, converted at the
        // live FTSO rate read AT SETTLEMENT TIME (not at purchase)
        Provenance provenance; // evidentiary basis of the settlement; Unsettled until settle()
    }

    Policy[] public policies;

    event Deposited(address indexed backer, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed backer, uint256 amount, uint256 sharesBurned);
    event CoverBought(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmount,
        uint256 premium,
        uint16 premiumBps,
        bytes32 requestHash,
        string flightRef,
        bool payoutInFxrp
    );
    event CoverBoughtWithFXRP(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmount,
        uint256 premiumUsdt0Equivalent,
        uint16 premiumBps,
        uint256 fxrpAmount,
        uint256 xrpUsdPriceWei,
        uint256 usdtUsdPriceWei,
        bool payoutInFxrp
    );
    event Settled(uint256 indexed policyId, Status result, uint256 delayMinutes, bool cancelled);
    /**
     * The data behind a settlement, emitted on every settle(). `provenance` is indexed so the
     * whole history can be filtered for uncorroborated or data-starved settlements without
     * reading policies one by one - i.e. so single-sourcing is auditable, not just disclosed.
     */
    event SettlementEvidence(uint256 indexed policyId, Provenance indexed provenance, string source);
    /** Emitted instead of a plain USDT0 transfer when an FXRP-payout policy pays out.
     *  coverAmountUsdt0 is what the pool owed; fxrpAmount is what the holder received, at
     *  the XRP/USD + USDT/USD rates read in this very transaction. */
    event PaidOutInFxrp(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmountUsdt0,
        uint256 fxrpAmount,
        uint256 xrpUsdPriceWei,
        uint256 usdtUsdPriceWei
    );
    /** An FXRP-payout policy that had to be paid in USDT0 after all - the reserve was short,
     *  or the FTSO read failed/returned zero (fxrpAmountNeeded == 0 in that case). The claim
     *  is always honoured; only the asset falls back. */
    event FxrpPayoutUnavailable(uint256 indexed policyId, uint256 fxrpAmountNeeded, uint256 fxrpReserveAvailable);
    event FxrpPayoutReserveFunded(address indexed from, uint256 amount, uint256 newReserve);
    event FxrpPayoutReserveWithdrawn(address indexed to, uint256 amount, uint256 newReserve);
    event SwapProceedsWithdrawn(address indexed to, uint256 amount);

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

    /**
     * USDT0 that actually belongs to the pool. usdt0SwapProceeds is netted out because that
     * USDT0 is only sitting here as the other leg of an FXRP payout already delivered - it
     * belongs to the reserve provider, not to backers. Netting it here (rather than
     * transferring it out inside settle()) is what makes an FXRP payout arithmetically
     * identical to a USDT0 one from the pool's point of view: same poolBalance, same
     * freeLiquidity, same share price, in both cases.
     */
    function poolBalance() public view returns (uint256) {
        return token.balanceOf(address(this)) - usdt0SwapProceeds;
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
     *
     * payoutInFxrp picks the asset a payout is delivered in, independently of the asset the
     * premium is paid in: cover stays USDT0-denominated either way, and the FXRP conversion
     * (if any) happens at settlement, not here.
     */
    function buyCover(
        uint256 coverAmount,
        uint16 premiumBps,
        uint64 scheduledArrival,
        bytes32 requestHash,
        string calldata flightRef,
        bool payoutInFxrp
    ) external returns (uint256 policyId) {
        require(coverAmount > 0 && coverAmount <= MAX_COVER, "cover out of range");
        require(premiumBps >= MIN_PREMIUM_BPS && premiumBps <= MAX_PREMIUM_BPS, "premium out of range");
        require(scheduledArrival > block.timestamp, "flight in past");
        require(coverAmount <= freeLiquidity(), "insufficient pool");

        uint256 premium = previewPremium(coverAmount, premiumBps);
        token.safeTransferFrom(msg.sender, address(this), premium); // premium accrues to pool

        policyId = _openPolicy(
            coverAmount,
            premium,
            premiumBps,
            scheduledArrival,
            requestHash,
            flightRef,
            false,
            payoutInFxrp
        );
        emit CoverBought(policyId, msg.sender, coverAmount, premium, premiumBps, requestHash, flightRef, payoutInFxrp);
    }

    /**
     * Same terms as buyCover (cover stays USDT0-denominated, route-risk premiumBps bounded
     * onchain), but the premium is paid in FXRP instead. The risk-adjusted USDT0 premium is
     * computed first, then converted at the live FTSO XRP/USD and USDT/USD rates (see
     * FXRP_PROXY_FEED_ID/USDT0_PROXY_FEED_ID above). The FXRP collected is tracked in
     * fxrpPremiums, entirely separate from the USDT0 pool - the cover itself is always
     * backed by the USDT0 pool regardless of how the premium was paid.
     *
     * The two directions are independent: payoutInFxrp is a separate choice, so paying in
     * FXRP and being paid out in USDT0 (or vice versa) are both valid.
     */
    function buyCoverWithFXRP(
        uint256 coverAmount,
        uint16 premiumBps,
        uint64 scheduledArrival,
        bytes32 requestHash,
        string calldata flightRef,
        bool payoutInFxrp
    ) external returns (uint256 policyId) {
        require(coverAmount > 0 && coverAmount <= MAX_COVER, "cover out of range");
        require(premiumBps >= MIN_PREMIUM_BPS && premiumBps <= MAX_PREMIUM_BPS, "premium out of range");
        require(scheduledArrival > block.timestamp, "flight in past");
        require(coverAmount <= freeLiquidity(), "insufficient pool");

        (uint256 premiumUsdt0, uint256 fxrpAmount, uint256 xrpUsdPrice, uint256 usdtUsdPrice) = previewFxrpPremium(
            coverAmount,
            premiumBps
        );
        require(fxrpAmount > 0, "premium rounds to zero FXRP");

        fxrpToken.safeTransferFrom(msg.sender, address(this), fxrpAmount);
        fxrpPremiums += fxrpAmount;

        policyId = _openPolicy(
            coverAmount,
            premiumUsdt0,
            premiumBps,
            scheduledArrival,
            requestHash,
            flightRef,
            true,
            payoutInFxrp
        );
        emit CoverBoughtWithFXRP(
            policyId,
            msg.sender,
            coverAmount,
            premiumUsdt0,
            premiumBps,
            fxrpAmount,
            xrpUsdPrice,
            usdtUsdPrice,
            payoutInFxrp
        );
    }

    /**
     * Quotes the FXRP amount buyCoverWithFXRP(coverAmount, premiumBps, ...) would currently
     * charge, plus the raw 18-decimal-normalized FTSO prices used (so the UI can show its
     * source). Not `view`: FtsoV2's getFeedByIdInWei is declared `payable` (some feeds
     * carry a FeeCalculator fee; ours don't, so this is called with 0 value), which
     * Solidity treats as non-view - but it performs no state writes, so callers still read
     * it with a plain eth_call.
     */
    function previewFxrpPremium(
        uint256 coverAmount,
        uint16 premiumBps
    )
        public
        returns (uint256 premiumUsdt0Equivalent, uint256 fxrpAmount, uint256 xrpUsdPriceWei, uint256 usdtUsdPriceWei)
    {
        premiumUsdt0Equivalent = previewPremium(coverAmount, premiumBps);

        // getFeedByIdInWei normalizes every feed to 18 decimals regardless of its native
        // precision, so no raw `decimals` field needs handling here.
        (uint256 xrpPriceWei, ) = ftsoV2.getFeedByIdInWei(FXRP_PROXY_FEED_ID);
        (uint256 usdtPriceWei, ) = ftsoV2.getFeedByIdInWei(USDT0_PROXY_FEED_ID);
        require(xrpPriceWei > 0 && usdtPriceWei > 0, "bad FTSO price");

        fxrpAmount = _usdt0ToFxrp(premiumUsdt0Equivalent, xrpPriceWei, usdtPriceWei);
        xrpUsdPriceWei = xrpPriceWei;
        usdtUsdPriceWei = usdtPriceWei;
    }

    /**
     * FXRP a given USDT0 amount is worth at the current FTSO rates - the same conversion
     * settle() applies to coverAmount for an FXRP-payout policy. Quoting it here is only an
     * estimate for the UI: the rate that actually decides the payout is read inside the
     * settle() transaction itself, so this number moves with XRP/USD right up to settlement.
     * Non-`view` for the same reason previewFxrpPremium is (payable getFeedByIdInWei), but
     * writes nothing, so a plain eth_call reads it.
     */
    function previewFxrpPayout(
        uint256 usdt0Amount
    ) public returns (uint256 fxrpAmount, uint256 xrpUsdPriceWei, uint256 usdtUsdPriceWei) {
        (uint256 xrpPriceWei, ) = ftsoV2.getFeedByIdInWei(FXRP_PROXY_FEED_ID);
        (uint256 usdtPriceWei, ) = ftsoV2.getFeedByIdInWei(USDT0_PROXY_FEED_ID);
        require(xrpPriceWei > 0 && usdtPriceWei > 0, "bad FTSO price");

        fxrpAmount = _usdt0ToFxrp(usdt0Amount, xrpPriceWei, usdtPriceWei);
        xrpUsdPriceWei = xrpPriceWei;
        usdtUsdPriceWei = usdtPriceWei;
    }

    /**
     * usdt0Amount (USDT0 base units) * usdtPrice / xrpPrice, rescaled from USDT0's decimals
     * to FXRP's decimals in one multiply-then-divide chain to avoid compounding rounding
     * error across separate steps.
     */
    function _usdt0ToFxrp(
        uint256 usdt0Amount,
        uint256 xrpPriceWei,
        uint256 usdtPriceWei
    ) internal pure returns (uint256) {
        return (usdt0Amount * usdtPriceWei * (10 ** FXRP_DECIMALS)) / ((10 ** USDT0_DECIMALS) * xrpPriceWei);
    }

    /**
     * Non-reverting variant of the conversion above, for use inside settle(). A payout must
     * never be blocked by an oracle hiccup, so a reverting or zero feed returns ok=false and
     * the caller pays in USDT0 instead of failing the settlement.
     */
    function _tryUsdt0ToFxrp(
        uint256 usdt0Amount
    ) internal returns (bool ok, uint256 fxrpAmount, uint256 xrpPriceWei, uint256 usdtPriceWei) {
        try ftsoV2.getFeedByIdInWei(FXRP_PROXY_FEED_ID) returns (uint256 xrpValue, uint64) {
            xrpPriceWei = xrpValue;
        } catch {
            return (false, 0, 0, 0);
        }
        try ftsoV2.getFeedByIdInWei(USDT0_PROXY_FEED_ID) returns (uint256 usdtValue, uint64) {
            usdtPriceWei = usdtValue;
        } catch {
            return (false, 0, xrpPriceWei, 0);
        }
        if (xrpPriceWei == 0 || usdtPriceWei == 0) return (false, 0, xrpPriceWei, usdtPriceWei);
        return (true, _usdt0ToFxrp(usdt0Amount, xrpPriceWei, usdtPriceWei), xrpPriceWei, usdtPriceWei);
    }

    function previewPremium(uint256 coverAmount, uint16 premiumBps) public pure returns (uint256) {
        require(premiumBps >= MIN_PREMIUM_BPS && premiumBps <= MAX_PREMIUM_BPS, "premium out of range");
        return (coverAmount * premiumBps) / 10_000;
    }

    function _openPolicy(
        uint256 coverAmount,
        uint256 premium,
        uint16 premiumBps,
        uint64 scheduledArrival,
        bytes32 requestHash,
        string calldata flightRef,
        bool premiumInFxrp,
        bool payoutInFxrp
    ) internal returns (uint256 policyId) {
        totalLocked += coverAmount;
        policies.push(
            Policy({
                holder: msg.sender,
                coverAmount: coverAmount,
                premium: premium,
                premiumBps: premiumBps,
                scheduledArrival: scheduledArrival,
                requestHash: requestHash,
                flightRef: flightRef,
                status: Status.Active,
                premiumInFxrp: premiumInFxrp,
                payoutInFxrp: payoutInFxrp,
                provenance: Provenance.Unsettled
            })
        );
        policyId = policies.length - 1;
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

        // "EMPTY" is what the attested jq emits when no source had a usable record for this
        // flight+date (or the date-lock rejected what they did have). It fails both payout
        // conditions below, so the claim pays nothing - but it pays nothing because the data
        // was missing, NOT because the flight was fine, and the two must not look alike
        // onchain. Recording it is deliberately all this does: whether a data outage should
        // instead leave the policy Active to be retried within the claim window is a payout
        // -semantics question, and is called out as such in the README rather than decided
        // quietly here.
        bool dataUnavailable = keccak256(bytes(dto.flightStatus)) == keccak256(bytes(EMPTY_STATUS));
        p.provenance = dataUnavailable
            ? Provenance.DataUnavailable
            : (dto.corroborated ? Provenance.Corroborated : Provenance.SingleSource);

        totalLocked -= p.coverAmount;

        if (cancelled || delayed) {
            p.status = Status.PaidOut;
            _payOut(policyId, p);
        } else {
            p.status = Status.NoPayout; // premium stays in pool
        }
        emit Settled(policyId, p.status, dto.delayMinutes, cancelled);
        emit SettlementEvidence(policyId, p.provenance, dto.source);
    }

    /**
     * Delivers a payout in the asset the holder chose at purchase.
     *
     * USDT0 (default): unchanged - coverAmount leaves the contract to the holder.
     *
     * FXRP: coverAmount is converted at the FTSO rate read in THIS transaction, so the
     * holder receives the XRP-denominated value of their cover as of settlement, not as of
     * purchase. The USDT0 stays put and is booked to usdt0SwapProceeds instead, which
     * poolBalance() nets out - so the pool is left in exactly the state a USDT0 payout would
     * have left it in, and the FXRP comes out of the pre-funded reserve.
     *
     * Called only after status/totalLocked have already been updated (checks-effects-
     * interactions), and every branch here likewise writes state before transferring.
     */
    function _payOut(uint256 policyId, Policy storage p) internal {
        if (p.payoutInFxrp) {
            (bool ok, uint256 fxrpAmount, uint256 xrpPriceWei, uint256 usdtPriceWei) = _tryUsdt0ToFxrp(p.coverAmount);
            // fxrpAmount == 0 only for dust cover; either way, falling back beats stranding
            // the claim.
            if (ok && fxrpAmount > 0 && fxrpAmount <= fxrpPayoutReserve) {
                fxrpPayoutReserve -= fxrpAmount;
                usdt0SwapProceeds += p.coverAmount;
                fxrpToken.safeTransfer(p.holder, fxrpAmount);
                emit PaidOutInFxrp(policyId, p.holder, p.coverAmount, fxrpAmount, xrpPriceWei, usdtPriceWei);
                return;
            }
            emit FxrpPayoutUnavailable(policyId, fxrpAmount, fxrpPayoutReserve);
        }
        token.safeTransfer(p.holder, p.coverAmount);
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

    /**
     * Funds the FXRP payout reserve. onlyOwner on purpose: the reserve provider is also the
     * only party who can reclaim the USDT0 an FXRP payout leaves behind
     * (withdrawSwapProceeds), so keeping both sides of that swap on one account is what makes
     * the accounting unambiguous. A third party funding it would just be donating FXRP.
     */
    function fundFxrpPayoutReserve(uint256 amount) external onlyOwner {
        require(amount > 0, "zero");
        fxrpToken.safeTransferFrom(msg.sender, address(this), amount);
        fxrpPayoutReserve += amount;
        emit FxrpPayoutReserveFunded(msg.sender, amount, fxrpPayoutReserve);
    }

    function withdrawFxrpPayoutReserve(address to, uint256 amount) external onlyOwner {
        require(amount <= fxrpPayoutReserve, "exceeds reserve");
        fxrpPayoutReserve -= amount;
        fxrpToken.safeTransfer(to, amount);
        emit FxrpPayoutReserveWithdrawn(to, amount, fxrpPayoutReserve);
    }

    /** Recycles FXRP taken in as premium into the FXRP available for payouts - both are
     *  contract-held FXRP, so this is a pure bookkeeping move, no transfer. */
    function moveFxrpPremiumsToReserve(uint256 amount) external onlyOwner {
        require(amount <= fxrpPremiums, "exceeds fxrpPremiums");
        fxrpPremiums -= amount;
        fxrpPayoutReserve += amount;
        emit FxrpPayoutReserveFunded(address(this), amount, fxrpPayoutReserve);
    }

    /** Claims the USDT0 left in the contract as the other leg of FXRP payouts already made.
     *  poolBalance() has already excluded this, so it can never draw on backer funds. */
    function withdrawSwapProceeds(address to, uint256 amount) external onlyOwner {
        require(amount <= usdt0SwapProceeds, "exceeds swap proceeds");
        usdt0SwapProceeds -= amount;
        token.safeTransfer(to, amount);
        emit SwapProceedsWithdrawn(to, amount);
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }
}
