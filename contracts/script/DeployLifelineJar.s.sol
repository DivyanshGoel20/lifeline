// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

interface ITjarFactory {
    function deploy(
        address revenueToken,
        address revenueRecipient,
        uint256 threshold,
        address owner,
        address configSetter,
        bytes32 salt
    ) external returns (address jar, address releaser);

    function predictJar(address deployer, bytes32 salt) external view returns (address);
}

/**
 * @notice Deploys Lifeline's Token Jar and Releaser through Uniswap's TJAR factory on Base.
 *
 * MAINNET, REAL MONEY. Without --broadcast this only simulates, which is safe:
 *   forge script script/DeployLifelineJar.s.sol --rpc-url https://mainnet.base.org
 *
 * Environment:
 *   LIFELINE_JAR_RECIPIENT       Where each clearing's USDC goes: Lifeline's wallet on Base
 *   LIFELINE_JAR_OWNER           Owns the jar and releaser. A multisig, ideally
 *   LIFELINE_JAR_THRESHOLD_USDC  USDC a clearing costs, in 6 decimals. Default 5000000 ($5)
 */
contract DeployLifelineJar is Script {
    ITjarFactory constant FACTORY = ITjarFactory(0xfAc70EEEE259F2140CBbB8e3157b75A52ce39fee);
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant BASE_CHAIN_ID = 8453;

    function run() external returns (address jar, address releaser) {
        require(block.chainid == BASE_CHAIN_ID, "This deploys on Base only");

        address recipient = vm.envAddress("LIFELINE_JAR_RECIPIENT");
        address owner = vm.envAddress("LIFELINE_JAR_OWNER");
        uint256 threshold = vm.envOr("LIFELINE_JAR_THRESHOLD_USDC", uint256(5_000_000));
        bytes32 salt = keccak256("lifeline.jar.v1");

        vm.startBroadcast();
        (jar, releaser) = FACTORY.deploy(BASE_USDC, recipient, threshold, owner, owner, salt);
        vm.stopBroadcast();

        console2.log("LIFELINE_JAR_ADDRESS", jar);
        console2.log("LIFELINE_JAR_RELEASER_ADDRESS", releaser);
    }
}
