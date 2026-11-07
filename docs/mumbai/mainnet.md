# Going to mainnet

**Nothing here has been run with real money.** The code is ready to switch, and these are the steps.

## The switch

`NEXT_PUBLIC_ARC_NETWORK=mainnet` moves every Arc read, write, payment and bridge to Arc mainnet:
chain 5042, its RPC and explorer, Circle Gateway's mainnet API, and Bridge Kit's mainnet chains. The default
is testnet. On mainnet there are no fallback addresses, so the contracts must be deployed and named.

Checked on Arc mainnet: USDC answers at `0x3600…0000`, and Circle Gateway lists `eip155:5042`.

## Steps

1. **Use a wallet that holds little.** The operator key sits on the server.
2. **Deploy on Arc:** the facility (`script/DeployArc.s.sol`), then the vault and pool (`script/DeploySecured.s.sol`).
3. **The jar is already on Base:** `0x9282BCCAda9C009CCC4c80e52a0A02b342fc0e8B`. See [uniswap.md](uniswap.md).
4. **Set the addresses:** `LIFELINE_CREDIT_FACILITY_ADDRESS`, `NEXT_PUBLIC_LIFELINE_CREDIT_FACILITY_ADDRESS`,
   `LIFELINE_COLLATERAL_VAULT_ADDRESS`, `LIFELINE_LENDING_POOL_ADDRESS`, `LIFELINE_JAR_ADDRESS` and
   `LIFELINE_JAR_RELEASER_ADDRESS`.
5. **Set the seller:** `NEXT_PUBLIC_ARC_NETWORK=mainnet` on the app and the seller service, then redeploy. `NEXT_PUBLIC_*`
   values are compiled in, so a rebuild is required.
6. **Test with a dollar** before anything larger.

## Money needed for a full test

| Chain | Token | Amount | For |
|---|---|---|---|
| Base | ETH | 0.004 | Gas, and swapping into test tokens |
| Base | USDC | 5 | Clearing the jar, with the threshold at $3 |
| Arc | USDC | 10 | Gas, deployment, deposit, pool, nanopayments |

About $24, of which about $1 to $2 should be spent. This is an estimate from gas prices at the time of writing.

## Not covered by the switch

- **Whitechain stays on Sepolia.** Its mainnet is separate, and the bounty asks for Sepolia.
- **Sui** has its own `SUI_NETWORK` setting.
- **Whether Arc's track accepts a deployment made outside Arc Studio** is a question for Arc's team.
