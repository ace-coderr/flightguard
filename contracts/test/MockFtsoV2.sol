// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Stands in for ContractRegistry's real FtsoV2 in tests - settable per-feed prices instead
/// of live consensus data. Matches the getFeedByIdInWei(bytes21) selector FlightGuard
/// actually calls (18-decimal-normalized value + timestamp).
contract MockFtsoV2 {
    mapping(bytes21 => uint256) public pricesWei;

    function setPriceWei(bytes21 feedId, uint256 priceWei) external {
        pricesWei[feedId] = priceWei;
    }

    function getFeedByIdInWei(bytes21 feedId) external view returns (uint256 _value, uint64 _timestamp) {
        return (pricesWei[feedId], uint64(block.timestamp));
    }
}
