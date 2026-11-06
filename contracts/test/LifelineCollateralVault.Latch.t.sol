// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {LifelineCreditFacility} from "../src/LifelineCreditFacility.sol";

/// @notice Default latch: protects `seize` from a borrower who overwrites Defaulted with Suspended
/// through the real facility's `suspendOwnProfile`.
contract VaultLatchTest is VaultTestBase {
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant SUSPENDED = 2;
    uint8 internal constant DEFAULTED = 3;

    uint256 internal constant DEP = 1_000e6;
    uint256 internal constant DEBT = 400e6;

    function setUp() public override {
        super.setUp();
        _dep(c1, P1, DEP);
    }

    // ---------------------------------------------------------------- helpers
    function _human1() internal returns (address) {
        return makeAddr("human1"); // humanOwner of P1 (see Base._mkProfile salt 1)
    }

    function _markDefault(bytes32 p) internal {
        facility.markDefault(p);
        assertEq(_status(p), DEFAULTED);
    }

    function _humanSuspends(bytes32 p, address human) internal {
        vm.prank(human);
        facility.suspendOwnProfile(p);
        assertEq(_status(p), SUSPENDED);
    }

    function _latch(address who, bytes32 p) internal {
        vm.prank(who);
        vault.latchDefault(p);
    }

    function _seize(bytes32 p) internal returns (uint256) {
        vm.prank(stranger);
        return vault.seize(p);
    }

    // ================================================================ (1) default evasion
    function test_Attack_SuspendOwnProfileEvadesSeize_WithoutLatch() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        // borrower (human owner) overwrites Defaulted with Suspended
        _humanSuspends(P1, _human1());

        // documents the attack: with no latch, the default is gone from the vault's view
        assertFalse(vault.defaultLatched(P1));
        vm.expectRevert(V.NotDefaulted.selector);
        _seize(P1);
        assertEq(_debt(P1), DEBT);
        assertEq(vault.assetsOf(P1), DEP);
    }

    function test_Latch_ByAnyoneWhileDefaulted_SeizeSucceedsAfterSuspension() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1); // anyone, while facility status == 3
        _humanSuspends(P1, _human1());

        uint256 facBefore = usdc.balanceOf(address(facility));
        uint256 got = _seize(P1);
        assertEq(got, DEBT);
        assertEq(_debt(P1), 0);
        assertEq(usdc.balanceOf(address(facility)) - facBefore, DEBT);
        assertEq(vault.assetsOf(P1), DEP - DEBT);
        assertEq(usdc.balanceOf(stranger), 0, "caller gets nothing");
        assertFalse(vault.defaultLatched(P1), "latch deleted on full repay");
    }

    function test_Latch_ByOwner_BeforeMarkDefault_SurvivesSuspension() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1); // race-free path: latch right before markDefault
        _markDefault(P1);
        _humanSuspends(P1, _human1());

        assertEq(_seize(P1), DEBT);
        assertEq(_debt(P1), 0);
    }

    function test_Latch_ByOwner_ActiveProfile_SeizeSucceeds() public {
        _borrow(P1, DEBT);
        assertEq(_status(P1), ACTIVE);
        _latch(vaultOwner, P1);
        assertEq(_seize(P1), DEBT);
        assertEq(usdc.balanceOf(address(facility)), DEBT);
    }

    function test_Latch_Seize_RepaysMinDebtCollateral_CollateralSmaller() public {
        // P2 holds only 300 of collateral against 400 of debt
        _dep(c2, P2, 300e6);
        _borrow(P2, DEBT);
        _markDefault(P2);
        _latch(stranger, P2);
        _humanSuspends(P2, makeAddr("human2"));

        assertEq(_seize(P2), 300e6);
        assertEq(usdc.balanceOf(address(facility)), 300e6);
        assertEq(_debt(P2), 100e6);
        assertEq(vault.assetsOf(P2), 0);
        // other profile untouched
        assertEq(vault.assetsOf(P1), DEP);
    }

    function test_Latch_Seize_EmitsSeizedWithRemainingDebt() public {
        _dep(c2, P2, 300e6);
        _borrow(P2, DEBT);
        _latch(vaultOwner, P2);
        uint256 sh = vault.sharesOf(P2);
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Seized(P2, stranger, 300e6, sh, 100e6);
        _seize(P2);
    }

    // ================================================================ (2) latchDefault rules
    function test_LatchDefault_RevertsNothingToLatch_ZeroDebt() public {
        vm.prank(vaultOwner);
        vm.expectRevert(V.NothingToLatch.selector);
        vault.latchDefault(P1);

        vm.prank(stranger);
        vm.expectRevert(V.NothingToLatch.selector);
        vault.latchDefault(P1);

        // unknown profile has zero debt too
        vm.prank(vaultOwner);
        vm.expectRevert(V.NothingToLatch.selector);
        vault.latchDefault(PX);
        assertFalse(vault.defaultLatched(P1));
    }

    function test_LatchDefault_NothingToLatch_EvenWhenStatusDefaultedWithZeroDebt() public {
        facility.setProfileStatus(P1, LifelineCreditFacility.ProfileStatus.Defaulted);
        assertEq(_status(P1), DEFAULTED);
        vm.prank(stranger);
        vm.expectRevert(V.NothingToLatch.selector);
        vault.latchDefault(P1);
    }

    function test_LatchDefault_NonOwner_RevertsNotDefaulted_WhenActive() public {
        _borrow(P1, DEBT);
        vm.prank(stranger);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.latchDefault(P1);
        // the controller is not special either
        vm.prank(c1);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.latchDefault(P1);
        assertFalse(vault.defaultLatched(P1));
    }

    function test_LatchDefault_NonOwner_RevertsNotDefaulted_WhenSuspended() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _humanSuspends(P1, _human1());
        vm.prank(stranger);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.latchDefault(P1);
        assertFalse(vault.defaultLatched(P1));
    }

    function test_LatchDefault_NonOwner_SucceedsWhenDefaulted() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        assertTrue(vault.defaultLatched(P1));
    }

    function test_LatchDefault_OwnerCanLatchActiveProfileWithDebt() public {
        _borrow(P1, DEBT);
        assertFalse(vault.defaultLatched(P1));
        _latch(vaultOwner, P1);
        assertTrue(vault.defaultLatched(P1));
        assertFalse(vault.defaultLatched(P2), "other profiles unaffected");
    }

    function test_LatchDefault_EmitsDefaultLatched() public {
        _borrow(P1, DEBT);
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.DefaultLatched(P1, vaultOwner);
        _latch(vaultOwner, P1);

        _markDefault(P1);
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.DefaultLatched(P1, stranger);
        _latch(stranger, P1); // idempotent re-latch is allowed
        assertTrue(vault.defaultLatched(P1));
    }

    function test_LatchDefault_DoesNotMoveFunds() public {
        _borrow(P1, DEBT);
        uint256 ta = vault.totalAssets();
        uint256 sh = vault.sharesOf(P1);
        _latch(vaultOwner, P1);
        assertEq(vault.totalAssets(), ta);
        assertEq(vault.sharesOf(P1), sh);
        assertEq(_debt(P1), DEBT);
    }

    function test_ClearDefault_OnlyOwner() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        vm.prank(stranger);
        vm.expectRevert(V.NotOwner.selector);
        vault.clearDefault(P1);
        vm.prank(c1);
        vm.expectRevert(V.NotOwner.selector);
        vault.clearDefault(P1);
        assertTrue(vault.defaultLatched(P1));
    }

    function test_ClearDefault_EmitsAndClears() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        vm.expectEmit(true, false, false, true, address(vault));
        emit V.DefaultCleared(P1);
        vm.prank(vaultOwner);
        vault.clearDefault(P1);
        assertFalse(vault.defaultLatched(P1));
    }

    function test_ClearDefault_SeizeRevertsAgain_WhenStatusNotDefaulted() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        assertEq(_status(P1), ACTIVE);
        vm.prank(vaultOwner);
        vault.clearDefault(P1);
        vm.expectRevert(V.NotDefaulted.selector);
        _seize(P1);
        assertEq(_debt(P1), DEBT);
    }

    function test_ClearDefault_SeizeStillWorks_WhenFacilityStatusDefaulted() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        vm.prank(vaultOwner);
        vault.clearDefault(P1);
        // facility status is still 3, so seize does not need the latch
        assertEq(_seize(P1), DEBT);
    }

    // ================================================================ (3) withdraw guard
    function _requestAll() internal {
        _request(c1, P1, DEP);
        skip(DELAY);
    }

    function test_Withdraw_RevertsProfileDefaulted_LatchedThenSuspended() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        _humanSuspends(P1, _human1());
        _requestAll();

        vm.prank(c1);
        vm.expectRevert(V.ProfileDefaulted.selector);
        vault.withdraw(P1, rcpt);
        assertEq(vault.assetsOf(P1), DEP);
        assertEq(usdc.balanceOf(rcpt), 0);
    }

    function test_Withdraw_RevertsProfileDefaulted_LatchedThenReactivated() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        facility.setProfileStatus(P1, LifelineCreditFacility.ProfileStatus.Active);
        assertEq(_status(P1), ACTIVE);
        _requestAll();

        vm.prank(c1);
        vm.expectRevert(V.ProfileDefaulted.selector);
        vault.withdraw(P1, rcpt);
        assertEq(vault.assetsOf(P1), DEP);
    }

    function test_Withdraw_RevertsProfileDefaulted_OwnerLatchedActiveProfile() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        _request(c1, P1, 100e6); // would otherwise satisfy LTV
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.ProfileDefaulted.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_RequestAndCancelStillWork_WhileLatched() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        _request(c1, P1, 100e6);
        vm.prank(c1);
        vault.cancelWithdrawal(P1);
        (uint256 a,) = vault.withdrawalOf(P1);
        assertEq(a, 0);
    }

    function test_Withdraw_Allowed_WhenLatchedButDebtZero() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        // underwriter books the repayment off-chain; debt goes to zero without seize (latch stays)
        facility.recordRepayment(P1, address(this), address(0), DEBT);
        assertEq(_debt(P1), 0);
        assertTrue(vault.defaultLatched(P1));

        _requestAll();
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        assertEq(out, DEP);
        assertEq(usdc.balanceOf(rcpt), DEP);
        assertEq(vault.assetsOf(P1), 0);
    }

    function test_Withdraw_Allowed_WhenLatchedAndDebtFullySeizedThenRemainder() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        _seize(P1);
        assertFalse(vault.defaultLatched(P1));
        _request(c1, P1, DEP - DEBT);
        skip(DELAY);
        vm.prank(c1);
        assertEq(vault.withdraw(P1, rcpt), DEP - DEBT);
    }

    /// @dev Observation (not an assertion of intent): the latch is not cleared when debt is repaid
    /// outside `seize`. If the underwriter later reinstates the profile and it borrows again, the new
    /// debt is seizable by anyone although the profile is Active - until the owner calls clearDefault.
    function test_Observation_StaleLatchAfterExternalRepay_NewDebtSeizable() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        facility.recordRepayment(P1, address(this), address(0), DEBT);
        assertEq(_debt(P1), 0);
        assertTrue(vault.defaultLatched(P1));

        _borrow(P1, 100e6); // profile is Active, borrows again
        assertEq(_status(P1), ACTIVE);
        assertEq(_seize(P1), 100e6); // seizable without any new default
        assertEq(_debt(P1), 0);
    }

    // ================================================================ (4) latch lifecycle across seizes
    function test_Seize_FullRepay_DeletesLatch() public {
        _borrow(P1, DEBT);
        _latch(vaultOwner, P1);
        assertTrue(vault.defaultLatched(P1));
        _seize(P1);
        assertEq(_debt(P1), 0);
        assertFalse(vault.defaultLatched(P1));
        // Active, no latch, no debt => seize is gated again
        vm.expectRevert(V.NotDefaulted.selector);
        _seize(P1);
    }

    function test_Seize_FullRepay_StatusDefaulted_SecondSeizeNothingToSeize() public {
        _borrow(P1, DEBT);
        _markDefault(P1);
        _latch(stranger, P1);
        _seize(P1);
        assertFalse(vault.defaultLatched(P1));
        vm.expectRevert(V.NothingToSeize.selector);
        _seize(P1);
    }

    function test_Seize_Partial_KeepsLatch_AndLaterDepositCanBeSeized() public {
        // P2: 300 collateral vs 400 debt
        _dep(c2, P2, 300e6);
        _borrow(P2, DEBT);
        _markDefault(P2);
        _latch(stranger, P2);
        _humanSuspends(P2, makeAddr("human2"));

        assertEq(_seize(P2), 300e6);
        assertEq(_debt(P2), 100e6);
        assertTrue(vault.defaultLatched(P2), "partial seize keeps the latch");

        // nothing left to take for now
        vm.expectRevert(V.NothingToSeize.selector);
        _seize(P2);

        // controller tops up again; borrower is still Suspended, but the latch makes it seizable
        _dep(c2, P2, 250e6);
        uint256 facBefore = usdc.balanceOf(address(facility));
        assertEq(_seize(P2), 100e6);
        assertEq(usdc.balanceOf(address(facility)) - facBefore, 100e6);
        assertEq(_debt(P2), 0);
        assertFalse(vault.defaultLatched(P2), "latch deleted once debt reaches zero");
        assertEq(vault.assetsOf(P2), 150e6, "surplus stays with the profile");
    }

    function test_Seize_DeletesPendingWithdrawalOnLatchedProfile() public {
        _borrow(P1, DEBT);
        _request(c1, P1, 100e6);
        _latch(vaultOwner, P1);
        _seize(P1);
        (uint256 a,) = vault.withdrawalOf(P1);
        assertEq(a, 0);
    }

    function test_Seize_LatchIsPerProfile() public {
        _dep(c2, P2, DEP);
        _borrow(P1, DEBT);
        _borrow(P2, DEBT);
        _latch(vaultOwner, P1);
        _seize(P1);
        vm.expectRevert(V.NotDefaulted.selector);
        _seize(P2);
        assertEq(_debt(P2), DEBT);
    }
}
