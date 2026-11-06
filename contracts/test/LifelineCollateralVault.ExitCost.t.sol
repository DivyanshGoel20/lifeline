// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {MockFeeERC4626} from "./mocks/MockFeeERC4626.sol";

/// @notice Yield-mode exit cost: a yield source whose withdrawals lose more than 1 bp (+2 wei) must make
/// `withdraw` and `seize` revert atomically instead of socialising the loss.
contract VaultExitCostTest is VaultTestBase {
    MockFeeERC4626 internal fyv;

    uint256 internal constant DEBT = 400e6;

    function setUp() public override {
        super.setUp();
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 3_000e6);
        fyv = new MockFeeERC4626(address(usdc));
        vm.prank(vaultOwner);
        vault.setYieldVault(address(fyv)); // all funds now sit in the yield vault
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    struct Snap {
        uint256 totalAssets;
        uint256 totalShares;
        uint256 sharesP1;
        uint256 sharesP2;
        uint256 yvShares;
        uint256 yvUsdc;
        uint256 facilityUsdc;
        uint256 rcptUsdc;
        uint256 debt;
        uint256 pendingAssets;
        uint256 pendingReadyAt;
        bool latched;
    }

    function _snap() internal view returns (Snap memory s) {
        s.totalAssets = vault.totalAssets();
        s.totalShares = vault.totalShares();
        s.sharesP1 = vault.sharesOf(P1);
        s.sharesP2 = vault.sharesOf(P2);
        s.yvShares = fyv.balanceOf(address(vault));
        s.yvUsdc = usdc.balanceOf(address(fyv));
        s.facilityUsdc = usdc.balanceOf(address(facility));
        s.rcptUsdc = usdc.balanceOf(rcpt);
        s.debt = _debt(P1);
        (s.pendingAssets, s.pendingReadyAt) = vault.withdrawalOf(P1);
        s.latched = vault.defaultLatched(P1);
    }

    function _assertSame(Snap memory a, Snap memory b) internal pure {
        assertEq(a.totalAssets, b.totalAssets, "totalAssets");
        assertEq(a.totalShares, b.totalShares, "totalShares");
        assertEq(a.sharesP1, b.sharesP1, "sharesP1");
        assertEq(a.sharesP2, b.sharesP2, "sharesP2");
        assertEq(a.yvShares, b.yvShares, "yvShares");
        assertEq(a.yvUsdc, b.yvUsdc, "yvUsdc");
        assertEq(a.facilityUsdc, b.facilityUsdc, "facilityUsdc");
        assertEq(a.rcptUsdc, b.rcptUsdc, "rcptUsdc");
        assertEq(a.debt, b.debt, "debt");
        assertEq(a.pendingAssets, b.pendingAssets, "pendingAssets");
        assertEq(a.pendingReadyAt, b.pendingReadyAt, "pendingReadyAt");
        assertEq(a.latched, b.latched, "latched");
    }

    function _readyWithdraw(uint256 amt) internal {
        _request(c1, P1, amt);
        skip(DELAY);
    }

    function _defaultP1() internal {
        _borrow(P1, DEBT);
        facility.markDefault(P1);
    }

    // ------------------------------------------------------------ 1% fee reverts atomically
    function test_Withdraw_YieldMode_OnePercentFee_RevertsYieldExitCost_Atomic() public {
        _readyWithdraw(500e6);
        fyv.setExitFeeBps(100);
        Snap memory before_ = _snap();

        vm.prank(c1);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.withdraw(P1, rcpt);

        _assertSame(before_, _snap());
        assertEq(before_.pendingAssets, 500e6, "request still pending");
        assertEq(usdc.balanceOf(rcpt), 0);
    }

    function test_Seize_YieldMode_OnePercentFee_RevertsYieldExitCost_Atomic() public {
        _defaultP1();
        fyv.setExitFeeBps(100);
        _request(c1, P1, 200e6);
        Snap memory before_ = _snap();

        vm.prank(stranger);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.seize(P1);

        _assertSame(before_, _snap());
        assertEq(before_.debt, DEBT);
        assertEq(before_.facilityUsdc, 0);
    }

    function test_Seize_YieldMode_OnePercentFee_Latched_RevertsYieldExitCost() public {
        _borrow(P1, DEBT);
        vm.prank(vaultOwner);
        vault.latchDefault(P1);
        fyv.setExitFeeBps(100);
        Snap memory before_ = _snap();

        vm.prank(stranger);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.seize(P1);
        _assertSame(before_, _snap());
        assertTrue(vault.defaultLatched(P1), "latch untouched by reverted seize");
    }

    function test_ExitCost_RecoversWhenFeeDropped() public {
        _defaultP1();
        fyv.setExitFeeBps(100);
        vm.prank(stranger);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.seize(P1);

        fyv.setExitFeeBps(0);
        vm.prank(stranger);
        assertEq(vault.seize(P1), DEBT);
        assertEq(_debt(P1), 0);
    }

    // ------------------------------------------------------------ fee <= 1 bp succeeds
    function test_Withdraw_YieldMode_OneBpFee_Succeeds() public {
        _readyWithdraw(500e6);
        fyv.setExitFeeBps(1);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        assertEq(out, 500e6);
        assertEq(usdc.balanceOf(rcpt), 500e6);
        assertApproxEqAbs(vault.assetsOf(P1), 500e6, 100e6 / 1e4 + 3, "loss bounded by ~1bp");
        // the other profile is not socialised more than ~1bp of the payout
        assertApproxEqAbs(vault.assetsOf(P2), 3_000e6, 500e6 / 1e4 + 3);
    }

    function test_Seize_YieldMode_OneBpFee_Succeeds() public {
        _defaultP1();
        fyv.setExitFeeBps(1);
        vm.prank(stranger);
        assertEq(vault.seize(P1), DEBT);
        assertEq(_debt(P1), 0);
        assertEq(usdc.balanceOf(address(facility)), DEBT);
    }

    function test_Seize_YieldMode_OneBpFee_AfterSuspension_WithLatch_Succeeds() public {
        _borrow(P1, DEBT);
        facility.markDefault(P1);
        vm.prank(stranger);
        vault.latchDefault(P1);
        vm.prank(makeAddr("human1"));
        facility.suspendOwnProfile(P1);
        fyv.setExitFeeBps(1);
        vm.prank(stranger);
        assertEq(vault.seize(P1), DEBT);
        assertFalse(vault.defaultLatched(P1));
    }

    // ------------------------------------------------------------ zero fee: unchanged
    function test_Withdraw_YieldMode_ZeroFee_Unchanged() public {
        _readyWithdraw(500e6);
        uint256 taBefore = vault.totalAssets();
        vm.prank(c1);
        assertEq(vault.withdraw(P1, rcpt), 500e6);
        assertEq(usdc.balanceOf(rcpt), 500e6);
        assertEq(vault.totalAssets(), taBefore - 500e6, "no extra loss");
        assertEq(vault.assetsOf(P1), 500e6);
        assertEq(vault.assetsOf(P2), 3_000e6);
    }

    function test_Seize_YieldMode_ZeroFee_Unchanged() public {
        _defaultP1();
        uint256 taBefore = vault.totalAssets();
        vm.prank(stranger);
        assertEq(vault.seize(P1), DEBT);
        assertEq(vault.totalAssets(), taBefore - DEBT);
        assertEq(usdc.balanceOf(address(facility)), DEBT);
        assertEq(vault.assetsOf(P1), 600e6);
        assertEq(vault.assetsOf(P2), 3_000e6);
    }

    // ------------------------------------------------------------ boundary & fuzz
    function test_Withdraw_YieldMode_TwoBpFee_Reverts() public {
        _readyWithdraw(500e6);
        fyv.setExitFeeBps(2);
        vm.prank(c1);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_PlainMode_FeeIrrelevant() public {
        // back to plain USDC: yield exit fee no longer applies
        vm.prank(vaultOwner);
        vault.setYieldVault(address(0));
        _readyWithdraw(500e6);
        vm.prank(c1);
        assertEq(vault.withdraw(P1, rcpt), 500e6);
    }

    function testFuzz_Withdraw_YieldMode_FeeThreshold(uint256 feeBps, uint256 amt) public {
        feeBps = bound(feeBps, 0, 1_000);
        amt = bound(amt, 100e6, 1_000e6);
        _readyWithdraw(amt);
        fyv.setExitFeeBps(feeBps);
        uint256 taBefore = vault.totalAssets();
        vm.prank(c1);
        if (feeBps <= 1) {
            assertEq(vault.withdraw(P1, rcpt), amt);
            assertEq(usdc.balanceOf(rcpt), amt);
            // total loss never exceeds payout + 1bp + 2 wei
            assertGe(vault.totalAssets() + amt + amt / 1e4 + 2, taBefore);
        } else {
            vm.expectRevert(V.YieldExitCost.selector);
            vault.withdraw(P1, rcpt);
            assertEq(vault.totalAssets(), taBefore);
        }
    }

    function testFuzz_Seize_YieldMode_FeeThreshold(uint256 feeBps, uint256 debt) public {
        feeBps = bound(feeBps, 0, 1_000);
        debt = bound(debt, 100e6, 1_000e6);
        _borrow(P1, debt);
        facility.markDefault(P1);
        fyv.setExitFeeBps(feeBps);
        vm.prank(stranger);
        if (feeBps <= 1) {
            assertEq(vault.seize(P1), debt);
            assertEq(_debt(P1), 0);
        } else {
            vm.expectRevert(V.YieldExitCost.selector);
            vault.seize(P1);
            assertEq(_debt(P1), debt);
        }
    }
}
