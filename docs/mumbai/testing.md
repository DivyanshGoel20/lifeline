# Testing Lifeline by hand

**Site:** https://lifeline-arc.vercel.app/arc, in a desktop browser. Do not use the World App QR.
World ID is switched off for testing, so anyone with the link gets a test account. Only testnet money moves.

## Before you start
1. Install a browser wallet such as MetaMask.
2. Connect the wallet when the app asks. It adds Arc testnet for you.
3. Get about 3 testnet USDC from https://faucet.circle.com, choosing Arc Testnet.

Transactions can be checked at https://testnet.arcscan.app.

## Test 1: sign in
Click **Continue as a test account**.
Expect Headroom $0.50, Drawn $0.00, Line $0.50.

## Test 2: authorize an agent
Click **Authorize your first agent**, name it, leave the address empty, keep the cap at 5, and click **Authorize**.
Expect a lead with the agent, its address, "Owes $0.00", and **Buy** and **Revoke**.

## Test 3: a loan
Click **x402 Purchase**, choose **Direct draw**, enter 0.05, and click **Draw**.
Expect a transaction hash, Drawn about $0.05, Headroom about $0.45, and "Agent holds $0.05" next time you open the sheet.
The sheet says "Paid, on credit" even though nothing was bought. That wording is known.

## Test 4: Nanopayments, the agent paying for itself
Click **x402 Purchase**, choose **Alpha signal** ($0.01), and click **Buy**.
Expect "Paid by the agent", "Would borrow $0.000", a settlement ID, and Drawn unchanged.
The Tape shows "paid for /premium-data". Each purchase is batched, so it has a settlement ID and no transaction of its own.

## Test 5: buying on credit
Choose **Exposure curve** ($0.20) and click **Buy**.
Expect "Paid, on credit", an artifact, and Drawn up by about $0.20. The payment also shows on the Tape.
The **On chain** panel may still show the old debt. Small purchases reach the chain in batches, and repaying forces them through.

## Test 6: repaying
Click **Repay**, choose **Your wallet**, keep the amount, click **Repay**, and confirm in the wallet.
Expect Drawn $0.00 and the full headroom back. **On chain** now agrees, and repayments in **Record** goes up by one.

## Test 7: a payment held for approval
Choose **Underwriting dossier** ($0.45) and click **Buy**. It is over the $0.40 limit.
Expect "Held. Your call." with **Decline** and **Approve and pay**.
- **Decline:** nothing is paid.
- Buy it again, then **Approve and pay:** "Paid, on credit" and Drawn about $0.46.

Repay it afterwards.

## Test 8: being refused
- **Over the line:** with $0.21 or more owed, try the $0.45 dossier. It should be refused.
- **Risky seller:** **Unvetted feed** and **Discount feed** should be refused, with the reason shown.
- **Agent cap:** authorize a second agent with a cap of 0.10 and buy Exposure curve with it. It should be held.
- **Revoking:** click **Revoke** on an agent that owes money. It should be refused.

## Test 9: the marketplace
In **Marketplace**, search for "botpay". Expect two services.
Click **Buy** on the $0.01 one, then **Buy for $0.01**.
Expect a real receipt from BotPay, such as `{"message": "Receipt ID: pi_…"}`.
This usually takes a few seconds. It took over a minute in earlier test runs, so give it time.

## Test 10: deposit-backed credit
In **Deposit-backed credit**:
1. Connect your wallet, click **Use this wallet**, and sign the message. It costs nothing.
2. Enter 1 and click **Deposit**. Approve two transactions.

Expect Deposited $1.00, Credit it adds $0.80, and Line $1.30 at the top of the page.

## Test 11: withdrawing
1. Enter 0.2 under Withdraw and click **Request withdrawal**.
   Expect "Withdrawal waiting $0.20 · 59m left", and the line drops to $1.14.
2. Click **Cancel**. The line returns to $1.30.
3. To finish a withdrawal, request again, wait an hour, and click **Withdraw**.

## Test 12: lending
In **Lending pool**, enter 0.5 and click **Deposit**. Approve two transactions.
Expect "Your deposit $0.50" and a note saying when it can be withdrawn, one day later.
The pool's totals include money from earlier test runs, so they will not start at zero.

## Test 13: the rest of the page
- **Lending limits:** new credit today should rise as you borrow.
- **Repay in any token:** shows "Not live yet", which is correct until the jar is deployed.
- **Sign out, then Continue:** the same browser returns to the same account.

## From a terminal
```bash
npm run e2e:arc       # nanopayments, loans, repayment, on the live site
npm run e2e:secured   # deposit, seizure on default, pool, real marketplace purchase
npm run e2e:jar       # Token Jar on a local copy of Base, no real money
```

## What cannot be tested today
- **$1 and $2 tiers:** these need 7 and 14 days of history.
- **Late and defaulted loans through the site:** loans last 7 days. `npm run e2e:standing` simulates this.
- **Bridge Kit:** waiting on Base Sepolia gas.
- **World ID and the mini app:** switched off and still pointing at Railway.
