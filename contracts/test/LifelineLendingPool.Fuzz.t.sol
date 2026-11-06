// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolTestBase} from "./LifelineLendingPool.Base.t.sol";
import {LifelineLendingPool as P} from "../src/LifelineLendingPool.sol";

contract PoolFuzzTest is PoolTestBase {
    address[3] internal lenders;
    uint256[3] internal deposited;
    uint256[3] internal withdrawn;

    // ghost accounting
    uint256 internal gDeposited;
    uint256 internal gWithdrawn;
    uint256 internal gDrawn;
    uint256 internal gPrincipal;
    uint256 internal gWritten;

    function setUp() public override {
        super.setUp();
        lenders = [l1, l2, l3];
        _limits(10_000, type(uint128).max);
    }

    // ------------------------------------------------------------ random op sequences, no interest/donations
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_Sequence_NoLenderGainsWithoutInterest(uint256 seed) public {
        for (uint256 k = 0; k < 40; k++) {
            uint256 h = uint256(keccak256(abi.encode(seed, k)));
            uint256 j = (h >> 8) % 3;
            uint256 kind = h % 6;
            uint256 r = uint256(keccak256(abi.encode(h)));
            _step(kind, j, r);

            // per-step invariants
            assertEq(pool.totalAssets(), pool.cash() + pool.outstanding());
            assertEq(pool.cash(), gDeposited + gPrincipal - gWithdrawn - gDrawn, "cash ghost");
            assertEq(pool.outstanding(), gDrawn - gPrincipal - gWritten, "outstanding ghost");
            assertEq(usdc.balanceOf(address(pool)), pool.cash());
            uint256 sumShares;
            uint256 sumAssets;
            for (uint256 i = 0; i < 3; i++) {
                sumShares += pool.sharesOf(lenders[i]);
                sumAssets += pool.assetsOf(lenders[i]);
                // nobody can ever extract more than they put in (no interest was paid)
                assertLe(withdrawn[i] + pool.assetsOf(lenders[i]), deposited[i] + 2, "lender gained");
            }
            assertEq(pool.totalShares(), sumShares);
            assertLe(sumAssets, pool.totalAssets());
        }

        // everybody tries to leave: cash-limited, but the total never exceeds deposits (+dust)
        uint256 outstandingNow = pool.outstanding();
        if (outstandingNow > 0) _repay(borrower, outstandingNow, 0); // principal only, no interest
        for (uint256 i = 0; i < 3; i++) {
            uint256 a = pool.assetsOf(lenders[i]);
            if (a > 0) {
                _wd(lenders[i], a);
                withdrawn[i] += a;
            }
            assertLe(withdrawn[i], deposited[i] + 2, "lender exited with more than deposited");
        }
    }

    function _step(uint256 kind, uint256 j, uint256 r) internal {
        address who = lenders[j];
        if (kind == 0) {
            _doDeposit(j, bound(r, 1, 1e12));
        } else if (kind == 1) {
            uint256 cap = pool.assetsOf(who);
            uint256 c = pool.cash();
            if (c < cap) cap = c;
            if (cap == 0) return;
            uint256 amt = bound(r, 1, cap);
            _wd(who, amt);
            withdrawn[j] += amt;
            gWithdrawn += amt;
        } else if (kind == 2) {
            uint256 d = pool.drawable();
            if (d == 0) return;
            uint256 amt = bound(r, 1, d);
            _draw(rcpt, amt);
            gDrawn += amt;
        } else if (kind == 3) {
            uint256 o = pool.outstanding();
            if (o == 0) return;
            uint256 amt = bound(r, 1, o);
            _repay(borrower, amt, 0);
            gPrincipal += amt;
        } else if (kind == 4) {
            uint256 o = pool.outstanding();
            if (o == 0) return;
            uint256 amt = bound(r, 1, o);
            _writeOff(amt);
            gWritten += amt;
        } else {
            // dust-sized deposits and exact-balance withdrawals stress rounding
            if (r % 2 == 0) {
                _doDeposit(j, bound(r >> 1, 1, 5));
                return;
            }
            uint256 a = pool.assetsOf(who);
            uint256 c = pool.cash();
            if (c < a) a = c;
            if (a == 0) return;
            _wd(who, a);
            withdrawn[j] += a;
            gWithdrawn += a;
        }
    }

    function _doDeposit(uint256 j, uint256 amt) internal {
        vm.prank(lenders[j]);
        try pool.deposit(amt) {
            deposited[j] += amt;
            gDeposited += amt;
        } catch {} // ZeroShares can only happen when a dust deposit meets a high share price
    }

    // ------------------------------------------------------------ drawable() is the exact max draw
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_DrawableIsExactMaxDraw(
        uint256 deposit,
        uint256 util,
        uint256 cap,
        uint256 preDraw,
        uint256 interest,
        uint256 written
    ) public {
        deposit = bound(deposit, 1, 1e12);
        util = bound(util, 1, 10_000);
        cap = bound(cap, 0, 2e12);
        _dep(l1, deposit);
        _limits(10_000, type(uint128).max);

        uint256 d0 = pool.drawable();
        uint256 drawnPre;
        if (d0 > 0) {
            drawnPre = bound(preDraw, 1, d0);
            _draw(rcpt, drawnPre);
        }
        if (pool.outstanding() > 0) {
            written = bound(written, 0, pool.outstanding() / 2);
            if (written > 0) _writeOff(written);
        }
        interest = bound(interest, 0, 1e12);
        if (interest > 0) _repay(borrower, 0, interest);
        _limits(util, cap);

        uint256 d = pool.drawable();
        // never more than cash, cap headroom or utilisation headroom
        assertLe(d, pool.cash());
        assertLe(pool.outstanding() + d, cap > pool.outstanding() ? cap : pool.outstanding());
        if (d > 0) assertLe((pool.outstanding() + d) * 10_000, pool.totalAssets() * util);

        // d + 1 always reverts, and leaves state untouched
        vm.prank(poolOwner);
        vm.expectRevert();
        pool.draw(rcpt, d + 1);
        // d succeeds (when positive) and leaves no headroom
        if (d > 0) {
            _draw(rcpt, d);
            assertEq(pool.drawable(), 0);
            assertEq(usdc.balanceOf(rcpt), drawnPre + d);
        }
    }

    // ------------------------------------------------------------ nobody exits with more than deposit + pro-rata earnings
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ExitBoundedByDepositPlusProRataEarnings(
        uint256[3] memory d,
        uint256 interest,
        uint256 donation,
        uint256 exitSeed
    ) public {
        uint256 sumD;
        for (uint256 i = 0; i < 3; i++) {
            d[i] = bound(d[i], 1e6, 1e12);
            _dep(lenders[i], d[i]);
            sumD += d[i];
        }
        interest = bound(interest, 0, 1e12);
        donation = bound(donation, 0, 1e12);
        _limits(10_000, type(uint128).max);
        uint256 drawAmt = pool.drawable() / 2;
        if (drawAmt > 0) _draw(rcpt, drawAmt);
        if (interest > 0 || drawAmt > 0) _repay(borrower, drawAmt, interest);
        if (donation > 0) usdc.mint(address(pool), donation);

        uint256 totalPaid;
        uint256 start = bound(exitSeed, 0, 2);
        for (uint256 k = 0; k < 3; k++) {
            uint256 i = (start + k) % 3;
            uint256 a = pool.assetsOf(lenders[i]);
            if (a == 0) continue;
            uint256 before_ = usdc.balanceOf(lenders[i]);
            _wd(lenders[i], a);
            uint256 got = usdc.balanceOf(lenders[i]) - before_;
            totalPaid += got;
            uint256 cap_ = d[i] + ((interest + donation) * d[i]) / sumD + 3;
            assertLe(got, cap_, "lender exceeded deposit + pro-rata earnings");
            assertGe(got + 3, d[i], "lender shorted beyond rounding");
        }
        assertLe(totalPaid, sumD + interest + donation);
    }
}
