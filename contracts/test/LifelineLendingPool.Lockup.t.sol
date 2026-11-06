// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolTestBase} from "./LifelineLendingPool.Base.t.sol";
import {LifelineLendingPool} from "../src/LifelineLendingPool.sol";

/// @notice Post-deposit lockup: stops a lender from joining just before an interest repayment and
/// leaving right after it. The shared fixture sets lockup to 0; these tests set it explicitly.
contract PoolLockupTest is PoolTestBase {
    uint256 internal constant DEP = 1_000e6;

    function setUp() public override {
        super.setUp();
        vm.warp(1_000_000);
    }

    function _setLockup(uint256 v) internal {
        vm.prank(poolOwner);
        pool.setLockup(v);
    }

    function _lockedErr(uint256 until) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(LifelineLendingPool.LockedUp.selector, until);
    }

    // ------------------------------------------------------------ defaults & setLockup
    function test_DefaultLockup_IsOneDayAfterConstruction() public {
        LifelineLendingPool fresh = new LifelineLendingPool(address(usdc), MAXU, CAP);
        assertEq(fresh.lockup(), 1 days);
        assertEq(fresh.DEFAULT_LOCKUP(), 1 days);
        assertEq(fresh.MAX_LOCKUP(), 7 days);
    }

    function test_DefaultLockup_ConstructorEmitsLockupUpdated() public {
        vm.expectEmit(false, false, false, true);
        emit LifelineLendingPool.LockupUpdated(1 days);
        new LifelineLendingPool(address(usdc), MAXU, CAP);
    }

    function test_Fixture_LockupIsZero() public view {
        assertEq(pool.lockup(), 0);
    }

    function test_SetLockup_MaxAllowed() public {
        _setLockup(7 days);
        assertEq(pool.lockup(), 7 days);
    }

    function test_SetLockup_AboveMax_RevertsLockupTooLong() public {
        vm.prank(poolOwner);
        vm.expectRevert(LifelineLendingPool.LockupTooLong.selector);
        pool.setLockup(7 days + 1);
        assertEq(pool.lockup(), 0, "unchanged");
    }

    function test_SetLockup_NonOwner_RevertsNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(LifelineLendingPool.NotOwner.selector);
        pool.setLockup(1 days);
    }

    function test_SetLockup_EmitsLockupUpdated() public {
        vm.expectEmit(false, false, false, true, address(pool));
        emit LifelineLendingPool.LockupUpdated(3 days);
        _setLockup(3 days);
    }

    function test_SetLockup_ZeroAllowed() public {
        _setLockup(2 days);
        _setLockup(0);
        assertEq(pool.lockup(), 0);
    }

    // ------------------------------------------------------------ withdraw gate
    function test_Deposit_SetsLockedUntil() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        assertEq(pool.lockedUntil(l1), block.timestamp + 1 days);
    }

    function test_Withdraw_RightAfterDeposit_RevertsLockedUp() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        uint256 until = pool.lockedUntil(l1);
        vm.prank(l1);
        vm.expectRevert(_lockedErr(until));
        pool.withdraw(DEP);
        assertEq(usdc.balanceOf(address(pool)), DEP, "funds stay");
    }

    function test_Withdraw_AtLockedUntilMinusOne_RevertsLockedUp() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        uint256 until = pool.lockedUntil(l1);
        vm.warp(until - 1);
        vm.prank(l1);
        vm.expectRevert(_lockedErr(until));
        pool.withdraw(DEP);
    }

    function test_Withdraw_AtExactlyLockedUntil_Works() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        vm.warp(pool.lockedUntil(l1));
        uint256 balBefore = usdc.balanceOf(l1);
        _wd(l1, DEP);
        assertEq(usdc.balanceOf(l1) - balBefore, DEP);
    }

    function test_Withdraw_AfterLockedUntil_Works() public {
        _setLockup(7 days);
        _dep(l1, DEP);
        skip(7 days + 1);
        _wd(l1, DEP / 2);
        assertApproxEqAbs(pool.assetsOf(l1), DEP / 2, 1);
    }

    function test_SecondDeposit_ExtendsLockOnWholePosition() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        uint256 firstUntil = pool.lockedUntil(l1);
        skip(12 hours);
        _dep(l1, 10e6);
        uint256 secondUntil = pool.lockedUntil(l1);
        assertEq(secondUntil, block.timestamp + 1 days);
        assertGt(secondUntil, firstUntil);

        // at the first deadline even a tiny slice of the OLD deposit is still locked
        vm.warp(firstUntil);
        vm.prank(l1);
        vm.expectRevert(_lockedErr(secondUntil));
        pool.withdraw(1e6);

        vm.warp(secondUntil);
        _wd(l1, DEP);
        assertApproxEqAbs(pool.assetsOf(l1), 10e6, 1);
    }

    function test_OneLendersDeposit_DoesNotLockAnother() public {
        _setLockup(1 days);
        _dep(l2, DEP);
        uint256 l2Until = pool.lockedUntil(l2);
        skip(1 days);
        _dep(l1, DEP);
        uint256 l1Until = pool.lockedUntil(l1);
        assertEq(pool.lockedUntil(l2), l2Until, "l2 lock untouched");
        _wd(l2, DEP); // l2 not affected by l1's fresh deposit
        vm.prank(l1);
        vm.expectRevert(_lockedErr(l1Until));
        pool.withdraw(1e6);
    }

    function test_ChangingLockup_AffectsOnlyLaterDeposits() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        uint256 l1Until = pool.lockedUntil(l1);
        _setLockup(7 days);
        assertEq(pool.lockedUntil(l1), l1Until, "existing lock unchanged");
        _dep(l2, DEP);
        uint256 l2Until = pool.lockedUntil(l2);
        assertEq(l2Until, block.timestamp + 7 days);

        vm.warp(l1Until);
        _wd(l1, DEP); // still on the old 1 day terms
        vm.prank(l2);
        vm.expectRevert(_lockedErr(l2Until));
        pool.withdraw(1e6);

        // shortening to zero also leaves earlier locks in place
        _setLockup(0);
        vm.prank(l2);
        vm.expectRevert(_lockedErr(l2Until));
        pool.withdraw(1e6);
    }

    function test_ZeroLockup_WithdrawImmediately() public {
        _dep(l1, DEP);
        assertEq(pool.lockedUntil(l1), block.timestamp);
        _wd(l1, DEP);
        assertApproxEqAbs(usdc.balanceOf(address(pool)), 0, 1);
    }

    // ------------------------------------------------------------ interest sandwich
    function test_InterestSandwich_AttackerCannotWithdrawAfterRepay() public {
        _setLockup(1 days);
        _dep(l1, DEP);
        skip(1 days);
        _draw(borrower, 600e6);

        // attacker joins right before the interest payment...
        _dep(l2, 1_000e6);
        uint256 attackerUntil = pool.lockedUntil(l2);
        _repay(borrower, 600e6, 50e6);

        // ...and cannot leave right after it
        vm.prank(l2);
        vm.expectRevert(_lockedErr(attackerUntil));
        pool.withdraw(1_000e6);

        skip(1 days - 1);
        vm.prank(l2);
        vm.expectRevert(_lockedErr(attackerUntil));
        pool.withdraw(1_000e6);

        // at the deadline the attacker only gets its pro-rata (by shares) cut, not the whole interest
        skip(1);
        uint256 s2 = pool.sharesOf(l2);
        uint256 expectedGain = (50e6 * s2) / (pool.totalShares());
        uint256 got = pool.assetsOf(l2);
        assertApproxEqAbs(got, 1_000e6 + expectedGain, 10);
        assertLt(got - 1_000e6, 50e6, "attacker never takes all the interest");
        assertGt(pool.assetsOf(l1) - DEP, 0, "long-standing lender earned interest too");
    }

    // ------------------------------------------------------------ fuzz
    function testFuzz_Lockup_GateMatchesTimestamp(uint256 lockup, uint256 elapsed) public {
        lockup = bound(lockup, 0, 7 days);
        elapsed = bound(elapsed, 0, 10 days);
        _setLockup(lockup);
        _dep(l1, DEP);
        uint256 until = block.timestamp + lockup;
        assertEq(pool.lockedUntil(l1), until);
        skip(elapsed);
        vm.prank(l1);
        if (elapsed < lockup) {
            vm.expectRevert(_lockedErr(until));
            pool.withdraw(DEP);
        } else {
            pool.withdraw(DEP);
            assertApproxEqAbs(usdc.balanceOf(address(pool)), 0, 1);
        }
    }

    function testFuzz_SetLockup_AboveMaxReverts(uint256 lockup) public {
        lockup = bound(lockup, 7 days + 1, type(uint256).max);
        vm.prank(poolOwner);
        vm.expectRevert(LifelineLendingPool.LockupTooLong.selector);
        pool.setLockup(lockup);
    }

    function testFuzz_SetLockup_WithinMaxStored(uint256 lockup) public {
        lockup = bound(lockup, 0, 7 days);
        _setLockup(lockup);
        assertEq(pool.lockup(), lockup);
    }

    function testFuzz_SecondDeposit_AlwaysResetsToNowPlusLockup(uint256 lockup, uint256 gap) public {
        lockup = bound(lockup, 0, 7 days);
        gap = bound(gap, 0, 30 days);
        _setLockup(lockup);
        _dep(l1, DEP);
        skip(gap);
        _dep(l1, 1e6);
        assertEq(pool.lockedUntil(l1), block.timestamp + lockup);
    }
}
