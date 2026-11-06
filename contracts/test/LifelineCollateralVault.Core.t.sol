// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";

contract VaultCoreTest is VaultTestBase {
    // ------------------------------------------------------------ constructor
    function test_Constructor_SetsState() public view {
        assertEq(vault.usdc(), address(usdc));
        assertEq(vault.facility(), address(facility));
        assertEq(vault.owner(), vaultOwner);
        assertEq(vault.ltvBps(), LTV);
        assertEq(vault.withdrawDelay(), DELAY);
        assertEq(vault.yieldVault(), address(0));
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    function test_Constructor_EmitsEvents() public {
        vm.expectEmit(true, true, false, false);
        emit V.OwnershipTransferred(address(0), address(this));
        vm.expectEmit(false, false, false, true);
        emit V.TermsUpdated(7000, 2 days);
        new V(address(usdc), address(facility), 7000, 2 days);
    }

    function test_Constructor_RevertsZeroAddress() public {
        vm.expectRevert(V.ZeroAddress.selector);
        new V(address(0), address(facility), LTV, DELAY);
        vm.expectRevert(V.ZeroAddress.selector);
        new V(address(usdc), address(0), LTV, DELAY);
    }

    function test_Constructor_RevertsNotAContract() public {
        vm.expectRevert(V.NotAContract.selector);
        new V(stranger, address(facility), LTV, DELAY);
        vm.expectRevert(V.NotAContract.selector);
        new V(address(usdc), stranger, LTV, DELAY);
    }

    function test_Constructor_RevertsInvalidTerms() public {
        vm.expectRevert(V.InvalidLtv.selector);
        new V(address(usdc), address(facility), 0, DELAY);
        vm.expectRevert(V.InvalidLtv.selector);
        new V(address(usdc), address(facility), 10_001, DELAY);
        vm.expectRevert(V.InvalidDelay.selector);
        new V(address(usdc), address(facility), LTV, 30 days + 1);
    }

    // ------------------------------------------------------------ owner: ownership
    function test_TransferOwnership_Happy() public {
        vm.expectEmit(true, true, false, false, address(vault));
        emit V.OwnershipTransferred(vaultOwner, stranger);
        vm.prank(vaultOwner);
        vault.transferOwnership(stranger);
        assertEq(vault.owner(), stranger);

        vm.prank(vaultOwner);
        vm.expectRevert(V.NotOwner.selector);
        vault.setTerms(5000, 0);
        vm.prank(stranger);
        vault.setTerms(5000, 0);
    }

    function test_TransferOwnership_Reverts() public {
        vm.prank(vaultOwner);
        vm.expectRevert(V.ZeroAddress.selector);
        vault.transferOwnership(address(0));
        vm.prank(stranger);
        vm.expectRevert(V.NotOwner.selector);
        vault.transferOwnership(stranger);
    }

    // ------------------------------------------------------------ owner: terms
    function test_SetTerms_Happy() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit V.TermsUpdated(10_000, 30 days);
        vm.prank(vaultOwner);
        vault.setTerms(10_000, 30 days);
        assertEq(vault.ltvBps(), 10_000);
        assertEq(vault.withdrawDelay(), 30 days);

        vm.prank(vaultOwner);
        vault.setTerms(1, 0);
        assertEq(vault.ltvBps(), 1);
        assertEq(vault.withdrawDelay(), 0);
    }

    function test_SetTerms_Bounds() public {
        vm.startPrank(vaultOwner);
        vm.expectRevert(V.InvalidLtv.selector);
        vault.setTerms(0, DELAY);
        vm.expectRevert(V.InvalidLtv.selector);
        vault.setTerms(10_001, DELAY);
        vm.expectRevert(V.InvalidDelay.selector);
        vault.setTerms(LTV, 30 days + 1);
        vm.stopPrank();
    }

    function test_SetTerms_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(V.NotOwner.selector);
        vault.setTerms(5000, 1);
        vm.prank(c1);
        vm.expectRevert(V.NotOwner.selector);
        vault.setTerms(5000, 1);
    }

    function test_SetTerms_ExistingRequestKeepsReadyAt() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 100e6);
        (, uint256 readyAt) = vault.withdrawalOf(P1);
        vm.prank(vaultOwner);
        vault.setTerms(LTV, 10 days);
        (, uint256 after_) = vault.withdrawalOf(P1);
        assertEq(after_, readyAt);
    }

    // ------------------------------------------------------------ bindController
    function test_Bind_Happy() public {
        bytes32 p = keccak256("fresh");
        facility.createCreditProfile(p, makeAddr("freshHuman"), keccak256("freshroot"), LIMIT);
        assertEq(vault.controllerOf(p), address(0));
        vm.expectEmit(true, true, false, false, address(vault));
        emit V.ControllerBound(p, stranger);
        vm.prank(vaultOwner);
        vault.bindController(p, stranger);
        assertEq(vault.controllerOf(p), stranger);
    }

    function test_Bind_Reverts() public {
        vm.startPrank(vaultOwner);
        vm.expectRevert(V.ControllerAlreadyBound.selector);
        vault.bindController(P1, stranger);
        vm.expectRevert(V.ProfileNotFound.selector);
        vault.bindController(PX, stranger);
        vm.expectRevert(V.ZeroAddress.selector);
        vault.bindController(PX, address(0));
        vm.stopPrank();
    }

    function test_Bind_AccessControl() public {
        bytes32 p = keccak256("fresh2");
        facility.createCreditProfile(p, makeAddr("freshHuman2"), keccak256("freshroot2"), LIMIT);
        vm.prank(stranger);
        vm.expectRevert(V.NotOwner.selector);
        vault.bindController(p, stranger);
        // the existing controller cannot rebind (not owner) ...
        vm.prank(c1);
        vm.expectRevert(V.NotOwner.selector);
        vault.bindController(P1, c1);
        vm.prank(c1);
        vm.expectRevert(V.NotOwner.selector);
        vault.bindController(P1, stranger);
        // ... and not even the owner can rebind
        vm.prank(vaultOwner);
        vm.expectRevert(V.ControllerAlreadyBound.selector);
        vault.bindController(P1, stranger);
        assertEq(vault.controllerOf(P1), c1);
    }

    // ------------------------------------------------------------ deposit
    function test_Deposit_Happy() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Deposited(P1, c1, 1_000e6, 1_000e6 * 1e6);
        uint256 shares = _dep(c1, P1, 1_000e6);
        assertEq(shares, 1_000e12);
        assertEq(vault.sharesOf(P1), shares);
        assertEq(vault.totalShares(), shares);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.assetsOf(P1), 1_000e6);
        assertEq(usdc.balanceOf(address(vault)), 1_000e6);
        assertEq(usdc.balanceOf(c1), FUND - 1_000e6);
    }

    function test_Deposit_SecondDepositorSameRate() public {
        _dep(c1, P1, 1_000e6);
        uint256 s2 = _dep(c2, P2, 250e6);
        assertEq(s2, 250e12);
        assertEq(vault.assetsOf(P1), 1_000e6);
        assertEq(vault.assetsOf(P2), 250e6);
        assertEq(vault.totalAssets(), 1_250e6);
    }

    function test_Deposit_Reverts() public {
        vm.prank(c1);
        vm.expectRevert(V.ZeroAmount.selector);
        vault.deposit(P1, 0);

        // no allowance -> token call failure
        address c4 = makeAddr("c4");
        bytes32 p = keccak256("p4");
        facility.createCreditProfile(p, makeAddr("h4"), keccak256("r4"), LIMIT);
        vm.prank(vaultOwner);
        vault.bindController(p, c4);
        usdc.mint(c4, 10e6);
        vm.prank(c4);
        vm.expectRevert(V.TokenCallFailed.selector);
        vault.deposit(p, 10e6);
    }

    function test_Deposit_RevertsZeroShares() public {
        _dep(c1, P1, 1_000e6);
        usdc.mint(address(vault), 1e18); // direct donation pushes share price above 1 wei
        vm.prank(c2);
        vm.expectRevert(V.ZeroShares.selector);
        vault.deposit(P2, 1);
    }

    function test_Deposit_RevertsOnFeeOnTransfer() public {
        usdc.setTransferFeeBps(100);
        vm.prank(c1);
        vm.expectRevert(V.TransferAmountMismatch.selector);
        vault.deposit(P1, 100e6);
    }

    function test_Deposit_BlocklistedControllerReverts() public {
        usdc.setBlocked(c1, true);
        vm.prank(c1);
        vm.expectRevert(V.TokenCallFailed.selector);
        vault.deposit(P1, 1e6);
    }

    function test_Deposit_AccessControl() public {
        vm.prank(stranger);
        vm.expectRevert(V.NotController.selector);
        vault.deposit(P1, 1e6);
        // another profile's controller cannot deposit into P1
        vm.prank(c2);
        vm.expectRevert(V.NotController.selector);
        vault.deposit(P1, 1e6);
        // nonexistent / unbound profile
        vm.prank(c1);
        vm.expectRevert(V.NotController.selector);
        vault.deposit(PX, 1e6);
    }

    // ------------------------------------------------------------ request / cancel
    function test_Request_Happy() public {
        _dep(c1, P1, 1_000e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit V.WithdrawalRequested(P1, 400e6, block.timestamp + DELAY);
        _request(c1, P1, 400e6);
        (uint256 a, uint256 r) = vault.withdrawalOf(P1);
        assertEq(a, 400e6);
        assertEq(r, block.timestamp + DELAY);
    }

    function test_Request_ReplacesAndRestartsTimer() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 400e6);
        skip(DELAY / 2);
        _request(c1, P1, 100e6);
        (uint256 a, uint256 r) = vault.withdrawalOf(P1);
        assertEq(a, 100e6);
        assertEq(r, block.timestamp + DELAY);
    }

    function test_Request_Reverts() public {
        _dep(c1, P1, 1_000e6);
        vm.startPrank(c1);
        vm.expectRevert(V.ZeroAmount.selector);
        vault.requestWithdrawal(P1, 0);
        vm.expectRevert(V.ExceedsBalance.selector);
        vault.requestWithdrawal(P1, 1_000e6 + 1);
        vm.stopPrank();
        // exactly the balance is fine
        _request(c1, P1, 1_000e6);
    }

    function test_Request_AccessControl() public {
        _dep(c1, P1, 1_000e6);
        vm.prank(stranger);
        vm.expectRevert(V.NotController.selector);
        vault.requestWithdrawal(P1, 1);
        vm.prank(c2);
        vm.expectRevert(V.NotController.selector);
        vault.requestWithdrawal(P1, 1);
    }

    function test_Cancel_Happy() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 400e6);
        vm.expectEmit(true, false, false, false, address(vault));
        emit V.WithdrawalCancelled(P1);
        vm.prank(c1);
        vault.cancelWithdrawal(P1);
        (uint256 a, uint256 r) = vault.withdrawalOf(P1);
        assertEq(a, 0);
        assertEq(r, 0);
    }

    function test_Cancel_Reverts() public {
        vm.prank(c1);
        vm.expectRevert(V.NoPendingWithdrawal.selector);
        vault.cancelWithdrawal(P1);
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 1e6);
        vm.prank(stranger);
        vm.expectRevert(V.NotController.selector);
        vault.cancelWithdrawal(P1);
        vm.prank(c2);
        vm.expectRevert(V.NotController.selector);
        vault.cancelWithdrawal(P1);
    }

    function test_Cancel_ThenWithdrawReverts() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 1e6);
        vm.prank(c1);
        vault.cancelWithdrawal(P1);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.NoPendingWithdrawal.selector);
        vault.withdraw(P1, rcpt);
    }

    // ------------------------------------------------------------ withdraw
    function test_Withdraw_HappyPartialAndFull() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 400e6);
        skip(DELAY);
        vm.expectEmit(true, true, false, true, address(vault));
        emit V.Withdrawn(P1, rcpt, 400e6, 400e12);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        assertEq(out, 400e6);
        assertEq(usdc.balanceOf(rcpt), 400e6);
        assertEq(vault.assetsOf(P1), 600e6);
        assertEq(vault.sharesOf(P1), 600e12);
        assertEq(vault.totalShares(), 600e12);
        (uint256 a,) = vault.withdrawalOf(P1);
        assertEq(a, 0);

        assertEq(_exit(c1, P1, rcpt, 600e6), 600e6);
        assertEq(usdc.balanceOf(rcpt), 1_000e6);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.sharesOf(P1), 0);
    }

    function test_Withdraw_BeforeDelayReverts_ExactReadyAtWorks() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 100e6);
        (, uint256 readyAt) = vault.withdrawalOf(P1);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalNotReady.selector);
        vault.withdraw(P1, rcpt);
        vm.warp(readyAt - 1);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalNotReady.selector);
        vault.withdraw(P1, rcpt);
        vm.warp(readyAt);
        vm.prank(c1);
        assertEq(vault.withdraw(P1, rcpt), 100e6);
    }

    function test_Withdraw_Reverts() public {
        _dep(c1, P1, 1_000e6);
        vm.startPrank(c1);
        vm.expectRevert(V.NoPendingWithdrawal.selector);
        vault.withdraw(P1, rcpt);
        vault.requestWithdrawal(P1, 10e6);
        skip(DELAY);
        vm.expectRevert(V.ZeroAddress.selector);
        vault.withdraw(P1, address(0));
        vm.stopPrank();
    }

    function test_Withdraw_AccessControl() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 10e6);
        skip(DELAY);
        vm.prank(stranger);
        vm.expectRevert(V.NotController.selector);
        vault.withdraw(P1, stranger);
        vm.prank(c2);
        vm.expectRevert(V.NotController.selector);
        vault.withdraw(P1, c2);
    }

    function test_Withdraw_CappedAtCurrentBalanceAfterLoss() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 800e6);
        usdc.burn(address(vault), 500e6); // vault lost half of its funds
        skip(DELAY);
        vm.prank(c1);
        uint256 out = vault.withdraw(P1, rcpt);
        assertEq(out, 500e6); // everything that is left, not the 800e6 requested
        assertEq(vault.assetsOf(P1), 0);
    }

    function test_Withdraw_ZeroPayoutReverts() public {
        _dep(c1, P1, 1_000e6);
        _request(c1, P1, 10e6);
        usdc.burn(address(vault), 1_000e6); // everything gone
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.ZeroAmount.selector);
        vault.withdraw(P1, rcpt);
    }

    function test_Withdraw_BlocklistedRecipientBlocksOnlyItself() public {
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 1_000e6);
        usdc.setBlocked(rcpt, true);
        _request(c1, P1, 100e6);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.TokenCallFailed.selector);
        vault.withdraw(P1, rcpt);
        // state untouched by the failed withdrawal
        assertEq(vault.assetsOf(P1), 1_000e6);
        (uint256 a,) = vault.withdrawalOf(P1);
        assertEq(a, 100e6);
        // the same controller can pick another recipient
        vm.prank(c1);
        assertEq(vault.withdraw(P1, stranger), 100e6);
        // other profile is unaffected
        assertEq(_exit(c2, P2, makeAddr("other"), 1_000e6), 1_000e6);
    }

    // ------------------------------------------------------------ views
    function test_CreditableOf() public {
        assertEq(vault.creditableOf(P1), 0);
        _dep(c1, P1, 1_000e6);
        assertEq(vault.creditableOf(P1), 500e6);
        _request(c1, P1, 400e6);
        assertEq(vault.creditableOf(P1), 300e6); // (1000-400)*50%
        _request(c1, P1, 1_000e6);
        assertEq(vault.creditableOf(P1), 0);
    }

    // ------------------------------------------------------------ native value
    function test_RejectsNativeValue() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        (ok,) = address(vault).call{value: 1 ether}(abi.encodeCall(vault.seize, (P1)));
        assertFalse(ok);
        vm.deal(c1, 1 ether);
        vm.prank(c1);
        (ok,) = address(vault).call{value: 1}(abi.encodeCall(vault.deposit, (P1, 1e6)));
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    function test_ForcedNativeBalanceDoesNotAffectAccounting() public {
        _dep(c1, P1, 1_000e6);
        vm.deal(address(vault), 5 ether);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.assetsOf(P1), 1_000e6);
    }
}
