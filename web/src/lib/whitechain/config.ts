import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Lifeline on Whitechain Sepolia: USDT, settled by a facilitator Lifeline runs.
 *
 * Arc and Sui have their own rails and their own money. This one shares only the
 * human and the agent's EVM key: its debts, its line and its record are its own.
 */
export const WC_CHAIN_ID = 1874;
export const WC_NETWORK = "eip155:1874";
export const WC_USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as const;
export const WC_USDT_DECIMALS = 6;
/** Read from the token: its DOMAIN_SEPARATOR is computed from exactly these. */
export const WC_USDT_DOMAIN = { name: "Tether USD", version: "1" } as const;
export const WC_EXPLORER = "https://explorer.testnet.whitechain.io";

export const wcRpcUrl = () => process.env.WHITECHAIN_RPC_URL || "https://rpc.testnet.whitechain.io";

export const whitechainSepolia = defineChain({
  id: WC_CHAIN_ID,
  name: "Whitechain Sepolia",
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.whitechain.io"] } },
  blockExplorers: { default: { name: "Blockscout", url: WC_EXPLORER } },
  testnet: true,
  // Without this viem assumes 12 second blocks and polls every 4 seconds.
  blockTime: 1000,
});

export const wcPublicClient = () => createPublicClient({ chain: whitechainSepolia, transport: http(wcRpcUrl()) });
export const wcWalletFor = (privateKey: `0x${string}`) =>
  createWalletClient({ account: privateKeyToAccount(privateKey), chain: whitechainSepolia, transport: http(wcRpcUrl()) });

/** Pays the WBT for relayed transactions, signs purchases on credit, and owns the facility. */
export function wcOperatorKey(): `0x${string}` {
  const pk = (process.env.WHITECHAIN_OPERATOR_KEY || process.env.PRIVATE_KEY) as `0x${string}` | undefined;
  if (!pk) throw new Error("No operator key for Whitechain (WHITECHAIN_OPERATOR_KEY).");
  return pk;
}

export const wcFacilityAddress = () => (process.env.WHITECHAIN_FACILITY_ADDRESS || null) as `0x${string}` | null;
export const wcConfigured = () => Boolean(wcFacilityAddress());

export const USDT_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function isBlocked(address) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

export const WC_FACILITY_ABI = parseAbi([
  "function createCreditProfile(bytes32 profileId, address humanOwner, bytes32 humanRoot, uint256 initialCreditLimit)",
  "function setCreditLimit(bytes32 profileId, uint256 newLimit)",
  "function authorizeAgent(bytes32 profileId, address agentAddress)",
  "function isAgentAuthorized(bytes32 profileId, address agentAddress) view returns (bool)",
  "function getOutstandingDebt(bytes32 profileId) view returns (uint256)",
  "function getRemainingCredit(bytes32 profileId) view returns (uint256)",
  "function recordDrawdown(bytes32 profileId, address agentAddress, uint256 amount, uint32 paymentCount, bytes32 referenceHash) returns (uint256 loanId)",
  "function recordRepayment(bytes32 profileId, address payer, address beneficiaryAgent, uint256 amount) returns (uint256 actualRepaid, uint256 remainingDebt)",
  "function withdraw(address to, uint256 amount)",
]);

export const wcTx = (hash: string) => `${WC_EXPLORER}/tx/${hash}`;
