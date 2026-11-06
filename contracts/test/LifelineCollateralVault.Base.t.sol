// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LifelineCollateralVault} from "../src/LifelineCollateralVault.sol";
import {LifelineCreditFacility} from "../src/LifelineCreditFacility.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {Actor} from "./mocks/Actor.sol";

abstract contract VaultTestBase is Test {
    MockUSDC internal usdc;
    LifelineCreditFacility internal facility; // owned by address(this)
    LifelineCollateralVault internal vault;

    address internal vaultOwner = makeAddr("vaultOwner");
    address internal stranger = makeAddr("stranger");
    address internal rcpt = makeAddr("recipient");

    bytes32 internal constant P1 = keccak256("profile-1");
    bytes32 internal constant P2 = keccak256("profile-2");
    bytes32 internal constant P3 = keccak256("profile-3");
    bytes32 internal constant PX = keccak256("profile-nonexistent");

    address internal c1 = makeAddr("controller1");
    address internal c2 = makeAddr("controller2");
    address internal c3 = makeAddr("controller3");

    uint256 internal constant LTV = 5000;
    uint256 internal constant DELAY = 1 days;
    uint256 internal constant LIMIT = 5_000e6;
    uint256 internal constant FUND = 100_000_000e6;

    function setUp() public virtual {
        usdc = new MockUSDC();
        facility = new LifelineCreditFacility(address(usdc));
        vm.prank(vaultOwner);
        vault = new LifelineCollateralVault(address(usdc), address(facility), LTV, DELAY);

        _mkProfile(P1, 1);
        _mkProfile(P2, 2);
        _mkProfile(P3, 3);
        vm.startPrank(vaultOwner);
        vault.bindController(P1, c1);
        vault.bindController(P2, c2);
        vault.bindController(P3, c3);
        vm.stopPrank();

        _fund(c1);
        _fund(c2);
        _fund(c3);
        vm.warp(1_000_000);
    }

    function _fund(address who) internal {
        usdc.mint(who, FUND);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _mkProfile(bytes32 p, uint256 salt) internal {
        facility.createCreditProfile(p, makeAddr(string.concat("human", vm.toString(salt))), keccak256(abi.encode("root", p)), LIMIT);
    }

    function _agent(bytes32 p) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("agent", p)))));
    }

    /// @dev records `amt` of facility debt on profile `p`
    function _borrow(bytes32 p, uint256 amt) internal {
        if (!facility.isAgentAuthorized(p, _agent(p))) facility.authorizeAgent(p, _agent(p));
        facility.recordDrawdown(p, _agent(p), amt, 1, bytes32(0));
    }

    function _debt(bytes32 p) internal view returns (uint256) {
        return facility.getOutstandingDebt(p);
    }

    function _status(bytes32 p) internal view returns (uint8 s) {
        (,,,,,,, LifelineCreditFacility.ProfileStatus st,) = facility.profiles(p);
        s = uint8(st);
    }

    function _dep(address c, bytes32 p, uint256 amt) internal returns (uint256 shares) {
        vm.prank(c);
        shares = vault.deposit(p, amt);
    }

    function _request(address c, bytes32 p, uint256 amt) internal {
        vm.prank(c);
        vault.requestWithdrawal(p, amt);
    }

    /// @dev request + wait + withdraw to `to`. Returns payout.
    function _exit(address c, bytes32 p, address to, uint256 amt) internal returns (uint256 out) {
        _request(c, p, amt);
        skip(vault.withdrawDelay());
        vm.prank(c);
        out = vault.withdraw(p, to);
    }

    function _mkYield() internal returns (MockERC4626 yv) {
        yv = new MockERC4626(address(usdc));
    }

    function _selector(bytes memory ret) internal pure returns (bytes4) {
        return bytes4(ret);
    }
}
