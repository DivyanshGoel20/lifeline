# Uniswap: repay in any token

**Status: built, and tested on a local fork of Base. Not deployed. Nothing on mainnet yet.**

## The problem and the idea

Agents earn in whatever their customers pay, but their debt is in USDC. Lifeline does not want
to run swaps, hold volatile tokens, or trust its own prices. So:

1. An agent sends WETH, UNI or cbBTC to the **Lifeline Token Jar** on Base.
2. Uniswap prices it. The debt falls by that price less a 3% margin.
3. Once the jar is worth more than the Releaser's threshold, anyone can pay that threshold in USDC
   and take everything in it. The USDC comes to Lifeline.
4. Bridge Kit moves it to Arc, replacing what Lifeline advanced.

## Where the Uniswap integration is

| What | Where |
|---|---|
| Deploying through the TJAR Factory (`0xfAc7…9fee`) | [`contracts/script/DeployLifelineJar.s.sol`](../../contracts/script/DeployLifelineJar.s.sol) |
| Pricing on QuoterV2, across fee tiers and through WETH | `quoteToUsdc` in [`web/src/lib/lifelineJar.ts`](../../web/src/lib/lifelineJar.ts) |
| Sending to the jar and booking the repayment | `repayWithToken`, same file |
| Clearing with `ExchangeReleaser.release`, then swapping on SwapRouter02 | `clearJar`, same file |
| API | `GET` and `POST /api/jar`, `POST /api/jar/clear` |
| Screen | [`web/src/components/arc/RepayAnyToken.tsx`](../../web/src/components/arc/RepayAnyToken.tsx) |
| Agent tool | `lifeline_repay` with `token` and `tokenAmount`, in `mcp/server.ts` |
| Test on a fork of Base | [`web/test/e2e/jar.fork.e2e.ts`](../../web/test/e2e/jar.fork.e2e.ts): `npm run e2e:jar` |

## Who carries what risk

Lifeline advances the repayment, so lenders are paid at once. Until the jar clears, **Lifeline
carries the risk that the token falls**. What limits that:

- A 3% margin (`LIFELINE_JAR_HAIRCUT_BPS`).
- Only three deep tokens are accepted, because a thin token could be priced up to pay a debt with nothing.
- $5 per repayment (`LIFELINE_JAR_MAX_PER_REPAYMENT_USD`).
- Tokens cannot come back from a jar, so sending more than is owed is refused before anything moves.

**Not protected:** the quote is the pool's price at that moment. Manipulating a deep pool for one
transaction is expensive, and the limit above caps the gain, but this is not an oracle.

## Going to mainnet

Nothing here has been run on mainnet. The steps are:

1. **Decide where Lifeline runs.** Base mainnet's USDC can only bridge to **Arc mainnet**. With the
   jar on Base mainnet and credit on Arc testnet, repayments would book but `bridgeProceedsToArc`
   has nowhere to send real money. A complete run needs the facility, vault and pool on Arc mainnet too.
2. **Fund a keeper** on Base with ETH for gas and USDC for the threshold.
3. **Simulate, then deploy.** Without `--broadcast` this cannot spend anything:
   ```bash
   cd contracts
   LIFELINE_JAR_RECIPIENT=<wallet> LIFELINE_JAR_OWNER=<owner> \
     forge script script/DeployLifelineJar.s.sol --rpc-url https://mainnet.base.org
   ```
4. **Set** `LIFELINE_JAR_ADDRESS`, `LIFELINE_JAR_RELEASER_ADDRESS`, `BASE_RPC_URL` and
   `LIFELINE_JAR_KEEPER_KEY`. The feature stays off until the two addresses are set.
5. **Test with a dollar** before anything larger. Agents also need ETH on Base for gas.

## Not tested

- Anything on real mainnet.
- `bridgeProceedsToArc`: a bridge cannot leave a fork.
- The route booking on a live Arc facility with a real token. The fork test stands in for that one step,
  which uses the same booking path as a card repayment.
- The screen with the jar turned on: until deployment it shows "Not live yet".
