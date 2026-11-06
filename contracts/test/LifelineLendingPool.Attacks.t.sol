// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolTestBase} from "./LifelineLendingPool.Base.t.sol";
import {LifelineLendingPool as P} from "../src/LifelineLendingPool.sol";
import {Actor} from "./mocks/Actor.sol";

contract PoolAttacksTest is PoolTestBase {
    Actor internal actor;

    // ------------------------------------------------------------ donation / inflation
    function test_Pool_FirstDepositorDonationAttack() public {
        address attacker = l1;
        address victim = l2;
        uint256 donation = 1_000_000e6;
        uint256 victimDeposit = 100_000e6;

        assertGt(_dep(attacker, 1), 0);
        uint256 balBefore = usdc.balanceOf(attacker);
        vm.prank(attacker);
        usdc.transfer(address(pool), donation);

        assertGt(_dep(victim, victimDeposit), 0);

        uint256 vOwn = pool.assetsOf(victim);
        uint256 vBal = usdc.balanceOf(victim);
        _wd(victim, vOwn);
        uint256 victimOut = usdc.balanceOf(victim) - vBal;
        assertApproxEqAbs(victimOut, victimDeposit, 1e6, "victim made whole");
        assertLe(victimOut, victimDeposit);

        uint256 aOwn = pool.assetsOf(attacker);
        _wd(attacker, aOwn);
        uint256 atkTotalIn = 1 + donation;
        assertLt(aOwn, atkTotalIn, "attacker lost money");
        assertGt(atkTotalIn - aOwn, donation / 4, "a large part of the donation is forfeited");
        assertEq(usdc.balanceOf(attacker), balBefore - donation + aOwn);
    }

    function test_Pool_DonationRejectsZeroShareDeposit() public {
        _dep(l1, 1);
        usdc.mint(address(pool), 1e18);
        vm.prank(l2);
        vm.expectRevert(P.ZeroShares.selector);
        pool.deposit(1_000);
    }

    function test_Pool_DonationDoesNotLetAnyoneWithdrawMoreThanShare() public {
        _dep(l1, 1_000e6);
        _dep(l2, 1_000e6);
        usdc.mint(address(pool), 500e6);
        uint256 a1 = pool.assetsOf(l1);
        uint256 a2 = pool.assetsOf(l2);
        assertApproxEqAbs(a1, 1_250e6, 2);
        assertLe(a1 + a2, pool.totalAssets());

        vm.prank(l1);
        vm.expectRevert(P.ExceedsBalance.selector);
        pool.withdraw(a1 + 1);
        // the donor, holding no shares, gets nothing back
        vm.prank(stranger);
        vm.expectRevert(P.ExceedsBalance.selector);
        pool.withdraw(1);

        _wd(l1, a1);
        _wd(l2, pool.assetsOf(l2));
        assertLe(usdc.balanceOf(address(pool)), 4, "only dust remains");
    }

    // ------------------------------------------------------------ reentrancy
    function _setupActor() internal {
        actor = new Actor();
        usdc.mint(address(actor), 10_000e6);
        actor.approveToken(address(usdc), address(pool), type(uint256).max);
    }

    function _inner(uint256 i) internal view returns (bytes memory) {
        if (i == 0) return abi.encodeCall(pool.deposit, (1e6));
        if (i == 1) return abi.encodeCall(pool.withdraw, (1));
        if (i == 2) return abi.encodeCall(pool.repay, (0, 1));
        if (i == 3) return abi.encodeCall(pool.draw, (rcpt, 1));
        return abi.encodeCall(pool.writeOff, (1));
    }

    function _arm(uint256 i, bool after_) internal {
        usdc.setHook(address(actor), abi.encodeCall(Actor.react, (address(pool), _inner(i))), after_);
    }

    /// the guard must fire. For inner calls 3/4 the actor is the owner, so the owner check passes first.
    function _assertGuarded() internal view {
        assertEq(usdc.hookFired(), 1, "hook fired once");
        assertTrue(usdc.hookOk());
        assertEq(actor.reactCount(), 1);
        assertFalse(actor.lastOk(), "reentrant call must fail");
        assertEq(actor.lastSelector(), P.Reentrancy.selector);
    }

    function test_Reentrancy_DuringDeposit() public {
        _setupActor();
        vm.prank(poolOwner);
        pool.transferOwnership(address(actor)); // so owner-only inner calls reach the guard
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = 0; j < 2; j++) {
                uint256 snap = vm.snapshotState();
                _arm(i, j == 1);
                actor.exec(address(pool), abi.encodeCall(pool.deposit, (100e6)));
                _assertGuarded();
                assertEq(pool.assetsOf(address(actor)), 100e6);
                assertEq(pool.totalAssets(), 100e6);
                assertEq(usdc.balanceOf(address(pool)), 100e6);
                vm.revertToState(snap);
            }
        }
    }

    function test_Reentrancy_DuringWithdraw() public {
        _setupActor();
        vm.prank(poolOwner);
        pool.transferOwnership(address(actor));
        actor.exec(address(pool), abi.encodeCall(pool.deposit, (1_000e6)));
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = 0; j < 2; j++) {
                uint256 snap = vm.snapshotState();
                uint256 bal = usdc.balanceOf(address(actor));
                _arm(i, j == 1);
                actor.exec(address(pool), abi.encodeCall(pool.withdraw, (400e6)));
                _assertGuarded();
                assertEq(usdc.balanceOf(address(actor)) - bal, 400e6);
                assertEq(pool.assetsOf(address(actor)), 600e6);
                assertEq(pool.totalAssets(), 600e6);
                vm.revertToState(snap);
            }
        }
    }

    function test_Reentrancy_DuringRepay() public {
        _setupActor();
        vm.prank(poolOwner);
        pool.transferOwnership(address(actor));
        _dep(l1, 1_000e6);
        actor.exec(address(pool), abi.encodeCall(pool.draw, (rcpt, 300e6)));
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = 0; j < 2; j++) {
                uint256 snap = vm.snapshotState();
                _arm(i, j == 1);
                actor.exec(address(pool), abi.encodeCall(pool.repay, (300e6, 20e6)));
                _assertGuarded();
                assertEq(pool.outstanding(), 0);
                assertEq(pool.totalInterestEarned(), 20e6);
                assertEq(pool.totalAssets(), 1_020e6);
                assertEq(usdc.balanceOf(address(pool)), 1_020e6);
                vm.revertToState(snap);
            }
        }
    }

    function test_Reentrancy_DuringDraw() public {
        _setupActor();
        vm.prank(poolOwner);
        pool.transferOwnership(address(actor));
        _dep(l1, 1_000e6);
        for (uint256 i = 0; i < 5; i++) {
            uint256 snap = vm.snapshotState();
            _arm(i, false);
            actor.exec(address(pool), abi.encodeCall(pool.draw, (rcpt, 300e6)));
            _assertGuarded();
            assertEq(pool.outstanding(), 300e6, "no double draw");
            assertEq(usdc.balanceOf(rcpt), 300e6);
            assertEq(pool.totalAssets(), 1_000e6);
            vm.revertToState(snap);
        }
    }

    function test_Reentrancy_DrawHookAfterTransfer() public {
        // same, with the callback fired after the balance moved (state already updated)
        _setupActor();
        vm.prank(poolOwner);
        pool.transferOwnership(address(actor));
        _dep(l1, 1_000e6);
        _arm(3, true);
        actor.exec(address(pool), abi.encodeCall(pool.draw, (rcpt, 300e6)));
        _assertGuarded();
        assertEq(pool.outstanding(), 300e6);
    }
}
