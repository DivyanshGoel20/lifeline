// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {LifelineLendingPool} from "../src/LifelineLendingPool.sol";

contract LifelineLendingPoolTest is Test {
    MockUSDC usdc;
    LifelineLendingPool pool;

    address lender = address(0x1);
    address second = address(0x2);
    address operatorWallet = address(0x3);

    function setUp() public {
        usdc = new MockUSDC();
        pool = new LifelineLendingPool(address(usdc), 8000, 500e6);
        usdc.mint(lender, 1000e6);
        usdc.mint(second, 1000e6);
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(lender);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(second);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        pool.deposit(amount);
    }

    function test_depositAndWithdraw() public {
        _deposit(lender, 100e6);
        assertApproxEqAbs(pool.assetsOf(lender), 100e6, 1);
        vm.prank(lender);
        pool.withdraw(50e6);
        assertEq(usdc.balanceOf(lender), 950e6);
        assertApproxEqAbs(pool.assetsOf(lender), 50e6, 1);
    }

    function test_onlyOwnerDraws() public {
        _deposit(lender, 100e6);
        vm.prank(lender);
        vm.expectRevert("Pool: not owner");
        pool.draw(lender, 1e6);
    }

    function test_drawStopsAtUtilization() public {
        _deposit(lender, 100e6);
        pool.draw(operatorWallet, 80e6);
        assertEq(pool.utilizationBps(), 8000);
        vm.expectRevert("Pool: over utilization");
        pool.draw(operatorWallet, 1);
    }

    function test_drawStopsAtExposureCap() public {
        pool.setLimits(10_000, 50e6);
        _deposit(lender, 100e6);
        vm.expectRevert("Pool: over exposure cap");
        pool.draw(operatorWallet, 51e6);
        assertEq(pool.drawable(), 50e6);
    }

    function test_interestRaisesEveryLendersShare() public {
        _deposit(lender, 100e6);
        _deposit(second, 100e6);
        pool.draw(operatorWallet, 100e6);
        pool.repay(100e6, 10e6);
        assertEq(pool.outstanding(), 0);
        assertEq(pool.totalInterestEarned(), 10e6);
        assertApproxEqAbs(pool.assetsOf(lender), 105e6, 2);
        assertApproxEqAbs(pool.assetsOf(second), 105e6, 2);
    }

    function test_moneyOnLoanStillCountsInALendersValue() public {
        _deposit(lender, 100e6);
        pool.draw(operatorWallet, 50e6);
        assertApproxEqAbs(pool.assetsOf(lender), 100e6, 1);
    }

    function test_writeOffLowersLenderValue() public {
        _deposit(lender, 100e6);
        pool.draw(operatorWallet, 50e6);
        pool.writeOff(20e6);
        assertEq(pool.outstanding(), 30e6);
        assertEq(pool.totalWrittenOff(), 20e6);
        assertApproxEqAbs(pool.assetsOf(lender), 80e6, 1);
    }

    function test_lendersCannotWithdrawMoneyThatIsOutOnLoan() public {
        _deposit(lender, 100e6);
        pool.draw(operatorWallet, 80e6);
        vm.prank(lender);
        vm.expectRevert("Pool: not enough liquidity");
        pool.withdraw(21e6);
    }

    function test_cannotWithdrawAnotherLendersMoney() public {
        _deposit(lender, 100e6);
        vm.prank(second);
        vm.expectRevert("Pool: more than deposited");
        pool.withdraw(1e6);
    }

    function test_repayCannotExceedWhatIsOut() public {
        _deposit(lender, 100e6);
        pool.draw(operatorWallet, 10e6);
        vm.expectRevert("Pool: more than outstanding");
        pool.repay(11e6, 0);
    }

    function test_donationDoesNotDiluteTheNextLender() public {
        _deposit(lender, 1);
        usdc.mint(address(pool), 1000e6);
        _deposit(second, 100e6);
        assertGt(pool.assetsOf(second), 99e6);
    }

    function testFuzz_lenderNeverLeavesWithMoreThanIn(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 1000e6);
        _deposit(lender, amount);
        uint256 held = pool.assetsOf(lender);
        assertLe(held, amount);
        if (held == 0) return;
        vm.prank(lender);
        pool.withdraw(held);
        assertLe(usdc.balanceOf(lender), 1000e6);
    }
}
