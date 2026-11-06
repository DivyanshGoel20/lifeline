// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LifelineCollateralVault} from "../src/LifelineCollateralVault.sol";
import {LifelineLendingPool} from "../src/LifelineLendingPool.sol";

/**
 * Deploys the collateral vault and the lending pool beside an existing facility.
 *
 *   forge script script/DeploySecured.s.sol --rpc-url arc_testnet --broadcast
 *
 * Then set LIFELINE_COLLATERAL_VAULT_ADDRESS and LIFELINE_LENDING_POOL_ADDRESS.
 */
contract DeploySecured is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (LifelineCollateralVault vault, LifelineLendingPool pool) {
        address usdc = vm.envOr("NEXT_PUBLIC_USDC_ADDRESS", ARC_USDC);
        address facility = vm.envAddress("LIFELINE_CREDIT_FACILITY_ADDRESS");
        uint256 ltvBps = vm.envOr("LIFELINE_COLLATERAL_LTV_BPS", uint256(8000));
        uint256 delay = vm.envOr("LIFELINE_COLLATERAL_WITHDRAW_DELAY", uint256(1 hours));
        uint256 maxUtilization = vm.envOr("LIFELINE_POOL_MAX_UTILIZATION_BPS", uint256(8000));
        uint256 exposureCap = vm.envOr("LIFELINE_POOL_EXPOSURE_CAP", uint256(100e6));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        vault = new LifelineCollateralVault(usdc, facility, ltvBps, delay);
        pool = new LifelineLendingPool(usdc, maxUtilization, exposureCap);
        vm.stopBroadcast();

        console2.log("LifelineCollateralVault", address(vault));
        console2.log("LifelineLendingPool", address(pool));
    }
}
