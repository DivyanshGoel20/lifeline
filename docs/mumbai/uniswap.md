# Uniswap: repay in any token

**Status: the Token Jar is deployed on Base mainnet, through Uniswap's real TJAR factory. It is not switched on in
the app, and no tokens have gone through it. The full flow is tested on a local fork of Base.**

| Contract | Address |
|---|---|
| Lifeline Token Jar | [`0x9282BCCAda9C009CCC4c80e52a0A02b342fc0e8B`](https://basescan.org/address/0x9282BCCAda9C009CCC4c80e52a0A02b342fc0e8B) |
| ExchangeReleaser | [`0xa64688229151023Ca2b2f9B3eFe9FB9f2899A2Bc`](https://basescan.org/address/0xa64688229151023Ca2b2f9B3eFe9FB9f2899A2Bc) |
| Deployment | [`0x239c4aaf…598d`](https://basescan.org/tx/0x239c4aaf7868941a9f14f2ddddbc199c9d480b0016236e341a0b0872e1b9598d) |

Read back from the chain: clearing costs 5 USDC, which goes to `0x5233…32B3`, also the owner of both.

**Why it is off:** credit is still on Arc testnet, and tokens sent to a jar cannot come back. An agent would pay real
tokens to clear a testnet debt, and the USDC could not bridge from Base mainnet to Arc testnet.

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

## The Uniswap API

Two more features use the [Uniswap API](https://developers.uniswap.org). The key stays on the server.

**Swap or borrow** ([`web/src/lib/swapOrBorrow.ts`](../../web/src/lib/swapOrBorrow.ts)). When an agent is
short of USDC, before any loan is recorded, the API prices swapping what it holds. The swap's cost is
price impact, pool fees, gas and bridging. Borrowing's is the 1% fee, expected interest, and a charge for
tying up the line, which is a judgement set by `LIFELINE_LINE_COST_RATE`. The cheaper one wins, and the receipt
says why. If Uniswap fails or takes over 3.5 seconds, Lifeline borrows, as it always did.

Priced on Base with real quotes:

| Purchase | Borrowing costs | Swapping costs | Choice |
|---|---|---|---|
| $0.20 | $0.0027 | $0.0281 | Borrow |
| $1 | $0.0216 | $0.0286 | Borrow |
| $5 | $0.1080 | $0.0290 | Swap, saves $0.08 |
| $25 | $0.5400 | $0.0354 | Swap, saves $0.50 |

On testnet Sepolia's gas is priced as if real, so borrowing nearly always wins unless the line is full.

**Repay in any token** ([`web/src/lib/tokenRepay.ts`](../../web/src/lib/tokenRepay.ts), `/api/uniswap/repay`). The Repay
sheet offers it beside wallet and card. Uniswap swaps to USDC, Bridge Kit moves it to Arc, and it is booked
through the same check as any wallet repayment.

Swaps run on Base on mainnet and on Sepolia on testnet. The API does not route on Base Sepolia.

**Tested:** `npm run e2e:uniswap` runs the API's real quotes and swap transaction on a local copy of Sepolia.
**Not tested:** a swap on a live network, the bridge straight after a swap, and the Repay sheet's token
option with a real wallet.

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
3. **The jar is already deployed** (above). Only the keeper funding and these settings remain.
4. **Set** `LIFELINE_JAR_ADDRESS`, `LIFELINE_JAR_RELEASER_ADDRESS`, `BASE_RPC_URL` and
   `LIFELINE_JAR_KEEPER_KEY`. The feature stays off until the two addresses are set.
5. **Test with a dollar** before anything larger. Agents also need ETH on Base for gas.

## Not tested

- Tokens through the deployed jar, or clearing it, on real mainnet. Only its deployment and settings are confirmed.
- `bridgeProceedsToArc`: a bridge cannot leave a fork.
- The route booking on a live Arc facility with a real token. The fork test stands in for that one step,
  which uses the same booking path as a card repayment.
- The screen with the jar turned on: until deployment it shows "Not live yet".
