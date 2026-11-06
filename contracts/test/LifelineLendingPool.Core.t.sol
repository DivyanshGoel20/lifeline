// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolTestBase} from "./LifelineLendingPool.Base.t.sol";
import {LifelineLendingPool as P} from "../src/LifelineLendingPool.sol";

contract PoolCoreTest is PoolTestBase {
    // ------------------------------------------------------------ constructor
    function test_Constructor_SetsState() public view {
        assertEq(pool.usdc(), address(usdc));
        assertEq(pool.owner(), poolOwner);
        assertEq(pool.maxUtilizationBps(), MAXU);
        assertEq(pool.exposureCap(), CAP);
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.totalShares(), 0);
        assertEq(pool.outstanding(), 0);
        assertEq(pool.utilizationBps(), 0);
        assertEq(pool.drawable(), 0);
    }

    function test_Constructor_EmitsEvents() public {
        vm.expectEmit(true, true, false, false);
        emit P.OwnershipTransferred(address(0), address(this));
        vm.expectEmit(false, false, false, true);
        emit P.LimitsUpdated(10_000, 5);
        new P(address(usdc), 10_000, 5);
    }

    function test_Constructor_Reverts() public {
        vm.expectRevert(P.ZeroAddress.selector);
        new P(address(0), MAXU, CAP);
        vm.expectRevert(P.NotAContract.selector);
        new P(stranger, MAXU, CAP);
        vm.expectRevert(P.InvalidUtilization.selector);
        new P(address(usdc), 0, CAP);
        vm.expectRevert(P.InvalidUtilization.selector);
        new P(address(usdc), 10_001, CAP);
    }

    // ------------------------------------------------------------ deposit
    function test_Deposit_Happy() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit P.Deposited(l1, 1_000e6, 1_000e12);
        uint256 s = _dep(l1, 1_000e6);
        assertEq(s, 1_000e12);
        assertEq(pool.sharesOf(l1), s);
        assertEq(pool.totalShares(), s);
        assertEq(pool.assetsOf(l1), 1_000e6);
        assertEq(pool.cash(), 1_000e6);
        assertEq(pool.totalAssets(), 1_000e6);
        assertEq(usdc.balanceOf(address(pool)), 1_000e6);
        // later depositor enters at the same price
        assertEq(_dep(l2, 500e6), 500e12);
        assertEq(pool.assetsOf(l1), 1_000e6);
        assertEq(pool.assetsOf(l2), 500e6);
    }

    function test_Deposit_Reverts() public {
        vm.prank(l1);
        vm.expectRevert(P.ZeroAmount.selector);
        pool.deposit(0);

        address nobody = makeAddr("nobody"); // no balance / allowance
        vm.prank(nobody);
        vm.expectRevert(P.TokenCallFailed.selector);
        pool.deposit(1e6);

        usdc.setBlocked(l1, true);
        vm.prank(l1);
        vm.expectRevert(P.TokenCallFailed.selector);
        pool.deposit(1e6);
    }

    function test_Deposit_RevertsZeroShares() public {
        _dep(l1, 1_000e6);
        usdc.mint(address(pool), 1e18);
        vm.prank(l2);
        vm.expectRevert(P.ZeroShares.selector);
        pool.deposit(1);
    }

    function test_Deposit_RevertsOnFeeOnTransfer() public {
        usdc.setTransferFeeBps(100);
        vm.prank(l1);
        vm.expectRevert(P.TransferAmountMismatch.selector);
        pool.deposit(100e6);
    }

    // ------------------------------------------------------------ withdraw
    function test_Withdraw_Happy() public {
        _dep(l1, 1_000e6);
        uint256 bal = usdc.balanceOf(l1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit P.Withdrawn(l1, 400e6, 400e12);
        uint256 s = _wd(l1, 400e6);
        assertEq(s, 400e12);
        assertEq(usdc.balanceOf(l1), bal + 400e6);
        assertEq(pool.assetsOf(l1), 600e6);
        assertEq(pool.totalShares(), 600e12);
        _wd(l1, 600e6);
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.totalShares(), 0);
    }

    function test_Withdraw_Reverts() public {
        _dep(l1, 1_000e6);
        _dep(l2, 1_000e6);
        vm.startPrank(l1);
        vm.expectRevert(P.ZeroAmount.selector);
        pool.withdraw(0);
        vm.expectRevert(P.ExceedsBalance.selector);
        pool.withdraw(1_000e6 + 1);
        vm.stopPrank();
        // a stranger holding no shares can't pull other lenders' money
        vm.prank(stranger);
        vm.expectRevert(P.ExceedsBalance.selector);
        pool.withdraw(1);
    }

    function test_Withdraw_LimitedByCash() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 600e6); // cash 400e6, outstanding 600e6
        assertEq(pool.assetsOf(l1), 1_000e6);
        vm.prank(l1);
        vm.expectRevert(P.InsufficientCash.selector);
        pool.withdraw(400e6 + 1);
        _wd(l1, 400e6);
        assertEq(pool.cash(), 0);
        assertEq(pool.assetsOf(l1), 600e6);
        vm.prank(l1);
        vm.expectRevert(P.InsufficientCash.selector);
        pool.withdraw(1);
        // once the borrower repays, the rest can go
        _repay(borrower, 600e6, 0);
        _wd(l1, 600e6);
    }

    function test_Withdraw_BlocklistedLenderOnlyBlocksItself() public {
        _dep(l1, 1_000e6);
        _dep(l2, 1_000e6);
        usdc.setBlocked(l1, true);
        vm.prank(l1);
        vm.expectRevert(P.TokenCallFailed.selector);
        pool.withdraw(1e6);
        assertEq(pool.assetsOf(l1), 1_000e6);
        assertEq(_wd(l2, 1_000e6), 1_000e12);
    }

    // ------------------------------------------------------------ repay
    function test_Repay_Happy() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 500e6);
        vm.expectEmit(true, false, false, true, address(pool));
        emit P.Repaid(borrower, 200e6, 30e6, 300e6);
        _repay(borrower, 200e6, 30e6);
        assertEq(pool.outstanding(), 300e6);
        assertEq(pool.totalInterestEarned(), 30e6);
        assertEq(pool.cash(), 500e6 + 230e6);
        assertEq(pool.totalAssets(), 1_030e6);
    }

    function test_Repay_InterestOnlyAndPrincipalOnly() public {
        _dep(l1, 1_000e6);
        _repay(stranger, 0, 10e6);
        assertEq(pool.totalInterestEarned(), 10e6);
        assertEq(pool.outstanding(), 0);
        _draw(rcpt, 100e6);
        _repay(stranger, 100e6, 0);
        assertEq(pool.outstanding(), 0);
        assertEq(pool.totalInterestEarned(), 10e6);
    }

    function test_Repay_Reverts() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 100e6);
        vm.startPrank(borrower);
        vm.expectRevert(P.ZeroAmount.selector);
        pool.repay(0, 0);
        vm.expectRevert(P.ExceedsOutstanding.selector);
        pool.repay(100e6 + 1, 0);
        vm.stopPrank();
        vm.prank(borrower);
        usdc.approve(address(pool), 0);
        vm.prank(borrower);
        vm.expectRevert(P.TokenCallFailed.selector);
        pool.repay(1, 0);
    }

    function test_Repay_RevertsOnFeeOnTransfer() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 100e6);
        usdc.setTransferFeeBps(100);
        vm.prank(borrower);
        vm.expectRevert(P.TransferAmountMismatch.selector);
        pool.repay(100e6, 0);
    }

    function test_Interest_RaisesAssetsOfProportionally() public {
        _dep(l1, 1_000e6);
        _dep(l2, 3_000e6);
        _limits(MAXU, 1_000e6);
        _draw(rcpt, 400e6);
        _repay(borrower, 400e6, 400e6);
        assertEq(pool.totalAssets(), 4_400e6);
        assertApproxEqAbs(pool.assetsOf(l1), 1_100e6, 2);
        assertApproxEqAbs(pool.assetsOf(l2), 3_300e6, 2);
        assertLe(pool.assetsOf(l1) + pool.assetsOf(l2), pool.totalAssets());
        // a late depositor does not share in earlier interest
        _dep(l3, 4_400e6);
        assertApproxEqAbs(pool.assetsOf(l3), 4_400e6, 2);
        assertApproxEqAbs(pool.assetsOf(l1), 1_100e6, 2);
    }

    // ------------------------------------------------------------ owner functions
    function test_TransferOwnership() public {
        vm.expectEmit(true, true, false, false, address(pool));
        emit P.OwnershipTransferred(poolOwner, stranger);
        vm.prank(poolOwner);
        pool.transferOwnership(stranger);
        assertEq(pool.owner(), stranger);
        vm.prank(poolOwner);
        vm.expectRevert(P.NotOwner.selector);
        pool.setLimits(1, 1);
        vm.prank(stranger);
        pool.setLimits(1, 1);

        vm.prank(stranger);
        vm.expectRevert(P.ZeroAddress.selector);
        pool.transferOwnership(address(0));
    }

    function test_OnlyOwnerFunctions() public {
        _dep(l1, 1_000e6);
        vm.startPrank(stranger);
        vm.expectRevert(P.NotOwner.selector);
        pool.transferOwnership(stranger);
        vm.expectRevert(P.NotOwner.selector);
        pool.setLimits(1, 1);
        vm.expectRevert(P.NotOwner.selector);
        pool.draw(stranger, 1);
        vm.expectRevert(P.NotOwner.selector);
        pool.writeOff(1);
        vm.stopPrank();
        // lenders aren't owners either
        vm.prank(l1);
        vm.expectRevert(P.NotOwner.selector);
        pool.draw(l1, 1);
    }

    function test_SetLimits() public {
        vm.expectEmit(false, false, false, true, address(pool));
        emit P.LimitsUpdated(10_000, 0);
        _limits(10_000, 0);
        assertEq(pool.maxUtilizationBps(), 10_000);
        assertEq(pool.exposureCap(), 0);
        _limits(1, 123);
        assertEq(pool.maxUtilizationBps(), 1);
        vm.startPrank(poolOwner);
        vm.expectRevert(P.InvalidUtilization.selector);
        pool.setLimits(0, 1);
        vm.expectRevert(P.InvalidUtilization.selector);
        pool.setLimits(10_001, 1);
        vm.stopPrank();
    }

    function test_SetLimits_BelowOutstandingOnlyBlocksNewDraws() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 500e6);
        _limits(MAXU, 100e6);
        assertEq(pool.outstanding(), 500e6);
        assertEq(pool.drawable(), 0);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsExposureCap.selector);
        pool.draw(rcpt, 1);
        _wd(l1, 500e6); // lenders unaffected
    }

    // ------------------------------------------------------------ draw
    function test_Draw_Happy() public {
        _dep(l1, 1_000e6);
        vm.expectEmit(true, false, false, true, address(pool));
        emit P.Drawn(rcpt, 300e6, 300e6);
        _draw(rcpt, 300e6);
        assertEq(usdc.balanceOf(rcpt), 300e6);
        assertEq(pool.outstanding(), 300e6);
        assertEq(pool.cash(), 700e6);
        assertEq(pool.totalAssets(), 1_000e6, "draw does not change totalAssets");
        assertEq(pool.utilizationBps(), 3000);
        assertEq(pool.assetsOf(l1), 1_000e6);
    }

    function test_Draw_Reverts() public {
        _dep(l1, 1_000e6);
        vm.startPrank(poolOwner);
        vm.expectRevert(P.ZeroAddress.selector);
        pool.draw(address(0), 1);
        vm.expectRevert(P.ZeroAmount.selector);
        pool.draw(rcpt, 0);
        vm.stopPrank();
    }

    function test_Draw_BlocklistedRecipientReverts() public {
        _dep(l1, 1_000e6);
        usdc.setBlocked(rcpt, true);
        vm.prank(poolOwner);
        vm.expectRevert(P.TokenCallFailed.selector);
        pool.draw(rcpt, 1e6);
        assertEq(pool.outstanding(), 0);
        _wd(l1, 1_000e6); // lenders unaffected
    }

    function test_Draw_ExposureCapBoundaryExact() public {
        _dep(l1, 1_000e6); // util cap 800e6, exposure cap 600e6
        assertEq(pool.drawable(), CAP);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsExposureCap.selector);
        pool.draw(rcpt, CAP + 1);
        _draw(rcpt, CAP);
        assertEq(pool.outstanding(), CAP);
        assertEq(pool.drawable(), 0);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsExposureCap.selector);
        pool.draw(rcpt, 1);
    }

    function test_Draw_UtilizationBoundaryExact() public {
        _dep(l1, 1_000e6);
        _limits(5000, 10_000e6);
        assertEq(pool.drawable(), 500e6);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsUtilization.selector);
        pool.draw(rcpt, 500e6 + 1);
        _draw(rcpt, 500e6);
        assertEq(pool.utilizationBps(), 5000);
        assertEq(pool.drawable(), 0);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsUtilization.selector);
        pool.draw(rcpt, 1);
        // interest raises totalAssets and so opens new headroom: 50% of 1100 = 550
        _repay(borrower, 0, 100e6);
        assertEq(pool.drawable(), 50e6);
        vm.prank(poolOwner);
        vm.expectRevert(P.ExceedsUtilization.selector);
        pool.draw(rcpt, 50e6 + 1);
        _draw(rcpt, 50e6);
    }

    function test_Draw_CashBoundaryExact() public {
        _dep(l1, 1_000e6);
        _limits(10_000, 10_000e6);
        assertEq(pool.drawable(), 1_000e6);
        vm.prank(poolOwner);
        vm.expectRevert(P.InsufficientCash.selector);
        pool.draw(rcpt, 1_000e6 + 1);
        _draw(rcpt, 1_000e6);
        assertEq(pool.cash(), 0);
        assertEq(pool.drawable(), 0);
        assertEq(pool.utilizationBps(), 10_000);
    }

    function test_Drawable_EqualsMaxSuccessfulDraw() public {
        _dep(l1, 1_000e6);
        _limits(7777, 700e6);
        _draw(rcpt, 123_456_789);
        _repay(borrower, 0, 55e6);
        uint256 d = pool.drawable();
        assertGt(d, 0);
        vm.prank(poolOwner);
        vm.expectRevert();
        pool.draw(rcpt, d + 1);
        _draw(rcpt, d);
        assertEq(pool.drawable(), 0);
    }

    function test_UtilizationBps_Math() public {
        _dep(l1, 1_000e6);
        _limits(MAXU, 1_000e6);
        _draw(rcpt, 333e6);
        assertEq(pool.utilizationBps(), 3330);
        _repay(borrower, 0, 1e6); // ta 1001e6 -> 333/1001 = 0.33266 -> 3326
        uint256 out = 333e6;
        uint256 ta = 1_001e6;
        assertEq(pool.utilizationBps(), (out * 10_000) / ta);
        assertEq(pool.utilizationBps(), 3326);
    }

    // ------------------------------------------------------------ writeOff
    function test_WriteOff_Happy() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 400e6);
        vm.expectEmit(false, false, false, true, address(pool));
        emit P.WrittenOff(150e6, 250e6);
        uint256 taBefore = pool.totalAssets();
        _writeOff(150e6);
        assertEq(taBefore - pool.totalAssets(), 150e6, "totalAssets fell by exactly the amount");
        assertEq(pool.totalAssets(), 850e6);
        assertEq(pool.outstanding(), 250e6);
        assertEq(pool.totalWrittenOff(), 150e6);
        assertApproxEqAbs(pool.assetsOf(l1), 850e6, 1);
        assertEq(pool.cash(), 600e6);
    }

    function test_WriteOff_SharedProRata() public {
        _dep(l1, 1_000e6);
        _dep(l2, 3_000e6);
        _limits(MAXU, 4_000e6);
        _draw(rcpt, 2_000e6);
        _writeOff(2_000e6);
        assertApproxEqAbs(pool.assetsOf(l1), 500e6, 2);
        assertApproxEqAbs(pool.assetsOf(l2), 1_500e6, 2);
        assertEq(pool.totalAssets(), 2_000e6);
    }

    function test_WriteOff_Reverts() public {
        _dep(l1, 1_000e6);
        _draw(rcpt, 100e6);
        vm.startPrank(poolOwner);
        vm.expectRevert(P.ZeroAmount.selector);
        pool.writeOff(0);
        vm.expectRevert(P.ExceedsOutstanding.selector);
        pool.writeOff(100e6 + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ native value
    function test_RejectsNativeValue() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(pool).call{value: 1 ether}("");
        assertFalse(ok);
        (ok,) = address(pool).call{value: 1}(abi.encodeCall(pool.deposit, (1e6)));
        assertFalse(ok);
        (ok,) = address(pool).call{value: 1}(abi.encodeCall(pool.repay, (0, 1)));
        assertFalse(ok);
        assertEq(address(pool).balance, 0);
    }

    function test_ForcedNativeBalanceDoesNotAffectAccounting() public {
        _dep(l1, 1_000e6);
        vm.deal(address(pool), 3 ether);
        assertEq(pool.totalAssets(), 1_000e6);
        assertEq(pool.assetsOf(l1), 1_000e6);
    }
}
