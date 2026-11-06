// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault} from "../src/LifelineCollateralVault.sol";
import {LifelineCreditFacility} from "../src/LifelineCreditFacility.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

contract VaultHandler is Test {
    LifelineCollateralVault public vault;
    LifelineCreditFacility public facility;
    MockUSDC public usdc;
    MockERC4626 public yv;
    address public vaultOwner;
    bytes32[3] public ids;
    address[3] public ctl;

    uint256 public totalIn; // deposits + donations + yield, i.e. all value that ever entered
    uint256 public totalOut; // withdrawals + seized amounts, i.e. all value that ever left
    uint256 public calls;
    uint256 public yieldSwitches;

    constructor(
        LifelineCollateralVault v,
        LifelineCreditFacility f,
        MockUSDC u,
        MockERC4626 y,
        address owner_,
        bytes32[3] memory ids_,
        address[3] memory ctl_
    ) {
        vault = v;
        facility = f;
        usdc = u;
        yv = y;
        vaultOwner = owner_;
        ids = ids_;
        ctl = ctl_;
    }

    function deposit(uint256 i, uint256 amt) external {
        i = bound(i, 0, 2);
        amt = bound(amt, 1, 1e12);
        usdc.mint(ctl[i], amt);
        vm.prank(ctl[i]);
        try vault.deposit(ids[i], amt) {
            totalIn += amt;
            calls++;
        } catch {}
    }

    function exit(uint256 i, uint256 bps) external {
        i = bound(i, 0, 2);
        uint256 amt = (vault.assetsOf(ids[i]) * bound(bps, 1, 10_000)) / 10_000;
        if (amt == 0) return;
        vm.prank(ctl[i]);
        try vault.requestWithdrawal(ids[i], amt) {} catch {
            return;
        }
        vm.warp(block.timestamp + vault.withdrawDelay());
        vm.prank(ctl[i]);
        try vault.withdraw(ids[i], address(0xBEEF)) returns (uint256 out) {
            totalOut += out;
            calls++;
        } catch {}
    }

    function donate(uint256 amt) external {
        amt = bound(amt, 1, 1e12);
        usdc.mint(address(vault), amt);
        totalIn += amt;
        calls++;
    }

    function borrow(uint256 i, uint256 amt) external {
        i = bound(i, 0, 2);
        amt = bound(amt, 1, 1_000e6);
        address agent = address(uint160(uint256(keccak256(abi.encode("agent", ids[i])))));
        if (!facility.isAgentAuthorized(ids[i], agent)) facility.authorizeAgent(ids[i], agent);
        try facility.recordDrawdown(ids[i], agent, amt, 1, bytes32(0)) {} catch {}
    }

    function markDefault(uint256 i) external {
        i = bound(i, 0, 2);
        try facility.markDefault(ids[i]) {} catch {}
    }

    function seize(uint256 i) external {
        i = bound(i, 0, 2);
        try vault.seize(ids[i]) returns (uint256 a) {
            totalOut += a;
            calls++;
        } catch {}
    }

    function toggleYield() external {
        address next = vault.yieldVault() == address(0) ? address(yv) : address(0);
        vm.prank(vaultOwner);
        try vault.setYieldVault(next) {
            yieldSwitches++;
        } catch {}
    }

    function accrueYield(uint256 amt) external {
        if (vault.yieldVault() == address(0) || yv.totalSupply() == 0) return;
        amt = bound(amt, 1, 1e11);
        yv.donate(amt);
        totalIn += amt;
    }

    function sumShares() external view returns (uint256 s) {
        for (uint256 i = 0; i < 3; i++) s += vault.sharesOf(ids[i]);
    }

    function sumAssets() external view returns (uint256 s) {
        for (uint256 i = 0; i < 3; i++) s += vault.assetsOf(ids[i]);
    }
}

contract VaultInvariantTest is VaultTestBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        MockERC4626 yv = _mkYield();
        handler = new VaultHandler(vault, facility, usdc, yv, vaultOwner, [P1, P2, P3], [c1, c2, c3]);
        facility.transferOwnership(address(handler)); // handler can record debt / mark default
        targetContract(address(handler));
    }

    /// solvency: the sum of what every profile can claim never exceeds what the vault holds
    function invariant_SumOfAssetsOfLeTotalAssets() public view {
        assertLe(handler.sumAssets(), vault.totalAssets());
    }

    /// share accounting: totalShares is exactly the sum of per-profile shares
    function invariant_TotalSharesEqualsSumOfShares() public view {
        assertEq(vault.totalShares(), handler.sumShares());
    }

    /// nobody (controllers + facility via seize) has taken out more than ever went in
    function invariant_OutflowNeverExceedsInflow() public view {
        assertLe(handler.totalOut(), handler.totalIn() + 1_000);
    }

    /// value the vault still holds plus value that left never exceeds value that entered
    function invariant_HoldingsPlusOutflowLeInflow() public view {
        assertLe(vault.totalAssets() + handler.totalOut(), handler.totalIn() + 1_000);
    }
}
