// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {LifelineCreditFacility as F} from "../src/LifelineCreditFacility.sol";

/// LTV gating of withdrawals and permissionless seizure, against the real facility.
contract VaultDebtTest is VaultTestBase {
    function setUp() public override {
        super.setUp();
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 1_000e6);
    }

    // ------------------------------------------------------------ LTV boundary
    function test_Withdraw_ExactLtvBoundaryAllowed() public {
        _borrow(P1, 200e6); // needs remaining*50% >= 200 -> remaining >= 400
        assertEq(_exit(c1, P1, rcpt, 600e6), 600e6); // remaining exactly 400e6: 400e6*5000/10000 == debt
        assertEq(vault.assetsOf(P1), 400e6);
        assertEq((vault.assetsOf(P1) * vault.ltvBps()) / 10_000, _debt(P1));
    }

    function test_Withdraw_OneWeiBelowBoundaryReverts() public {
        _borrow(P1, 200e6);
        _request(c1, P1, 600e6 + 1); // remaining 400e6 - 1 -> floor(199999999.5) < debt
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);
        assertEq(vault.assetsOf(P1), 1_000e6);
    }

    function test_Withdraw_FullExitWithDebtReverts() public {
        _borrow(P1, 1);
        _request(c1, P1, 1_000e6);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_FullLtv10000Boundary() public {
        vm.prank(vaultOwner);
        vault.setTerms(10_000, DELAY);
        _borrow(P1, 300e6);
        assertEq(_exit(c1, P1, rcpt, 700e6), 700e6);
        _request(c1, P1, 1);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_LtvIsEvaluatedAtWithdrawTime() public {
        _request(c1, P1, 900e6);
        _borrow(P1, 100e6); // debt appears after the request
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);
        // owner loosening LTV makes it pass
        vm.prank(vaultOwner);
        vault.setTerms(10_000, DELAY);
        vm.prank(c1);
        assertEq(vault.withdraw(P1, rcpt), 900e6);
    }

    function test_Withdraw_DebtOnOtherProfileDoesNotBlock() public {
        _borrow(P2, 400e6);
        assertEq(_exit(c1, P1, rcpt, 1_000e6), 1_000e6);
    }

    function test_Withdraw_AfterRepayAllowed() public {
        _borrow(P1, 200e6);
        facility.recordRepayment(P1, address(this), address(0), 200e6);
        assertEq(_exit(c1, P1, rcpt, 1_000e6), 1_000e6);
    }

    // ------------------------------------------------------------ default blocks withdrawal
    function test_Withdraw_RevertsWhenDefaultedWithDebt() public {
        _borrow(P1, 10e6);
        _request(c1, P1, 1e6); // tiny, LTV would be fine
        facility.markDefault(P1);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.ProfileDefaulted.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_DefaultedWithoutDebtIsAllowed() public {
        facility.setProfileStatus(P1, F.ProfileStatus.Defaulted);
        assertEq(_status(P1), 3);
        assertEq(_exit(c1, P1, rcpt, 1_000e6), 1_000e6);
    }

    // ------------------------------------------------------------ seize: gating
    function test_Seize_RevertsWhenNotDefaulted() public {
        _borrow(P1, 100e6);
        vm.prank(stranger);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.seize(P1);

        facility.setProfileStatus(P1, F.ProfileStatus.Suspended);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.seize(P1);

        facility.setProfileStatus(P1, F.ProfileStatus.Inactive);
        vm.expectRevert(V.NotDefaulted.selector);
        vault.seize(P1);

        vm.expectRevert(V.NotDefaulted.selector);
        vault.seize(PX); // unknown profile
    }

    function test_Seize_RevertsNothingToSeize_NoDebt() public {
        facility.setProfileStatus(P1, F.ProfileStatus.Defaulted);
        vm.expectRevert(V.NothingToSeize.selector);
        vault.seize(P1);
    }

    function test_Seize_RevertsNothingToSeize_NoCollateral() public {
        _borrow(P3, 50e6); // P3 never deposited
        facility.markDefault(P3);
        vm.expectRevert(V.NothingToSeize.selector);
        vault.seize(P3);
    }

    // ------------------------------------------------------------ seize: collateral > debt
    function test_Seize_CollateralExceedsDebt() public {
        _borrow(P1, 300e6);
        _request(c1, P1, 500e6);
        facility.markDefault(P1);

        uint256 facBal = usdc.balanceOf(address(facility));
        uint256 debtBefore = _debt(P1);
        uint256 callerBal = usdc.balanceOf(stranger);

        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Seized(P1, stranger, 300e6, 300e12, 0);
        vm.prank(stranger);
        uint256 seized = vault.seize(P1);

        assertEq(seized, 300e6);
        assertEq(_debt(P1), 0);
        assertEq(debtBefore - _debt(P1), seized, "facility debt fell by seized");
        assertEq(usdc.balanceOf(address(facility)) - facBal, seized, "facility received seized");
        assertEq(usdc.balanceOf(stranger), callerBal, "caller paid nothing");
        assertEq(vault.assetsOf(P1), 700e6, "remainder stays");
        assertEq(vault.totalAssets(), 1_700e6);
        assertEq(usdc.balanceOf(address(vault)), 1_700e6);
        assertEq(usdc.allowance(address(vault), address(facility)), 0);
        (uint256 a, uint256 r) = vault.withdrawalOf(P1);
        assertEq(a, 0, "pending withdrawal cleared");
        assertEq(r, 0);
        assertEq(_status(P1), 3);
    }

    function test_Seize_RemainderWithdrawableAfterDebtCleared() public {
        _borrow(P1, 300e6);
        facility.markDefault(P1);
        vault.seize(P1);
        assertEq(_exit(c1, P1, rcpt, 700e6), 700e6);
        assertEq(vault.assetsOf(P1), 0);
    }

    // ------------------------------------------------------------ seize: collateral < debt
    function test_Seize_CollateralBelowDebt() public {
        _borrow(P3, 400e6);
        _dep(c3, P3, 100e6);
        _request(c3, P3, 50e6);
        facility.markDefault(P3);

        uint256 facBal = usdc.balanceOf(address(facility));
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Seized(P3, c1, 100e6, 100e12, 300e6);
        vm.prank(c1);
        uint256 seized = vault.seize(P3);

        assertEq(seized, 100e6);
        assertEq(vault.assetsOf(P3), 0);
        assertEq(vault.sharesOf(P3), 0);
        assertEq(_debt(P3), 300e6, "remaining debt stays");
        assertEq(usdc.balanceOf(address(facility)) - facBal, 100e6);
        (uint256 a,) = vault.withdrawalOf(P3);
        assertEq(a, 0);
        // second call has nothing left
        vm.expectRevert(V.NothingToSeize.selector);
        vault.seize(P3);
    }

    function test_Seize_OnlyAffectsThatProfile() public {
        _dep(c3, P3, 777e6);
        _borrow(P1, 300e6);
        _borrow(P2, 250e6);
        _request(c2, P2, 100e6);
        facility.markDefault(P1);

        uint256 a2 = vault.assetsOf(P2);
        uint256 a3 = vault.assetsOf(P3);
        uint256 s2 = vault.sharesOf(P2);
        uint256 s3 = vault.sharesOf(P3);
        vault.seize(P1);

        assertEq(vault.assetsOf(P2), a2);
        assertEq(vault.assetsOf(P3), a3);
        assertEq(vault.sharesOf(P2), s2);
        assertEq(vault.sharesOf(P3), s3);
        assertEq(_debt(P2), 250e6);
        assertEq(_debt(P3), 0);
        (uint256 w2,) = vault.withdrawalOf(P2);
        assertEq(w2, 100e6);
        assertEq(vault.controllerOf(P1), c1);
        // P2 is not Defaulted, so it cannot be seized
        vm.expectRevert(V.NotDefaulted.selector);
        vault.seize(P2);
    }

    function test_Seize_WorksFromAnyCaller() public {
        _borrow(P1, 100e6);
        facility.markDefault(P1);
        vm.prank(rcpt);
        assertEq(vault.seize(P1), 100e6);
        assertEq(usdc.balanceOf(rcpt), 0);
    }

    function test_Seize_DepositAfterDefaultCanStillBeSeized() public {
        _borrow(P3, 400e6);
        facility.markDefault(P3);
        _dep(c3, P3, 150e6);
        assertEq(vault.seize(P3), 150e6);
        assertEq(_debt(P3), 250e6);
    }

    function test_Seize_BlocksSubsequentWithdraw() public {
        _borrow(P1, 100e6);
        _request(c1, P1, 500e6);
        facility.markDefault(P1);
        vault.seize(P1);
        // request was cleared by seize
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.NoPendingWithdrawal.selector);
        vault.withdraw(P1, rcpt);
    }

    // ------------------------------------------------------------ creditableOf / views after seize
    function test_CreditableOf_AfterSeize() public {
        _borrow(P1, 300e6);
        facility.markDefault(P1);
        vault.seize(P1);
        assertEq(vault.creditableOf(P1), 350e6); // 700e6 * 50%
    }
}
