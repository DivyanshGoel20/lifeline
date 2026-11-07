# Testing Lifeline by hand

**Site:** https://lifeline-arc.vercel.app/arc. Everything here runs on testnets, so no real money moves.

## Before you start
- World App on your phone, with World ID.
- A browser wallet such as MetaMask. The app adds Arc testnet for you when you connect.
- About 3 USDC on Arc testnet from https://faucet.circle.com.
- For Test 9 only: USDC and a little ETH on Base Sepolia.

Check transactions at https://testnet.arcscan.app, https://sepolia.basescan.org and
https://explorer.testnet.whitechain.io.

## Sign in
1. **Join with World ID:** click **Join with World ID**, scan the QR with your phone, and approve. Expect the dashboard with Line $0.50.
2. **Coming back:** sign out, then sign in again. The same account should return, without a new uniqueness proof.

## Credit and Nanopayments
3. **Add an agent:** **Authorize your first agent**, enter a name, leave the address empty, click **Authorize**.
4. **Take a loan:** **x402 Purchase**, **Direct draw**, 0.05, **Draw**. Expect a transaction hash and Drawn about $0.05. The sheet says "Paid, on credit" even though nothing was bought.
5. **Nanopayment:** **x402 Purchase**, **Alpha signal**, **Buy**. Expect "Paid by the agent", a settlement ID, and Drawn unchanged. Payments are batched, so there is no transaction per payment.
6. **Buy on credit:** **Exposure curve**, **Buy**. Expect "Paid, on credit" and Drawn up about $0.20. **On chain** can lag, because small purchases reach the chain in batches.
7. **Repay:** **Repay**, **Your wallet**, **Repay**, confirm in the wallet. Expect Drawn $0.00, and **On chain** now agrees.

## Held payments and refusals
8. **Held payment:** buy **Underwriting dossier** ($0.45). Expect "Held. Your call." Try **Decline**, then buy it again and **Approve and pay**. The first approval asks you to link World ID for Agents once, and needs an Orb-verified World ID. Repay afterwards.
9. **Refusals:** each should fail or wait, with a reason:
   - With $0.21 or more owed, the $0.45 dossier.
   - **Unvetted feed** and **Discount feed**.
   - A second agent with a cap of 0.10, buying Exposure curve.
   - **Revoke** on an agent that owes money.

## The new Arc features
10. **Marketplace:** search "botpay", **Buy** the $0.01 one, **Buy for $0.01**. Expect a real receipt, `Receipt ID: pi_…`.
11. **Deposit:** in **Deposit-backed credit**, connect, **Use this wallet**, sign, enter 1, **Deposit**, approve two transactions. Expect Line $1.30 at the top.
12. **Withdraw:** enter 0.2, **Request withdrawal**. Expect 59 minutes left and Line $1.14. **Cancel** returns it to $1.30.
13. **Lend:** in **Lending pool**, enter 0.5, **Deposit**, approve two transactions. Expect "Your deposit $0.50" and an unlock time a day later. The pool's totals include earlier tests.
14. **Bridge Kit:** owe something first. Copy the agent's address from its lead and send it 1 USDC and 0.005 ETH on Base Sepolia, plus 0.1 USDC on Arc for gas. In **Repay from another chain**, choose Base Sepolia, enter 0.25, and submit. Expect it to finish in under a minute, with the debt down. Any excess stays in the agent's wallet.

## Whitechain
**Needs test USDT in the operator wallet** `0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3`. Until then, buying fails with `insufficient_funds`.

15. **Buy on credit:** at `/whitechain`, **Add an agent** if you have none, then **Buy for $0.20**. Expect "Paid on credit" and a receipt link. The agent holds no WBT at all.
16. **Earn and repay:** **A customer pays it $0.50**, then **Repay**. Expect nothing owed.
17. **Pay for itself:** **Buy for $0.01**. Expect "Paid by the agent".
18. **Merchant:** at `/whitechain/merchant`, expect those payments with links, and what the gas cost.

## Last checks
19. **Lending limits:** new credit today rises as you borrow.
20. **Repay in any token:** shows "Not live yet", which is correct.
21. **Sui:** `/sui` opens with its own $0.50 line.
22. **Mini app:** open in World App and sign in. Expect the same account.

## From a terminal
```bash
npm run e2e:arc              # nanopayments, loans, repayment, on the live site
npm run e2e:secured          # deposit, seizure on default, pool, real marketplace purchase
npm run e2e:jar              # Token Jar on a local copy of Base, no real money
npm run e2e:whitechain-fork  # Whitechain on a local copy, with the real USDT
npm run e2e:standing         # late and defaulted loans
```

## What cannot be tested by hand today
- **$1 and $2 tiers:** these need 7 and 14 days of history.
- **Late loans and defaults:** loans last 7 days. Use `e2e:standing` and `e2e:secured`.
- **Finishing a withdrawal:** the vault waits an hour and the pool a day.
- **The Token Jar on a live network:** Uniswap's factory is not on any testnet we checked. Use `e2e:jar`.
