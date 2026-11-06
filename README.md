# Lifeline

> Credit lines for AI agents, backed by one World ID-verified human - a line on
> Arc and a separate one on Sui.

An agent can hold money. Only a human can hold debt.

A human verifies once with World ID and gets a USDC credit line on each rail.
Their agents spend on it: when an agent hits an x402 paywall it cannot afford,
Lifeline pays the seller and the debt goes to the human. Every payment is
screened by Intercepta first; anything risky, or past the agent's spending
cap, waits for the human to approve it with World ID. Humans who do not repay
are suspended, then defaulted, on chain - and other World apps can ask
Lifeline whether someone repays.

**Live:** [lifeline-arc.vercel.app](https://lifeline-arc.vercel.app)
· also a World mini app, and a Claude Code MCP server.

**At ETHGlobal Mumbai (Continuity track):** real marketplace services, deposit-backed
credit, lending limits and more. What is new and how to run it:
[`docs/mumbai`](docs/mumbai/README.md).

## Architecture

```
                     World ID  ─── one human, a line on each rail
                         │
            ┌────────────┴─────────────┐
            ▼                          ▼
  ┌───────────────────┐      ┌──────────────────────────┐
  │ Arc testnet       │      │ Sui                      │
  │ LifelineCredit-   │      │ lifeline::facility       │
  │ Facility.sol      │      │ lifeline::obligation     │
  │                   │      │                          │
  │ x402 via Circle   │      │ x402 exact scheme,       │
  │ Gateway batching  │      │ gas sponsored by Lifeline│
  │                   │      │ repayment parked first,  │
  │                   │      │ collected by anyone      │
  └─────────┬─────────┘      └────────────┬─────────────┘
     own limit, debt, record    own limit, debt, record
```

The rails are separate lines: own limit, debt, repayment record and agents.
Both start at $0.50 and grow to $1 and then $2 as the human repays. A deposit raises the line further.

## How it works

1. **Join.** World ID proof of human, once → one credit line per person.
2. **Pay.** An agent gets a `402`. Enough balance, it pays itself. Short,
   Lifeline pays and books the loan on that rail's line.
3. **Screen.** Before anything is signed, Intercepta checks the payee, the
   token and the signed authorization (Arc). Over the agent's cap, a held
   payment needs the human's fresh World ID approval (both rails).
4. **Repay.** From the agent's wallet, a connected wallet, or Apple Pay /
   Google Pay / card via Stripe - on both rails.
5. **Don't repay.** Past due → suspended on chain; 30 days later → marked
   defaulted on chain, record reset to the first tier. Repaying restores the line.
6. **Registry.** Partner World apps ask `GET /api/registry/standing?sub=` and
   get good / delinquent / defaulted - never amounts. The human sees every lookup.

Also: a World mini app (`/mini`), and Claude Code tools ([`mcp/server.ts`](mcp/server.ts)) -
the agent asks for access with a link and terminal QR code, the human approves,
and it buys on its own under a mandate bound to one wallet.

---

## World

### IDKit - who gets a credit line

- **The event that needs trust:** opening a credit line. Lending without
  collateral only works if one person cannot open many lines and walk away from
  each.
- **Credential:** `proofOfHuman()` - World ID 4 proof of human (legacy Orb fallback),
  verified on the server with World's v4 API
  ([`lib/world.ts`](web/src/lib/world.ts),
  [`api/auth/world-verify`](web/src/app/api/auth/world-verify/route.ts),
  widget in [`WorldAuthGate.tsx`](web/src/components/WorldAuthGate.tsx)).
- **Why it is the minimum:** we need exactly one thing - that this person has
  no other line. Proof of human gives uniqueness without revealing who they
  are. A device or selfie check is weaker against one person joining twice; a
  passport would reveal more than we need and exclude people without one.
- **Returning users** prove a World ID *session* instead
  ([`api/auth/world-session`](web/src/app/api/auth/world-session/route.ts)),
  each proof accepted once; in World App, MiniKit wallet sign-in
  ([`mini/MiniGate.tsx`](web/src/components/mini/MiniGate.tsx)).
- **Success:** new human → proof verified → session cookie → line opened.
- **Alternative paths:** already joined (uniqueness spent) → told so and sent
  to sign in from World App; widget closed → nothing happens, try again;
  proof rejected by World → error shown, no account; session proof replayed →
  refused.

**IDKit debrief**

- *Time to first success:* the first verified proof came quickly once the RP
  signing context was served from our backend; most of the time went on what
  happens *after* the first proof.
- *Friction:* a uniqueness proof works once per person per action, and the
  portal has no setting to raise it - so a returning user could not sign in
  again. We had to redesign around World ID sessions.
- *Missing docs:* how to combine a one-time uniqueness proof with sessions for
  sign-in, and what each IDKit error code means (they arrive only as
  `onError` codes plus a console debug report).
- *Biggest improvement:* a documented "join once, sign in with a session"
  recipe, with the already-verified case returned as a clear, typed result.

### World ID for Agents - a human's fresh yes before an agent's money moves

When a payment is held (Intercepta flagged it, or it is over the agent's cap),
the agent cannot approve it and neither can a session cookie. Lifeline starts
World's device flow; the human approves in World ID; Lifeline validates the ID
token (RS256, issuer, audience, Orb `acr`, fresh `auth_time`, and the `sub`
linked to this account) and only then releases the payment.

- Code: [`lib/worldAgents.ts`](web/src/lib/worldAgents.ts),
  [`api/pay/holds/[holdId]/approval`](web/src/app/api/pay/holds/[holdId]/approval/route.ts),
  [`WorldAgentApproval.tsx`](web/src/components/WorldAgentApproval.tsx).
- Alternative paths: declined → hold declined; expired, stale, or a different
  World ID → stays held. Nothing is paid in any of them.
- The same `sub` powers the **registry**: Lifeline publishes
  `/.well-known/lifeline-sector.json` listing partner callbacks, so partners get
  Lifeline's identifier for a human ([`lib/registry.ts`](web/src/lib/registry.ts)).

**Debrief:** the device endpoint worked on the first call; the first full
approval took ~15 minutes more, because the sandbox gives each browser its own
fake identity (we linked in one browser and approved in another, and Lifeline
correctly refused a different `sub`). The guides live behind the MCP endpoint
rather than `/docs`. Biggest improvement: let the approval screen show *what*
is approved ("$5 to this seller"), not just "sign in".

---

## Sui

Money moves programmatically on Sui, with the rules in Move
([`sui/lifeline/sources`](sui/lifeline/sources)):

- **A repayment parked before the spending.** The agent signs a dated claim on
  its own `Purse` ([`obligation::park`](sui/lifeline/sources/obligation.move)),
  then one sponsored transaction draws credit, adds the agent's own coins and
  pays the x402 seller ([`sui/src/payer.ts`](sui/src/payer.ts)). All or nothing.
- **Collection without a keeper.** Once due, *anyone* can call
  `obligation::collect`: the purse repays the facility, or the default is
  recorded on chain. `settle` repays early or cures a default.
- **Money moves where the debt is booked.** `obligation::draw` takes coins out
  of the facility in the call that records the debt.
- **x402 on Sui.** The seller simulates the agent's transaction, checks it pays
  the quoted amount in USDC, submits it, and blocks replays
  ([`sui/src/x402.ts`](sui/src/x402.ts), [`sui/service/server.ts`](sui/service/server.ts)).
- **Agents need no gas** - Lifeline sponsors every transaction; it lends
  Circle's testnet USDC.
- **Automation:** held over-cap payments, card repayments that fund the purse
  and settle, and defaults that freeze the profile on chain
  ([`web/src/lib/suiRail.ts`](web/src/lib/suiRail.ts), [`lib/standing.ts`](web/src/lib/standing.ts)).

---

## Intercepta

**Where the API is called** - live, before a payment is signed or accepted:

| check | endpoint | file |
|---|---|---|
| payee, before signing | `GET /api/public/v2/extension/account/{addr}/toxic-score` | [`lib/intercepta.ts`](web/src/lib/intercepta.ts) `screenOutgoing` |
| the asset (fake USDC?) | `GET .../token-intelligence/token/{addr}/risks` | same |
| the exact EIP-712 authorization about to be signed | `POST /api/public/v2/extension/analysis/signature` | same |
| the payer, before a seller accepts | `GET .../account/{addr}/quick-scan` | [`lib/x402Gateway.ts`](web/src/lib/x402Gateway.ts), [`premium-api/server.ts`](premium-api/server.ts) |
| report a malicious address | `POST .../reports/address` | [`api/risk/report`](web/src/app/api/risk/report/route.ts) |

The authorization is built, screened and signed in one place -
[`lifelineSigner.ts` `screenAndSign`](web/src/lib/lifelineSigner.ts) - and the
verdict decides what happens: **pay** (clean, up to $2), **cap** (warning
signs, up to $0.25), **hold** (over the cap, or no answer - the human decides),
**refuse** (scammer, sanctions, fake token, drainer). No answer is never a pass.
Payments run on Arc testnet; addresses are screened against mainnet data.

**Demo:** buy the *Alpha signal* → paid. Buy the *Unvetted feed* (payee is a
known scammer from Intercepta's test list, score 100) or the *Discount feed*
(pays in a fake USDC) → refused before signing, reason shown on the receipt.
A $0.45 purchase → held for the human. Live: `npm run e2e:intercepta`.

**Feedback**

- Time to first call: minutes - one header; first cold call ~5s, then 0.4-1.3s.
- Confusing: Scan Message documents the EIP-712 data as a JSON *string*; sent
  that way it silently returns `Low`. Sent as an *object* it flags the payee
  `KNOWN_MALICIOUS`. `chainId` must also be a string.
- Undocumented: the scale of `toxicScore` and trait `risk` (looks like 0-100).
- Missing: Arc's chain id (we screen on mainnet data), and a batch address scan
  for sellers screening many payers.

---

## Run it

```bash
npm install
cp .env.example .env          # World, Arc, Sui, Intercepta, Stripe keys
npm run dev                   # app on :3000
npm run premium               # Arc x402 seller on :4402
npm run sui:service           # Sui x402 seller on :4031
```

Arc: `npm run deploy:arc`, then `npm run deposit` to fund Circle Gateway. Sui:
`SUI_NETWORK=testnet npm run sui:deploy`, then `npm run sui:open-usdc` (Circle
testnet USDC from [faucet.circle.com](https://faucet.circle.com)). Deploying:
[`deploy/README.md`](deploy/README.md).

```text
contracts/      Arc credit facility (Foundry)
sui/lifeline/   Move package: facility, obligation
sui/src/        Sui client, x402 on Sui, payer
sui/service/    Sui x402 seller
web/            Next.js app, World ID, agent APIs, both rails
mcp/            Claude Code MCP server
premium-api/    Arc x402 seller
deploy/         Railway configs and preflight
```

## Tests

```bash
npm test                      # Foundry (23), Move (58), web (110), Sui library (8)
npm run e2e:arc               # Arc rail, live on testnet
npm run e2e:sui               # Sui rail, live
npm run e2e:intercepta        # screening, live: paid, refused, held
npm run e2e:world-agents      # held payment approved / --deny in World ID for Agents
npm run e2e:card              # Stripe repayments on both rails
npm run e2e:standing          # suspended, defaulted, restored - on chain
npm run e2e:mcp               # Claude Code tools end to end
```

## Deployed

| | |
|---|---|
| Arc `LifelineCreditFacility` | [`0xd25Fd339…818f`](https://testnet.arcscan.app/address/0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f) |
| Sui testnet package | [`0x14e7136b…`](https://suiscan.xyz/testnet/object/0x14e7136be665fbf7b839cde7fbb7ef2d3d46fafe35aac957aa01dbc707188e91) |
| Sui `Facility<USDC>` | [`0x24d4736a…`](https://suiscan.xyz/testnet/object/0x24d4736a368e7c1e3ef1acddaa9560252e0c0ea5a08e90ab8c45bcf9481bb73e) |
| On-chain collection by a stranger / a recorded default | [`8221agWL…`](https://suiscan.xyz/testnet/tx/8221agWL1vqYysTnWXLUqdHpbYAmRcChpprq5LyZtrL4) / [`Gy9Apwq5…`](https://suiscan.xyz/testnet/tx/Gy9Apwq5Qf7s9giAGNfirnoHTpGFo9VoWZR5owhAwgMt) |
| App / Arc seller / Sui seller | [web](https://lifeline-arc.vercel.app) · [premium](https://lifeline-premium.vercel.app) · [feed](https://lifeline-feed.vercel.app) |

## ETHGlobal Mumbai

What is new since Tokyo, and how it was built: [docs/mumbai](docs/mumbai/README.md).
Uniswap integration, with links to the code: [docs/mumbai/uniswap.md](docs/mumbai/uniswap.md).
Feedback for Uniswap: [FEEDBACK.md](FEEDBACK.md).

### Whitechain

Credit and gasless USDT payments for AI agents: [docs/mumbai/whitechain.md](docs/mumbai/whitechain.md).

An AI agent cannot open a card account or pass a bank's checks. USDT on Whitechain lets it pay per request, at any hour, in amounts as small as a cent, and a card network could not settle a $0.01 payment to a piece of software.

Going to mainnet: [docs/mumbai/mainnet.md](docs/mumbai/mainnet.md).
