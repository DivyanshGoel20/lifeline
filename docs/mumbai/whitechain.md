# Whitechain: credit and gasless USDT payments for agents

**Status: live on Whitechain Sepolia, with real USDT payments. Testnet tokens only.**

- Credit facility: [`0xaa2d23bac7b6f9b4ca2737252f924b3f485e0686`](https://explorer.testnet.whitechain.io/address/0xaa2d23bac7b6f9b4ca2737252f924b3f485e0686), verified.
- Deployment: [`0x609288cc…6bbc`](https://explorer.testnet.whitechain.io/tx/0x609288ccb9372849563a8f0239ac3b8bb8edefe55447fa48df21bfb7f8596bbc).

- Paid in USDT by Lifeline on credit: [`0xcef96718…de4b`](https://explorer.testnet.whitechain.io/tx/0xcef967183f062644d1c46ee2798893e876844902d0f278b02da65ee1c7bcde4b)
- Drawdown recorded on the facility: [`0x0a704e5d…4512`](https://explorer.testnet.whitechain.io/tx/0x0a704e5da6108615785da4002d606d8468ccddb0aaa7d7d74730be4baf654512)
- Repaid with a signature, gas paid by the relayer: [`0xb10667cf…8514`](https://explorer.testnet.whitechain.io/tx/0xb10667cf957f5e9b65a3d08376b64522a0c00da212cc79b2a3ae96e2ff2c8514)
- An agent holding no WBT paying for itself: [`0x75e782e3…2417`](https://explorer.testnet.whitechain.io/tx/0x75e782e3fb71d41e6037e05f683aeb2dd74ae0c5373ea13249e4b9fcc9c42417)

Run it again with `npm run e2e:whitechain`.

**Bounties:** Continuity: Bring Your Product to Whitechain. Payments Nobody Notices.

## Why this needs onchain stablecoin settlement

An AI agent cannot open a card account or pass a bank's checks. USDT on Whitechain lets it pay per
request, at any hour, in amounts as small as a cent, with a merchant that can deliver as soon as the
payment lands, and with a credit history anyone can read. A card network cannot settle a $0.01
payment to a piece of software, and a bank cannot lend to one.

## Before and during the hackathon

**Before** (everything up to tag `pre-mumbai`, commit `f5df633`,
[ETHGlobal Tokyo](https://ethglobal.com/showcase/lifeline-mygz6)): credit lines for agents, on Arc and
Sui, in USDC. It relied on Circle Gateway to settle, and had nothing on Whitechain.

**Added at this hackathon, all new:**

| What | Where |
|---|---|
| An x402 facilitator for USDT, with `/verify`, `/settle` and supported networks | [`web/src/lib/whitechain/facilitator.ts`](../../web/src/lib/whitechain/facilitator.ts), `/api/whitechain/facilitator` |
| A relayer that pays gas for payers, with limits so it cannot be drained | same file |
| A merchant's pay-per-request API | [`seller.ts`](../../web/src/lib/whitechain/seller.ts), `/api/whitechain/paid/[item]` |
| Credit in USDT: buying on the human's line, repaying with a signature | [`credit.ts`](../../web/src/lib/whitechain/credit.ts), `/api/whitechain` |
| Screens for the buyer and the merchant | `/whitechain`, `/whitechain/merchant` |
| An agent tool | `lifeline_whitechain` in `mcp/server.ts` |
| Deploying the credit facility in USDT | [`contracts/script/DeployWhitechain.s.sol`](../../contracts/script/DeployWhitechain.s.sol) |

The credit facility's Solidity is from before the event, and is deployed here unchanged, in USDT.

## How it works

1. An agent asks a merchant for something. The merchant answers `402` with a price in USDT.
2. **If the agent holds enough USDT,** it signs an EIP-3009 authorisation. That is all it does.
3. **If it does not,** Lifeline's treasury signs for the whole price, and the debt goes on the human's
   line, recorded on the Whitechain facility.
4. The merchant passes the signature to Lifeline's facilitator, which checks it and submits it. The
   USDT moves, and the merchant delivers.
5. To repay, the agent signs again. The relayer submits it to the facility.

The agent never holds WBT, signs a transaction, or sees a seed phrase. The human never sees a chain.

## The three parties

- **The human** (`/whitechain`) sees a dollar line and what is owed.
- **The agent** (or `lifeline_whitechain`) buys and repays by signing.
- **The merchant** (`/whitechain/merchant`) sees payments and their receipts, and what the gas costs.

## Who pays the gas, and what stops it being drained

Lifeline's relayer pays. Its WBT is topped up by Lifeline from the faucet on testnet. On mainnet it
would be bought from what merchants and borrowers pay. A bad request costs nothing, because these
checks run before any transaction exists:

- The asset must be USDT, the network Whitechain, the scheme `exact`.
- The merchant must be registered (`WHITECHAIN_MERCHANTS`). Nobody else gets free gas.
- The payment must be between $0.001 and $5, so dust cannot burn gas.
- The signature must be valid and unexpired, with a window of at most an hour.
- The payer must hold the funds, and the authorisation must be unused and the payer unblocked.
- The transfer is simulated first, so one the token would refuse never reaches the chain.
- Daily limits: 50 settlements per payer, 200 per merchant, 500 in total.
- The relayer stops when its own balance runs low, rather than failing halfway through a payment.

All of these are set by environment variables, and covered in
[`web/test/whitechain.test.ts`](../../web/test/whitechain.test.ts).

## Setup

```bash
npm install
cp .env.example .env
```

| Variable | What |
|---|---|
| `WHITECHAIN_FACILITY_ADDRESS` | The deployed facility. The feature is off until this is set |
| `WHITECHAIN_OPERATOR_KEY` | Relayer, treasury and facility owner. Defaults to `PRIVATE_KEY` |
| `WHITECHAIN_MERCHANT_ADDRESS` | Who the demo merchant is paid |
| `WHITECHAIN_MERCHANTS` | Comma-separated merchants the relayer pays gas for |

Deploy and verify:

```bash
cd contracts
forge script script/DeployWhitechain.s.sol --rpc-url https://rpc.testnet.whitechain.io \
  --private-key $PRIVATE_KEY --broadcast --verify --verifier blockscout \
  --verifier-url https://explorer.testnet.whitechain.io/api/
```

Test without any funds, against a local copy of the chain:

```bash
npm run e2e:whitechain-fork
```

## Current limitations

- **Testnet only**, with test tokens.
- **Lifeline holds the agent's key,** encrypted, as it does on the other rails. The agent "signs" through
  Lifeline, so this is custodial.
- **The operator is one key:** relayer, treasury and facility owner are the same address. They should
  be split before real money.
- **The ledger is not a database.** Two server instances can lose an update, as on the other rails.
- **No deposits, pool or token jar here.** Those are on Arc and Base. Only the credit facility is deployed.
- **No WhiteBIT integration.** Whitechain's docs mention its exchange ecosystem, and Lifeline does not use it.
- **World ID** must be working for "one human, one line" to mean anything.
- **Real users:** none yet. It is a working testnet product.

## Before submitting

- [x] Deployed and verified (links above).
- [x] Real USDT payments, with explorer links above.
- [ ] A 2 to 4 minute video showing the human, the agent and the merchant.
