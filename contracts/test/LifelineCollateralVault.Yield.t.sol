// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract VaultYieldTest is VaultTestBase {
    MockERC4626 internal yv;

    function setUp() public override {
        super.setUp();
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 3_000e6);
        yv = _mkYield();
    }

    function _enable() internal {
        vm.prank(vaultOwner);
        vault.setYieldVault(address(yv));
    }

    // ------------------------------------------------------------ switching
    function test_SetYieldVault_MovesAllFunds() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.YieldVaultChanged(address(0), address(yv), 4_000e6, 4_000e6);
        _enable();
        assertEq(vault.yieldVault(), address(yv));
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(yv)), 4_000e6);
        assertGt(yv.balanceOf(address(vault)), 0);
        assertEq(vault.totalAssets(), 4_000e6);
        assertEq(vault.assetsOf(P1), 1_000e6);
        assertEq(vault.assetsOf(P2), 3_000e6);
        assertEq(usdc.allowance(address(vault), address(yv)), 0);
    }

    function test_SetYieldVault_BackToPlainMovesAllFunds() public {
        _enable();
        yv.donate(400e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.YieldVaultChanged(address(yv), address(0), 4_400e6, 4_400e6);
        vm.prank(vaultOwner);
        vault.setYieldVault(address(0));
        assertEq(vault.yieldVault(), address(0));
        assertEq(yv.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(vault)), 4_400e6);
        assertEq(vault.totalAssets(), 4_400e6);
        assertApproxEqAbs(vault.assetsOf(P1), 1_100e6, 2);
        assertApproxEqAbs(vault.assetsOf(P2), 3_300e6, 2);
    }

    function test_SetYieldVault_BetweenTwoYieldVaults() public {
        _enable();
        yv.donate(400e6);
        MockERC4626 yv2 = _mkYield();
        vm.prank(vaultOwner);
        vault.setYieldVault(address(yv2));
        assertEq(yv.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(yv2)), 4_400e6);
        assertEq(vault.totalAssets(), 4_400e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_SetYieldVault_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert(V.NotOwner.selector);
        vault.setYieldVault(address(yv));

        vm.startPrank(vaultOwner);
        vm.expectRevert(V.SameYieldVault.selector);
        vault.setYieldVault(address(0));
        vm.expectRevert(V.NotAContract.selector);
        vault.setYieldVault(stranger);
        MockUSDC other = new MockUSDC();
        MockERC4626 bad = new MockERC4626(address(other));
        vm.expectRevert(V.YieldVaultAssetMismatch.selector);
        vault.setYieldVault(address(bad));
        vault.setYieldVault(address(yv));
        vm.expectRevert(V.SameYieldVault.selector);
        vault.setYieldVault(address(yv));
        vm.stopPrank();
    }

    function test_SetYieldVault_MigrationLossReverts() public {
        yv.setDepositFeeBps(100); // 1% skimmed on entry
        vm.prank(vaultOwner);
        vm.expectRevert(V.MigrationLoss.selector);
        vault.setYieldVault(address(yv));
        assertEq(vault.yieldVault(), address(0));
        assertEq(usdc.balanceOf(address(vault)), 4_000e6);
    }

    function test_SetYieldVault_LossWithinOneBpAccepted() public {
        yv.setDepositFeeBps(1); // exactly 1 bp
        _enable();
        assertApproxEqAbs(vault.totalAssets(), 4_000e6, 4_000e6 / 10_000 + 2);
    }

    function test_SetYieldVault_ExitMisbehaveReverts() public {
        _enable();
        yv.setWithdrawShortfall(1);
        _request(c1, P1, 100e6);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.YieldVaultMisbehaved.selector);
        vault.withdraw(P1, rcpt);
    }

    // ------------------------------------------------------------ yield accrues pro rata
    function test_Yield_AccruesProRata() public {
        _enable();
        yv.donate(400e6);
        assertEq(vault.totalAssets(), 4_400e6);
        assertApproxEqAbs(vault.assetsOf(P1), 1_100e6, 2);
        assertApproxEqAbs(vault.assetsOf(P2), 3_300e6, 2);
        assertLe(vault.assetsOf(P1) + vault.assetsOf(P2), vault.totalAssets());
    }

    function test_Yield_LossIsSharedProRata() public {
        _enable();
        yv.lose(400e6);
        assertEq(vault.totalAssets(), 3_600e6);
        assertApproxEqAbs(vault.assetsOf(P1), 900e6, 2);
        assertApproxEqAbs(vault.assetsOf(P2), 2_700e6, 2);
    }

    function test_Yield_LateDepositorDoesNotShareEarlierYield() public {
        _enable();
        yv.donate(400e6);
        _dep(c3, P3, 4_400e6);
        assertApproxEqAbs(vault.assetsOf(P3), 4_400e6, 2);
        assertApproxEqAbs(vault.assetsOf(P1), 1_100e6, 2);
        assertEq(usdc.balanceOf(address(vault)), 0, "deposit forwarded to yield vault");
        assertEq(usdc.balanceOf(address(yv)), 4_000e6 + 400e6 + 4_400e6);
    }

    // ------------------------------------------------------------ withdraw / seize in yield mode
    function test_Yield_WithdrawPaysFromYieldVault() public {
        _enable();
        yv.donate(400e6);
        uint256 want = vault.assetsOf(P1);
        uint256 out = _exit(c1, P1, rcpt, want);
        assertEq(out, want);
        assertEq(usdc.balanceOf(rcpt), want);
        assertApproxEqAbs(want, 1_100e6, 2);
        assertApproxEqAbs(vault.assetsOf(P2), 3_300e6, 3);
        assertEq(usdc.balanceOf(address(vault)), 0, "vault stays fully invested");
    }

    function test_Yield_WithdrawRespectsLtv() public {
        _enable();
        yv.donate(400e6);
        _borrow(P1, 500e6); // P1 now worth ~1100 -> must keep >= 1000
        _request(c1, P1, 200e6);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);
        assertEq(_exit(c1, P1, rcpt, 90e6), 90e6);
    }

    function test_Yield_SeizeRepaysFacilityFromYieldVault() public {
        _enable();
        yv.donate(400e6);
        _borrow(P1, 300e6);
        facility.markDefault(P1);
        uint256 before_ = vault.assetsOf(P1);

        vm.prank(stranger);
        uint256 seized = vault.seize(P1);
        assertEq(seized, 300e6);
        assertEq(_debt(P1), 0);
        assertEq(usdc.balanceOf(address(facility)), 300e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertApproxEqAbs(vault.assetsOf(P1), before_ - 300e6, 3);
        assertApproxEqAbs(vault.assetsOf(P2), 3_300e6, 3);
    }

    function test_Yield_SeizeCollateralBelowDebt() public {
        _enable();
        _borrow(P3, 400e6);
        _dep(c3, P3, 100e6);
        facility.markDefault(P3);
        assertEq(vault.seize(P3), 100e6);
        assertEq(_debt(P3), 300e6);
        assertEq(vault.assetsOf(P3), 0);
    }

    function test_Yield_FullExitEveryoneThenDisable() public {
        _enable();
        yv.donate(100e6);
        _exit(c1, P1, rcpt, vault.assetsOf(P1));
        _exit(c2, P2, rcpt, vault.assetsOf(P2));
        // nothing but dust is left
        assertLe(vault.totalAssets(), 105);
        vm.prank(vaultOwner);
        vault.setYieldVault(address(0));
        assertEq(yv.balanceOf(address(vault)), 0);
        assertLe(usdc.balanceOf(rcpt), 4_100e6);
    }
}
