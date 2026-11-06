// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Actor} from "./mocks/Actor.sol";

contract VaultAttacksTest is VaultTestBase {
    Actor internal actor;
    bytes32 internal constant P4 = keccak256("profile-4-actor");

    address internal attacker = makeAddr("attacker");

    // ------------------------------------------------------------ stranger-binding attack
    function test_StrangerCannotClaimUnboundProfile() public {
        bytes32 victimProfile = keccak256("victim-profile");
        facility.createCreditProfile(victimProfile, makeAddr("victimHuman"), keccak256("victimRoot"), LIMIT);
        assertEq(vault.controllerOf(victimProfile), address(0));

        usdc.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        // first depositor can neither deposit ...
        vm.expectRevert(V.NotController.selector);
        vault.deposit(victimProfile, 1);
        // ... nor bind himself
        vm.expectRevert(V.NotOwner.selector);
        vault.bindController(victimProfile, attacker);
        vm.stopPrank();
        assertEq(vault.controllerOf(victimProfile), address(0));
        assertEq(vault.sharesOf(victimProfile), 0);
        assertEq(usdc.balanceOf(attacker), 1_000e6);

        // the owner binds the rightful controller; the attacker is still locked out
        address victim = makeAddr("victim");
        vm.prank(vaultOwner);
        vault.bindController(victimProfile, victim);
        vm.prank(attacker);
        vm.expectRevert(V.NotController.selector);
        vault.deposit(victimProfile, 1);
        vm.expectRevert(V.ControllerAlreadyBound.selector);
        vm.prank(vaultOwner);
        vault.bindController(victimProfile, attacker);
        assertEq(vault.controllerOf(victimProfile), victim);
    }

    function test_AttackerControllerOfOwnProfileCannotTouchOthers() public {
        _dep(c2, P2, 1_000e6);
        vm.startPrank(c1);
        vm.expectRevert(V.NotController.selector);
        vault.requestWithdrawal(P2, 1);
        vm.expectRevert(V.NotController.selector);
        vault.withdraw(P2, c1);
        vm.expectRevert(V.NotController.selector);
        vault.cancelWithdrawal(P2);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ donation / inflation attack
    function test_Vault_FirstDepositorDonationAttack() public {
        uint256 donation = 1_000_000e6;
        uint256 victimDeposit = 100_000e6;

        // attacker (c1/P1): 1 wei in, then donates directly to the vault
        uint256 atkShares = _dep(c1, P1, 1);
        assertGt(atkShares, 0);
        uint256 atkBalBefore = usdc.balanceOf(c1);
        vm.prank(c1);
        usdc.transfer(address(vault), donation);

        // victim (c2/P2) deposits
        uint256 vicShares = _dep(c2, P2, victimDeposit);
        assertGt(vicShares, 0);

        uint256 victimOut = _exit(c2, P2, rcpt, vault.assetsOf(P2));
        // lost at most ~one share price (<= 0.5 USDC here) to rounding
        assertApproxEqAbs(victimOut, victimDeposit, 1e6, "victim made whole");
        assertLe(victimOut, victimDeposit, "victim cannot gain");

        uint256 attackerOut = _exit(c1, P1, attacker, vault.assetsOf(P1));
        uint256 attackerIn = 1 + donation;
        assertLt(attackerOut, attackerIn, "attacker lost");
        assertGt(attackerIn - attackerOut, donation / 4, "attacker lost a large part of donation");
        assertEq(usdc.balanceOf(c1), atkBalBefore - donation, "sanity: attacker paid donation");
    }

    function test_Vault_DonationBeforeVictimTinyDepositIsNotSilentlyStolen() public {
        _dep(c1, P1, 1);
        usdc.mint(address(vault), 1e18);
        // victim deposit that would mint 0 shares is rejected rather than swallowed
        vm.prank(c2);
        vm.expectRevert(V.ZeroShares.selector);
        vault.deposit(P2, 1_000);
        assertEq(usdc.balanceOf(c2), FUND);
    }

    function test_Vault_DonationDoesNotLetAnyoneWithdrawMoreThanShare() public {
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 1_000e6);
        usdc.mint(address(vault), 500e6);

        uint256 a1 = vault.assetsOf(P1);
        uint256 a2 = vault.assetsOf(P2);
        assertApproxEqAbs(a1, 1_250e6, 2);
        assertApproxEqAbs(a2, 1_250e6, 2);
        assertLe(a1 + a2, vault.totalAssets());

        vm.prank(c1);
        vm.expectRevert(V.ExceedsBalance.selector);
        vault.requestWithdrawal(P1, a1 + 1);

        uint256 out1 = _exit(c1, P1, rcpt, a1);
        // payout never exceeds what is attributable to the profile, other's share intact
        assertEq(out1, a1);
        assertGe(vault.assetsOf(P2), a2);
        uint256 out2 = _exit(c2, P2, rcpt, vault.assetsOf(P2));
        assertLe(out1 + out2, 2_500e6);
        // nothing but dust (the virtual-share remainder) is left
        assertLe(usdc.balanceOf(address(vault)), 3);
        // the donor (stranger) never gets anything back
        vm.prank(stranger);
        vm.expectRevert(V.NotController.selector);
        vault.withdraw(P1, stranger);
    }

    // ------------------------------------------------------------ reentrancy
    function _setupActor() internal {
        actor = new Actor();
        facility.createCreditProfile(P4, makeAddr("human4"), keccak256("root4"), LIMIT);
        vm.prank(vaultOwner);
        vault.bindController(P4, address(actor));
        usdc.mint(address(actor), 10_000e6);
        actor.approveToken(address(usdc), address(vault), type(uint256).max);
    }

    function _inner(uint256 i) internal view returns (bytes memory) {
        if (i == 0) return abi.encodeCall(vault.deposit, (P4, 1e6));
        if (i == 1) return abi.encodeCall(vault.requestWithdrawal, (P4, 1));
        if (i == 2) return abi.encodeCall(vault.cancelWithdrawal, (P4));
        if (i == 3) return abi.encodeCall(vault.withdraw, (P4, rcpt));
        if (i == 4) return abi.encodeCall(vault.seize, (P4));
        return abi.encodeCall(vault.seize, (P1)); // other profile: still guarded
    }

    function _arm(uint256 i, bool after_) internal {
        usdc.setHook(address(actor), abi.encodeCall(Actor.react, (address(vault), _inner(i))), after_);
    }

    function _assertGuarded() internal view {
        assertEq(usdc.hookFired(), 1, "hook fired once");
        assertTrue(usdc.hookOk(), "hook callback executed");
        assertEq(actor.reactCount(), 1);
        assertFalse(actor.lastOk(), "reentrant call must fail");
        assertEq(actor.lastSelector(), V.Reentrancy.selector, "failed due to the guard");
    }

    function test_Reentrancy_DuringDeposit() public {
        _setupActor();
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = 0; j < 2; j++) {
                uint256 snap = vm.snapshotState();
                _arm(i, j == 1);
                actor.exec(address(vault), abi.encodeCall(vault.deposit, (P4, 100e6)));
                _assertGuarded();
                assertEq(vault.assetsOf(P4), 100e6, "accounting intact");
                assertEq(vault.totalAssets(), 100e6);
                assertEq(usdc.balanceOf(address(vault)), 100e6);
                vm.revertToState(snap);
            }
        }
    }

    function test_Reentrancy_DuringWithdraw() public {
        _setupActor();
        actor.exec(address(vault), abi.encodeCall(vault.deposit, (P4, 1_000e6)));
        actor.exec(address(vault), abi.encodeCall(vault.requestWithdrawal, (P4, 400e6)));
        skip(DELAY);
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = 0; j < 2; j++) {
                uint256 snap = vm.snapshotState();
                uint256 rBefore = usdc.balanceOf(rcpt);
                _arm(i, j == 1);
                actor.exec(address(vault), abi.encodeCall(vault.withdraw, (P4, rcpt)));
                _assertGuarded();
                assertEq(usdc.balanceOf(rcpt) - rBefore, 400e6);
                assertEq(vault.assetsOf(P4), 600e6, "accounting intact");
                assertEq(vault.totalAssets(), 600e6);
                assertEq(usdc.balanceOf(address(vault)), 600e6);
                vm.revertToState(snap);
            }
        }
    }

    function test_Reentrancy_DuringSeize() public {
        _setupActor();
        actor.exec(address(vault), abi.encodeCall(vault.deposit, (P4, 1_000e6)));
        _borrow(P4, 300e6);
        facility.markDefault(P4);
        for (uint256 i = 0; i < 6; i++) {
            uint256 snap = vm.snapshotState();
            _arm(i, false);
            assertEq(vault.seize(P4), 300e6);
            _assertGuarded();
            assertEq(_debt(P4), 0);
            assertEq(vault.assetsOf(P4), 700e6, "accounting intact");
            assertEq(usdc.balanceOf(address(vault)), 700e6);
            assertEq(usdc.balanceOf(address(facility)), 300e6);
            vm.revertToState(snap);
        }
    }

    function test_Reentrancy_SeizeRepaysOnlyOnce() public {
        // a second, reentrant seize during the repayment transfer must not double count
        _setupActor();
        actor.exec(address(vault), abi.encodeCall(vault.deposit, (P4, 1_000e6)));
        _dep(c2, P2, 1_000e6);
        _borrow(P4, 300e6);
        facility.markDefault(P4);
        _arm(4, true);
        vault.seize(P4);
        assertEq(usdc.balanceOf(address(facility)), 300e6);
        assertEq(vault.assetsOf(P2), 1_000e6);
        assertEq(vault.totalAssets(), 1_700e6);
    }

    // ------------------------------------------------------------ misc token behaviour
    function test_Seize_RevertsAtomicallyWhenFacilityBlocklisted() public {
        _dep(c1, P1, 1_000e6);
        _borrow(P1, 100e6);
        facility.markDefault(P1);
        usdc.setBlocked(address(facility), true);
        vm.expectRevert();
        vault.seize(P1);
        assertEq(vault.assetsOf(P1), 1_000e6);
        assertEq(_debt(P1), 100e6);
        usdc.setBlocked(address(facility), false);
        assertEq(vault.seize(P1), 100e6);
    }

    function test_OtherProfilesUnaffectedByBlocklistedController() public {
        _dep(c1, P1, 1_000e6);
        _dep(c2, P2, 1_000e6);
        usdc.setBlocked(c1, true);
        // c1's own withdrawal to itself fails, c2 is unaffected
        _request(c1, P1, 10e6);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.TokenCallFailed.selector);
        vault.withdraw(P1, c1);
        assertEq(_exit(c2, P2, c2, 1_000e6), 1_000e6);
    }
}
