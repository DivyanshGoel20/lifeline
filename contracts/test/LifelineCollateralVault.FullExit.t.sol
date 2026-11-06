// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {MockFeeERC4626} from "./mocks/MockFeeERC4626.sol";

/// @notice Yield-mode entry cost (`YieldEntryCost`) and whole-position exits, where the exiting
/// profile bears the yield source's exit cost and `withdraw` / `seize` pay `min(assets, idle)`.
contract VaultFullExitTest is VaultTestBase {
    MockFeeERC4626 internal fyv;

    uint256 internal constant DEP = 1_000e6;

    function setUp() public override {
        super.setUp();
        fyv = new MockFeeERC4626(address(usdc));
    }

    // ------------------------------------------------------------ helpers
    function _yieldOn() internal {
        vm.prank(vaultOwner);
        vault.setYieldVault(address(fyv));
    }

    function _defaultP1(uint256 debt) internal {
        _borrow(P1, debt);
        facility.markDefault(P1);
    }

    function _grossPosition() internal view returns (uint256) {
        return fyv.convertToAssets(fyv.balanceOf(address(vault)));
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
        (s.pendingAssets,) = vault.withdrawalOf(P1);
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
        assertEq(a.pendingAssets, b.pendingAssets, "pending");
    }

    /// @dev P1 sole depositor in a yield vault with exit fee `feeBps`; P1 defaults with `debt` >= its
    /// deposit; seize repays the net proceeds of the whole-position exit.
    function _soleSeize(uint256 feeBps, uint256 amt, uint256 debt) internal {
        _dep(c1, P1, amt);
        _yieldOn();
        fyv.setExitFeeBps(feeBps);
        _defaultP1(debt);

        uint256 collateral = vault.assetsOf(P1);
        assertLe(collateral, debt, "collateral <= debt");
        uint256 gross = _grossPosition();
        uint256 expectedPay = gross - (gross * feeBps) / 10_000;
        uint256 held = vault.sharesOf(P1);
        uint256 facBefore = usdc.balanceOf(address(facility));
        uint256 callerBefore = usdc.balanceOf(stranger);

        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Seized(P1, stranger, expectedPay, held, debt - expectedPay);
        vm.prank(stranger);
        uint256 paid = vault.seize(P1);

        assertEq(paid, expectedPay, "return = net proceeds");
        assertEq(_debt(P1), debt - expectedPay, "debt fell by net proceeds");
        assertEq(usdc.balanceOf(address(facility)) - facBefore, expectedPay, "facility received net");
        assertEq(usdc.balanceOf(stranger), callerBefore, "caller gets nothing");
        assertEq(vault.sharesOf(P1), 0, "profile shares burned");
        assertEq(vault.totalShares(), 0, "no shares left");
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle left");
        assertEq(fyv.balanceOf(address(vault)), 0, "yield position emptied");
    }

    // ------------------------------------------------------------ entry cost
    function test_Deposit_YieldMode_OnePercentEntryFee_RevertsYieldEntryCost_Atomic() public {
        _yieldOn();
        fyv.setEntryFeeBps(100);
        Snap memory before_ = _snap();
        uint256 c1Before = usdc.balanceOf(c1);

        vm.prank(c1);
        vm.expectRevert(V.YieldEntryCost.selector);
        vault.deposit(P1, DEP);

        _assertSame(before_, _snap());
        assertEq(usdc.balanceOf(c1), c1Before, "depositor keeps funds");
    }

    function test_Deposit_YieldMode_TwoBpEntryFee_RevertsYieldEntryCost() public {
        _yieldOn();
        fyv.setEntryFeeBps(2);
        vm.prank(c1);
        vm.expectRevert(V.YieldEntryCost.selector);
        vault.deposit(P1, DEP);
        assertEq(vault.sharesOf(P1), 0);
    }

    function test_Deposit_YieldMode_EntryFee_RevertsWithExistingDepositor() public {
        _dep(c2, P2, 3_000e6);
        _yieldOn();
        fyv.setEntryFeeBps(100);
        Snap memory before_ = _snap();
        vm.prank(c1);
        vm.expectRevert(V.YieldEntryCost.selector);
        vault.deposit(P1, DEP);
        _assertSame(before_, _snap());
    }

    function test_Deposit_YieldMode_OneBpEntryFee_Succeeds() public {
        _yieldOn();
        fyv.setEntryFeeBps(1);
        uint256 shares = _dep(c1, P1, DEP);
        assertGt(shares, 0);
        assertApproxEqAbs(vault.assetsOf(P1), DEP, DEP / 1e4 + 3, "loses at most ~1bp");
    }

    function test_Deposit_YieldMode_ZeroEntryFee_Succeeds() public {
        _yieldOn();
        _dep(c1, P1, DEP);
        assertApproxEqAbs(vault.assetsOf(P1), DEP, 1);
        assertEq(vault.totalAssets(), DEP);
    }

    function test_Deposit_PlainMode_EntryFeeIrrelevant() public {
        fyv.setEntryFeeBps(100); // yield vault not enabled
        _dep(c1, P1, DEP);
        assertEq(vault.totalAssets(), DEP);
    }

    function testFuzz_Deposit_YieldMode_EntryFeeThreshold(uint256 feeBps, uint256 amt) public {
        feeBps = bound(feeBps, 0, 1_000);
        amt = bound(amt, 100e6, 10_000e6);
        _yieldOn();
        fyv.setEntryFeeBps(feeBps);
        vm.prank(c1);
        if (feeBps <= 1) {
            vault.deposit(P1, amt);
            assertGe(vault.totalAssets() + amt / 1e4 + 2, amt, "entry cost within 1bp+2");
            assertGt(vault.sharesOf(P1), 0);
        } else {
            vm.expectRevert(V.YieldEntryCost.selector);
            vault.deposit(P1, amt);
            assertEq(vault.totalShares(), 0);
            assertEq(vault.totalAssets(), 0);
        }
    }

    // ------------------------------------------------------------ sole depositor seize
    function test_Seize_SoleDepositor_OneBpExitFee_PaysNet() public {
        _soleSeize(1, DEP, 1_500e6);
    }

    function test_Seize_SoleDepositor_OnePercentExitFee_PaysNet() public {
        _soleSeize(100, DEP, 1_500e6);
    }

    function test_Seize_SoleDepositor_ZeroFee_PaysFull() public {
        _soleSeize(0, DEP, 1_500e6);
        assertEq(usdc.balanceOf(address(facility)), vault.totalAssets() + DEP, "full collateral repaid");
    }

    function test_Seize_SoleDepositor_DebtEqualsCollateral_OnePercent() public {
        _dep(c1, P1, DEP);
        _yieldOn();
        fyv.setExitFeeBps(100);
        _defaultP1(DEP);
        vm.prank(stranger);
        uint256 paid = vault.seize(P1);
        assertEq(paid, DEP - DEP / 100);
        assertEq(_debt(P1), DEP / 100, "exit cost stays as debt");
        assertEq(vault.sharesOf(P1), 0);
    }

    function test_Seize_SoleDepositor_TotalExitFee_RevertsNothingToSeize_Atomic() public {
        _dep(c1, P1, DEP);
        _yieldOn();
        fyv.setExitFeeBps(10_000);
        _defaultP1(1_500e6);
        Snap memory before_ = _snap();
        vm.prank(stranger);
        vm.expectRevert(V.NothingToSeize.selector);
        vault.seize(P1);
        _assertSame(before_, _snap());
    }

    function testFuzz_Seize_SoleDepositor_AnyExitFee_PaysNet(uint256 feeBps, uint256 amt, uint256 debt) public {
        feeBps = bound(feeBps, 0, 9_999);
        amt = bound(amt, 10e6, 2_000e6);
        debt = bound(debt, amt, 5_000e6);
        _soleSeize(feeBps, amt, debt);
    }

    // ------------------------------------------------------------ partial exits still revert
    function _twoDepositors() internal {
        _dep(c1, P1, DEP);
        _dep(c2, P2, 3_000e6);
        _yieldOn();
        fyv.setExitFeeBps(100);
    }

    function test_Seize_TwoDepositors_OnePercent_PartialRevertsYieldExitCost_Atomic() public {
        _twoDepositors();
        _defaultP1(400e6);
        Snap memory before_ = _snap();
        vm.prank(stranger);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.seize(P1);
        _assertSame(before_, _snap());
        assertEq(_debt(P1), 400e6);
    }

    function test_Withdraw_TwoDepositors_OnePercent_PartialRevertsYieldExitCost_Atomic() public {
        _twoDepositors();
        _request(c1, P1, 500e6);
        skip(DELAY);
        Snap memory before_ = _snap();
        vm.prank(c1);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.withdraw(P1, rcpt);
        _assertSame(before_, _snap());
        assertEq(before_.pendingAssets, 500e6, "request kept");
    }

    function test_Withdraw_TwoDepositors_OnePercent_FullExitOfOneProfileStillReverts() public {
        // P1 leaving fully is still a PARTIAL exit of the yield position (P2 stays), so the cost guard applies.
        _twoDepositors();
        uint256 a = vault.assetsOf(P1);
        _request(c1, P1, a);
        skip(DELAY);
        Snap memory before_ = _snap();
        vm.prank(c1);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.withdraw(P1, rcpt);
        _assertSame(before_, _snap());
    }

    // ------------------------------------------------------------ sole depositor withdraw
    function test_Withdraw_SoleDepositor_OnePercent_PaysNet() public {
        _dep(c1, P1, DEP);
        _yieldOn();
        fyv.setExitFeeBps(100);
        uint256 a = vault.assetsOf(P1);
        assertEq(a, _grossPosition(), "whole position");
        _request(c1, P1, a);
        skip(DELAY);

        uint256 net = a - a / 100;
        vm.expectEmit(true, true, false, false, address(vault));
        emit V.Withdrawn(P1, rcpt, net, 0);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);

        assertEq(out, net, "return carries paid amount");
        assertEq(usdc.balanceOf(rcpt), net, "recipient gets net");
        assertEq(vault.assetsOf(P1), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(fyv.balanceOf(address(vault)), 0);
        (uint256 pending,) = vault.withdrawalOf(P1);
        assertEq(pending, 0, "request consumed");
    }

    function test_Withdraw_SoleDepositor_OneBp_PaysNet() public {
        _dep(c1, P1, DEP);
        _yieldOn();
        fyv.setExitFeeBps(1);
        uint256 a = vault.assetsOf(P1);
        _request(c1, P1, a);
        skip(DELAY);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        assertEq(out, a - a / 1e4);
        assertEq(usdc.balanceOf(rcpt), out);
    }

    function testFuzz_Withdraw_SoleDepositor_AnyExitFee_PaysNet(uint256 feeBps, uint256 amt) public {
        feeBps = bound(feeBps, 0, 9_999);
        amt = bound(amt, 10e6, 5_000e6);
        _dep(c1, P1, amt);
        _yieldOn();
        fyv.setExitFeeBps(feeBps);
        uint256 a = vault.assetsOf(P1);
        uint256 gross = _grossPosition();
        _request(c1, P1, a);
        skip(DELAY);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        uint256 net = gross - (gross * feeBps) / 10_000;
        assertEq(out, net);
        assertEq(usdc.balanceOf(rcpt), net);
        assertEq(vault.totalAssets(), 0);
    }

    // ------------------------------------------------------------ two profiles: the other one is unaffected
    function _twoNoFee() internal {
        _dep(c1, P1, DEP);
        _dep(c2, P2, 3_000e6);
        _yieldOn();
    }

    function _fullExitA(uint256 feeBps) internal returns (uint256 out) {
        fyv.setExitFeeBps(feeBps);
        uint256 a = vault.assetsOf(P1);
        _request(c1, P1, a);
        skip(DELAY);
        vm.prank(c1);
        out = vault.withdraw(P1, rcpt);
    }

    function test_TwoProfiles_AExitsFully_ZeroFee_BUnchanged() public {
        _twoNoFee();
        uint256 bBefore = vault.assetsOf(P2);
        uint256 out = _fullExitA(0);
        assertApproxEqAbs(out, DEP, 2);
        assertApproxEqAbs(vault.assetsOf(P2), bBefore, 2, "B unchanged");
        assertEq(usdc.balanceOf(rcpt), out);
    }

    function test_TwoProfiles_AExitsFully_OneBpFee_BWithinRounding() public {
        _twoNoFee();
        uint256 bBefore = vault.assetsOf(P2);
        uint256 out = _fullExitA(1);
        assertApproxEqAbs(out, DEP, 2, "A is paid the requested amount");
        // the 1bp (+2 wei) tolerated exit cost is the most B can lose
        assertApproxEqAbs(vault.assetsOf(P2), bBefore, DEP / 1e4 + 3, "B within 1bp of A's exit");
        assertLe(vault.assetsOf(P2), bBefore);
    }

    function test_TwoProfiles_AExitsFully_OnePercentFee_RevertsAndBUnchanged() public {
        _twoNoFee();
        uint256 bBefore = vault.assetsOf(P2);
        fyv.setExitFeeBps(100);
        uint256 a = vault.assetsOf(P1);
        _request(c1, P1, a);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.YieldExitCost.selector);
        vault.withdraw(P1, rcpt);
        assertEq(vault.assetsOf(P2), bBefore, "B untouched");
    }

    function test_TwoProfiles_AExitsFreely_ThenBSoleExitsAtOnePercent_BearsOwnCost() public {
        _twoNoFee();
        _fullExitA(0);
        uint256 bAssets = vault.assetsOf(P2);
        fyv.setExitFeeBps(100);
        _request(c2, P2, bAssets);
        skip(DELAY);
        vm.prank(c2);
        uint256 out = vault.withdraw(P2, rcpt2());
        assertApproxEqAbs(out, bAssets - bAssets / 100, 3, "B pays its own cost");
        assertEq(vault.totalAssets(), 0);
    }

    function rcpt2() internal returns (address) {
        return makeAddr("recipient2");
    }

    function testFuzz_TwoProfiles_AExitsFully_BUnchangedWithinRounding(uint256 feeBps, uint256 aAmt) public {
        feeBps = bound(feeBps, 0, 1);
        aAmt = bound(aAmt, 10e6, 2_000e6);
        _dep(c1, P1, aAmt);
        _dep(c2, P2, 3_000e6);
        _yieldOn();
        uint256 bBefore = vault.assetsOf(P2);
        _fullExitA(feeBps);
        assertApproxEqAbs(vault.assetsOf(P2), bBefore, aAmt / 1e4 + 3);
    }
}
