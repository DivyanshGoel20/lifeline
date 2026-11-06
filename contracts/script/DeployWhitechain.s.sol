// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LifelineCreditFacility} from "../src/LifelineCreditFacility.sol";

/**
 * @notice Deploys Lifeline's credit facility on Whitechain Sepolia, in USDT.
 *
 *   forge script script/DeployWhitechain.s.sol --rpc-url https://rpc.testnet.whitechain.io \
 *     --private-key $PRIVATE_KEY --broadcast --verify --verifier blockscout \
 *     --verifier-url https://explorer.testnet.whitechain.io/api/
 *
 * Then set WHITECHAIN_FACILITY_ADDRESS. The deployer owns it, and is the operator that
 * records drawdowns and repayments.
 */
contract DeployWhitechain is Script {
    uint256 constant WHITECHAIN_SEPOLIA = 1874;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external returns (LifelineCreditFacility facility) {
        require(block.chainid == WHITECHAIN_SEPOLIA, "This deploys on Whitechain Sepolia only");
        vm.startBroadcast();
        facility = new LifelineCreditFacility(USDT);
        vm.stopBroadcast();
        console2.log("WHITECHAIN_FACILITY_ADDRESS", address(facility));
    }
}
