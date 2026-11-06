// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestBase} from "./LifelineCollateralVault.Base.t.sol";
import {LifelineCollateralVault as V} from "../src/LifelineCollateralVault.sol";

contract VaultFuzzTest is VaultTestBase {
    bytes32[3] internal ids;
    address[3] internal ctl;
    uint256[3] internal depd; // deposits that actually went in
    uint256[3] internal paid; // cumulative payouts
    bool[3] internal early; // deposited before the donation
    uint256 internal sumEarly;
    uint256 internal maxP; // max observed price of one share (wei, rounded up)

    function setUp() public override {
        super.setUp();
        ids = [P1, P2, P3];
        ctl = [c1, c2, c3];
    }

    function _perm(uint256 k) internal pure returns (uint256[3] memory o) {
        uint256 first = k / 2;
        uint256 r0 = first == 0 ? 1 : 0;
        uint256 r1 = first == 2 ? 1 : 2;
        o[0] = first;
        o[1] = k % 2 == 0 ? r0 : r1;
        o[2] = k % 2 == 0 ? r1 : r0;
    }

    function _track() internal {
        uint256 den = vault.totalShares() + 1e6;
        uint256 p = (vault.totalAssets() + 1 + den - 1) / den;
        if (p > maxP) maxP = p;
    }

    function _exitFraction(uint256 i, uint256 bps) internal {
        _track();
        uint256 amt = (vault.assetsOf(ids[i]) * bps) / 10_000;
        if (amt == 0) return;
        paid[i] += _exit(ctl[i], ids[i], address(uint160(0x1000 + i)), amt);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_NobodyExitsWithMoreThanTheyPutIn(
        uint256[3] memory d,
        uint256 donation,
        uint256 donateAt,
        uint256 permSeed,
        uint256 exitSeed,
        uint256[3] memory bps
    ) public {
        donation = bound(donation, 0, 1e12);
        donateAt = bound(donateAt, 0, 3);
        maxP = 1;

        // phase 1: deposits in random order with the donation slotted in at a random point
        uint256[3] memory ord = _perm(bound(permSeed, 0, 5));
        for (uint256 k = 0; k <= 3; k++) {
            if (k == donateAt && donation > 0) usdc.mint(address(vault), donation);
            if (k == 3) break;
            _track();
            uint256 i = ord[k];
            uint256 amt = bound(d[i], 1e6, 1e12);
            vm.prank(ctl[i]);
            try vault.deposit(ids[i], amt) {
                depd[i] = amt;
                if (k < donateAt) {
                    early[i] = true;
                    sumEarly += amt;
                }
            } catch {} // a deposit that would mint 0 shares is rejected, not swallowed
        }

        // phase 2: random partial exits, then everybody sweeps what is left
        ord = _perm(bound(exitSeed, 0, 5));
        for (uint256 k = 0; k < 3; k++) _exitFraction(ord[k], bound(bps[ord[k]], 1, 10_000));
        ord = _perm(bound(exitSeed / 7, 0, 5));
        for (uint256 k = 0; k < 3; k++) _exitFraction(ord[k], 10_000);

        _assertNobodyGains(donation);
    }

    function _assertNobodyGains(uint256 donation) internal view {
        uint256 totalIn = donation;
        uint256 totalPaid;
        for (uint256 i = 0; i < 3; i++) {
            totalIn += depd[i];
            totalPaid += paid[i];
        }
        assertLe(totalPaid, totalIn, "payouts exceed money in");
        assertEq(usdc.balanceOf(address(vault)) + totalPaid, totalIn, "conservation");

        uint256 slack = 12 * (maxP + 1);
        for (uint256 i = 0; i < 3; i++) {
            uint256 cap = depd[i];
            if (early[i] && sumEarly > 0) cap += (donation * depd[i]) / sumEarly + 1;
            assertLe(paid[i], cap + slack, "profile took more than deposit + pro-rata donation");
            assertGe(paid[i] + slack, depd[i], "profile shorted beyond rounding");
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_LtvBoundaryIsExact(uint256 ltv, uint256 deposit, uint256 debt) public {
        ltv = bound(ltv, 1, 10_000);
        deposit = bound(deposit, 1e6, 1e12);
        vm.prank(vaultOwner);
        vault.setTerms(ltv, DELAY);
        _dep(c1, P1, deposit);
        uint256 maxDebt = (deposit * ltv) / 10_000;
        if (maxDebt > LIMIT) maxDebt = LIMIT;
        debt = bound(debt, 1, maxDebt);
        _borrow(P1, debt);

        uint256 minRemaining = (debt * 10_000 + ltv - 1) / ltv; // ceil
        assertLe(minRemaining, deposit);
        uint256 maxW = deposit - minRemaining;

        // one wei more than the boundary always reverts (state untouched on revert)
        _request(c1, P1, maxW + 1);
        skip(DELAY);
        vm.prank(c1);
        vm.expectRevert(V.WithdrawalExceedsLtv.selector);
        vault.withdraw(P1, rcpt);

        // exactly the boundary succeeds
        if (maxW > 0) {
            assertEq(_exit(c1, P1, rcpt, maxW), maxW);
            assertGe((vault.assetsOf(P1) * ltv) / 10_000, debt);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_SeizeRepaysMinOfDebtAndCollateral(uint256 dep1, uint256 dep2, uint256 debt) public {
        dep1 = bound(dep1, 1e6, 1e12);
        dep2 = bound(dep2, 1e6, 1e12);
        debt = bound(debt, 1, LIMIT);
        _dep(c1, P1, dep1);
        _dep(c2, P2, dep2);
        _borrow(P1, debt);
        facility.markDefault(P1);

        uint256 coll = vault.assetsOf(P1);
        uint256 other = vault.assetsOf(P2);
        uint256 facBal = usdc.balanceOf(address(facility));
        uint256 expected = debt < coll ? debt : coll;

        vm.prank(stranger);
        uint256 got = vault.seize(P1);

        assertEq(got, expected);
        assertEq(_debt(P1), debt - expected);
        assertEq(usdc.balanceOf(address(facility)) - facBal, expected);
        assertEq(usdc.balanceOf(stranger), 0);
        assertLe(vault.assetsOf(P1), coll - expected + 1);
        assertGe(vault.assetsOf(P2), other); // others never lose
        assertLe(vault.assetsOf(P2), other + 1);
    }
}
