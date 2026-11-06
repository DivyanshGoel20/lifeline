// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice Generic contract account used as controller / lender / owner in reentrancy tests.
/// `exec` forwards a call (bubbling reverts); `react` is the hook target: it forwards a call and
/// records the outcome instead of reverting, so the outer transaction can continue.
contract Actor {
    bool public lastOk;
    bytes public lastRet;
    uint256 public reactCount;

    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function react(address target, bytes calldata data) external {
        reactCount++;
        (lastOk, lastRet) = target.call(data);
    }

    function approveToken(address token, address spender, uint256 amt) external {
        MockUSDC(token).approve(spender, amt);
    }

    function lastSelector() external view returns (bytes4) {
        bytes memory r = lastRet;
        return bytes4(r);
    }
}
