// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IWeb2Json } from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";

/// Stands in for ContractRegistry's real FdcVerification in tests - skips merkle proof
/// checking entirely and just returns whatever `valid` is set to. Matches the
/// verifyWeb2Json(IWeb2Json.Proof) selector FlightGuard actually calls.
contract MockFdcVerification {
    bool public valid = true;

    function setValid(bool _valid) external {
        valid = _valid;
    }

    function verifyWeb2Json(IWeb2Json.Proof calldata) external view returns (bool) {
        return valid;
    }
}
