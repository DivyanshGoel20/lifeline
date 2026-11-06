// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {LifelineCreditFacility} from "../src/LifelineCreditFacility.sol";
import {LifelineCollateralVault} from "../src/LifelineCollateralVault.sol";

/// @dev A minimal ERC-4626 stand-in whose value can be raised to simulate yield.
contract MockYieldVault {
    MockUSDC public immutable usdc;
    mapping(address => uint256) public balanceOf;
    uint256 public totalShares;

    constructor(MockUSDC _usdc) {
        usdc = _usdc;
    }

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? shares : (shares * totalAssets()) / totalShares;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = totalShares == 0 ? assets : (assets * totalShares) / totalAssets();
        usdc.transferFrom(msg.sender, address(this), assets);
        balanceOf[receiver] += shares;
        totalShares += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = (assets * totalShares + totalAssets() - 1) / totalAssets();
        balanceOf[owner] -= shares;
        totalShares -= shares;
        usdc.transfer(receiver, assets);
    }
}

contract LifelineCollateralVaultTest is Test {
    MockUSDC usdc;
    LifelineCreditFacility facility;
    LifelineCollateralVault vault;

    address alice = address(0xA11CE);
    address stranger = address(0xBAD);
    address agent = address(0xA6E);
    bytes32 profile = keccak256("alice");
    uint256 constant LTV = 8000;
    uint256 constant DELAY = 1 hours;

    function setUp() public {
        usdc = new MockUSDC();
        facility = new LifelineCreditFacility(address(usdc));
        vault = new LifelineCollateralVault(address(usdc), address(facility), LTV, DELAY);

        facility.createCreditProfile(profile, address(this), keccak256("root"), 1000e6);
        facility.authorizeAgent(profile, agent);
        vault.bindController(profile, alice);

        usdc.mint(alice, 1000e6);
        usdc.mint(stranger, 1000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(stranger);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(alice);
        vault.deposit(profile, amount);
    }

    function _borrow(uint256 amount) internal {
        facility.recordDrawdown(profile, agent, amount, 1, keccak256("ref"));
    }

    function test_depositBacksCreditAtTheLtv() public {
        _deposit(100e6);
        assertApproxEqAbs(vault.assetsOf(profile), 100e6, 1);
        assertApproxEqAbs(vault.creditableOf(profile), 80e6, 1);
    }

    function test_onlyTheBoundControllerMayDeposit() public {
        vm.prank(stranger);
        vm.expectRevert("Vault: not controller");
        vault.deposit(profile, 10e6);
    }

    function test_controllerBindsOnceAndOnlyByOwner() public {
        vm.prank(stranger);
        vm.expectRevert("Vault: not owner");
        vault.bindController(keccak256("other"), stranger);

        vm.expectRevert("Vault: already bound");
        vault.bindController(profile, stranger);
    }

    function test_withdrawalWaitsForTheDelay() public {
        _deposit(100e6);
        vm.startPrank(alice);
        vault.requestWithdrawal(profile, 50e6);
        vm.expectRevert("Vault: too early");
        vault.withdraw(profile, alice);
        vm.warp(block.timestamp + DELAY);
        vault.withdraw(profile, alice);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 950e6);
        assertApproxEqAbs(vault.assetsOf(profile), 50e6, 1);
    }

    function test_requestedMoneyStopsBackingCreditImmediately() public {
        _deposit(100e6);
        vm.prank(alice);
        vault.requestWithdrawal(profile, 50e6);
        assertApproxEqAbs(vault.creditableOf(profile), 40e6, 1);
    }

    function test_cannotWithdrawCollateralThatBacksDebt() public {
        _deposit(100e6);
        _borrow(60e6);
        vm.prank(alice);
        vault.requestWithdrawal(profile, 50e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(alice);
        vm.expectRevert("Vault: collateral backs debt");
        vault.withdraw(profile, alice);
    }

    function test_debtBorrowedAfterTheRequestStillBlocksTheWithdrawal() public {
        _deposit(100e6);
        vm.prank(alice);
        vault.requestWithdrawal(profile, 100e6);
        _borrow(1e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(alice);
        vm.expectRevert("Vault: collateral backs debt");
        vault.withdraw(profile, alice);
    }

    function test_strangerCannotWithdraw() public {
        _deposit(100e6);
        vm.prank(stranger);
        vm.expectRevert("Vault: not controller");
        vault.requestWithdrawal(profile, 1e6);
        vm.prank(stranger);
        vm.expectRevert("Vault: not controller");
        vault.withdraw(profile, stranger);
    }

    function test_seizeNeedsADefault() public {
        _deposit(100e6);
        _borrow(50e6);
        vm.expectRevert("Vault: not in default");
        vault.seize(profile);
    }

    function test_anyoneCanSeizeAfterDefaultAndItRepaysTheDebt() public {
        _deposit(100e6);
        _borrow(50e6);
        facility.markDefault(profile);

        vm.prank(stranger);
        uint256 taken = vault.seize(profile);

        assertEq(taken, 50e6);
        assertEq(facility.getOutstandingDebt(profile), 0);
        assertEq(usdc.balanceOf(address(facility)), 50e6);
        assertApproxEqAbs(vault.assetsOf(profile), 50e6, 2);
        assertEq(usdc.balanceOf(stranger), 1000e6);
    }

    function test_seizeTakesOnlyWhatIsThereWhenDebtIsLarger() public {
        _deposit(10e6);
        _borrow(50e6);
        facility.markDefault(profile);
        vault.seize(profile);
        assertEq(vault.assetsOf(profile), 0);
        assertEq(vault.sharesOf(profile), 0);
        assertEq(facility.getOutstandingDebt(profile), 40e6);
    }

    function test_seizeCancelsAPendingWithdrawal() public {
        _deposit(100e6);
        _borrow(10e6);
        vm.prank(alice);
        vault.requestWithdrawal(profile, 80e6);
        facility.markDefault(profile);
        vault.seize(profile);
        (uint256 assets, ) = vault.withdrawalOf(profile);
        assertEq(assets, 0);
    }

    function test_donationDoesNotDiluteTheNextDepositor() public {
        _deposit(1);
        usdc.mint(address(vault), 1000e6);

        bytes32 second = keccak256("bob");
        vault.bindController(second, stranger);
        vm.prank(stranger);
        vault.deposit(second, 100e6);
        assertGt(vault.assetsOf(second), 99e6);
    }

    function test_yieldAccruesToDepositorsAndCanBeWithdrawn() public {
        MockYieldVault y = new MockYieldVault(usdc);
        vault.setYieldVault(address(y));
        _deposit(100e6);
        assertEq(usdc.balanceOf(address(y)), 100e6);

        usdc.mint(address(y), 10e6);
        assertApproxEqAbs(vault.assetsOf(profile), 110e6, 2);
        assertApproxEqAbs(vault.creditableOf(profile), 88e6, 2);

        vm.startPrank(alice);
        vault.requestWithdrawal(profile, 105e6);
        vm.warp(block.timestamp + DELAY);
        vault.withdraw(profile, alice);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 1005e6);
    }

    function test_movingYieldSourceKeepsTheMoney() public {
        MockYieldVault y = new MockYieldVault(usdc);
        vault.setYieldVault(address(y));
        _deposit(100e6);
        vault.setYieldVault(address(0));
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertApproxEqAbs(vault.assetsOf(profile), 100e6, 1);
    }

    function testFuzz_depositThenFullExitNeverPaysOutMoreThanIn(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 1000e6);
        _deposit(amount);
        uint256 held = vault.assetsOf(profile);
        assertLe(held, amount);
        if (held == 0) return;
        vm.prank(alice);
        vault.requestWithdrawal(profile, held);
        vm.warp(block.timestamp + DELAY);
        vm.prank(alice);
        vault.withdraw(profile, alice);
        assertLe(usdc.balanceOf(alice), 1000e6);
    }
}
