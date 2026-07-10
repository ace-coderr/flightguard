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
        uint256 premium;
        uint64 scheduledArrival; // unix ts
        bytes32 requestHash; // keccak of expected FDC request (url+headers+queryParams+jq+abiSig)
        Status status;
    }

    Policy[] public policies;

    event Deposited(address indexed backer, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed backer, uint256 amount, uint256 sharesBurned);
    event CoverBought(
        uint256 indexed policyId,
        address indexed holder,
        uint256 coverAmount,
        uint256 premium,
        bytes32 requestHash
    );
    event Settled(uint256 indexed policyId, Status result, uint256 delayMinutes, bool cancelled);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(IERC20 _token, IFdcVerification _fdcVerification) {
        token = _token;
        fdcVerification = _fdcVerification;
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
        bytes32 requestHash
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
                status: Status.Active
            })
        );
        policyId = policies.length - 1;
        emit CoverBought(policyId, msg.sender, coverAmount, premium, requestHash);
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

    function policyCount() external view returns (uint256) {
        return policies.length;
    }
}
