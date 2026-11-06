// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LifelineLendingPool} from "../src/LifelineLendingPool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Actor} from "./mocks/Actor.sol";

abstract contract PoolTestBase is Test {
    MockUSDC internal usdc;
    LifelineLendingPool internal pool;

    address internal poolOwner = makeAddr("poolOwner");
    address internal l1 = makeAddr("lender1");
    address internal l2 = makeAddr("lender2");
    address internal l3 = makeAddr("lender3");
    address internal borrower = makeAddr("borrower");
    address internal stranger = makeAddr("stranger");
    address internal rcpt = makeAddr("recipient");

    uint256 internal constant MAXU = 8000;
    uint256 internal constant CAP = 600e6;
    uint256 internal constant FUND = 100_000_000e6;

    function setUp() public virtual {
        usdc = new MockUSDC();
        vm.prank(poolOwner);
        pool = new LifelineLendingPool(address(usdc), MAXU, CAP);
        // The pool defaults to a 1 day lockup; the shared fixture disables it so non-lockup suites
        // can withdraw immediately. Lockup behaviour is covered in LifelineLendingPool.Lockup.t.sol.
        vm.prank(poolOwner);
        pool.setLockup(0);
        _fund(l1);
        _fund(l2);
        _fund(l3);
        _fund(borrower);
        _fund(stranger);
    }

    function _fund(address who) internal {
        usdc.mint(who, FUND);
        vm.prank(who);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _dep(address who, uint256 amt) internal returns (uint256 shares) {
        vm.prank(who);
        shares = pool.deposit(amt);
    }

    function _wd(address who, uint256 amt) internal returns (uint256 shares) {
        vm.prank(who);
        shares = pool.withdraw(amt);
    }

    function _draw(address to, uint256 amt) internal {
        vm.prank(poolOwner);
        pool.draw(to, amt);
    }

    function _repay(address who, uint256 principal, uint256 interest) internal {
        vm.prank(who);
        pool.repay(principal, interest);
    }

    function _writeOff(uint256 amt) internal {
        vm.prank(poolOwner);
        pool.writeOff(amt);
    }

    function _limits(uint256 u, uint256 cap) internal {
        vm.prank(poolOwner);
        pool.setLimits(u, cap);
    }
}
