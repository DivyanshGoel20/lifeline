// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./LifelineLendingPool.Base.t.sol";
import {LifelineLendingPool} from "../src/LifelineLendingPool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PoolHandler is Test {
    LifelineLendingPool public pool;
    MockUSDC public usdc;
    address public poolOwner;
    address[3] public lenders;
    address public borrower = address(0xB0770);

    uint256 public totalIn; // deposits + repayments + donations
    uint256 public totalOut; // withdrawals + draws

    constructor(LifelineLendingPool p, MockUSDC u, address owner_, address[3] memory l) {
        pool = p;
        usdc = u;
        poolOwner = owner_;
        lenders = l;
        usdc.mint(borrower, type(uint128).max);
        vm.prank(borrower);
        usdc.approve(address(p), type(uint256).max);
    }

    function deposit(uint256 j, uint256 amt) external {
        j = bound(j, 0, 2);
        amt = bound(amt, 1, 1e12);
        usdc.mint(lenders[j], amt);
        vm.prank(lenders[j]);
        try pool.deposit(amt) {
            totalIn += amt;
        } catch {}
    }

    function withdraw(uint256 j, uint256 bps) external {
        j = bound(j, 0, 2);
        uint256 a = (pool.assetsOf(lenders[j]) * bound(bps, 1, 10_000)) / 10_000;
        if (a > pool.cash()) a = pool.cash();
        if (a == 0) return;
        vm.prank(lenders[j]);
        try pool.withdraw(a) {
            totalOut += a;
        } catch {}
    }

    function draw(uint256 amt) external {
        uint256 d = pool.drawable();
        if (d == 0) return;
        amt = bound(amt, 1, d);
        vm.prank(poolOwner);
        try pool.draw(address(0xD00D), amt) {
            totalOut += amt;
        } catch {}
    }

    function repay(uint256 principal, uint256 interest) external {
        uint256 o = pool.outstanding();
        principal = bound(principal, 0, o);
        interest = bound(interest, 0, 1e11);
        if (principal == 0 && interest == 0) return;
        vm.prank(borrower);
        try pool.repay(principal, interest) {
            totalIn += principal + interest;
        } catch {}
    }

    function writeOff(uint256 amt) external {
        uint256 o = pool.outstanding();
        if (o == 0) return;
        amt = bound(amt, 1, o);
        vm.prank(poolOwner);
        try pool.writeOff(amt) {} catch {}
    }

    function donate(uint256 amt) external {
        amt = bound(amt, 1, 1e11);
        usdc.mint(address(pool), amt);
        totalIn += amt;
    }

    function setLimits(uint256 u, uint256 cap) external {
        u = bound(u, 1, 10_000);
        cap = bound(cap, 0, 1e13);
        vm.prank(poolOwner);
        pool.setLimits(u, cap);
    }

    function sumShares() external view returns (uint256 s) {
        for (uint256 i = 0; i < 3; i++) s += pool.sharesOf(lenders[i]);
    }

    function sumAssets() external view returns (uint256 s) {
        for (uint256 i = 0; i < 3; i++) s += pool.assetsOf(lenders[i]);
    }
}

contract PoolInvariantTest is PoolTestBase {
    PoolHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PoolHandler(pool, usdc, poolOwner, [l1, l2, l3]);
        targetContract(address(handler));
    }

    /// solvency: lenders' claims never exceed the pool's assets
    function invariant_SumOfAssetsOfLeTotalAssets() public view {
        assertLe(handler.sumAssets(), pool.totalAssets());
    }

    function invariant_TotalSharesEqualsSumOfShares() public view {
        assertEq(pool.totalShares(), handler.sumShares());
    }

    function invariant_TotalAssetsIsCashPlusOutstanding() public view {
        assertEq(pool.totalAssets(), pool.cash() + pool.outstanding());
        assertEq(pool.cash(), usdc.balanceOf(address(pool)));
    }

    /// the pool's token balance is exactly what came in minus what went out
    function invariant_CashMatchesFlows() public view {
        assertEq(pool.cash(), handler.totalIn() - handler.totalOut());
    }

    function invariant_UtilizationNeverAbove100Percent() public view {
        assertLe(pool.utilizationBps(), 10_000);
    }
}
