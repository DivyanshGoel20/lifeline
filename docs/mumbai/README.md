# Lifeline at ETHGlobal Mumbai

Continuity track. Everything before tag `pre-mumbai` (commit `f5df633`) is the
project as submitted at [ETHGlobal Tokyo](https://ethglobal.com/showcase/lifeline-mygz6).
Everything after it is new. See exactly what changed with:

```bash
git diff pre-mumbai HEAD --stat
```

**Bounty:** Arc Studio Continuity Track: Bring Your Project to Arc.

## What is new

| Feature | Where | What it does |
|---|---|---|
| Real marketplace | `web/src/lib/discovery.ts`, `GET /api/x402/discover`, MCP `lifeline_discover` | Agents find Circle marketplace services that take Gateway payments on Arc testnet, and buy them on credit |
| Seller records | `web/src/lib/sellerQuality.ts` | Each purchase is scored against the format the seller published. Sellers with a poor record rank last and are not lent against |
| Lending limits | `web/src/lib/riskControls.ts`, `GET /api/risk/controls` | A cap on total lending, a daily budget, a per-seller limit, a refusal to pay yourself with credit, and an automatic stop when too many due loans are unpaid |
| Deposit-backed credit | `contracts/src/LifelineCollateralVault.sol`, `web/src/lib/securedLine.ts`, `/api/secured` | A deposit raises the line. In default, anyone can trigger the deposit paying the debt |
| Lending pool | `contracts/src/LifelineLendingPool.sol`, `GET /api/pool` | Lenders fund the credit and earn borrowers' payments, with limits enforced in the contract |
| New credit tiers | `web/src/lib/reputationEngine.ts` | Unsecured lines start at $0.50, then $1 and $2. A deposit raises them further |
| Screens for all of this | `web/src/components/arc/` | Marketplace, deposit-backed credit, lending pool, limits and cross-chain repayment on the Arc dashboard |
| Cross-chain repayment | `web/src/lib/crosschainRepay.ts`, `POST /api/repay/crosschain` | Bridge Kit moves an agent's USDC to Arc, then repays the debt with what arrived |

## Architecture

```mermaid
flowchart TB
  Agent[AI agent, via MCP or API] --> App[Lifeline web and API]
  Human[Human, World ID] --> App

  App -->|find services| Discovery[Circle Discovery API]
  App --> Risk[Lending limits and seller records]
  Risk -->|allowed| Signer[Lifeline signer]
  Signer -->|x402, batched| Gateway[Circle Gateway on Arc]
  Gateway --> Seller[Marketplace seller]
  Seller -->|delivery checked| Risk

  subgraph Arc testnet
    Facility[LifelineCreditFacility]
    Vault[LifelineCollateralVault]
    Pool[LifelineLendingPool]
    Yield[Optional ERC-4626 yield source]
  end

  App -->|drawdowns and repayments| Facility
  Human -->|deposit and withdraw| Vault
  Vault -->|reads debt and default, pays on seizure| Facility
  Vault -.-> Yield
  Lender[Lender] -->|deposit and withdraw| Pool
  App -->|draw and repay| Pool

  Other[USDC on another chain] -->|Bridge Kit, CCTP| App
```

## What runs on Arc

| Arc or Circle piece | How Lifeline uses it | Tested live |
|---|---|---|
| Nanopayments (Circle Gateway, x402 batching) | Every agent purchase, from its own balance or on credit | Yes, settlement IDs returned |
| Discovery API | The marketplace: 134 services that accept Arc testnet | Yes, including a purchase from a real seller |
| USDC as gas | All contracts and wallets | Yes |
| Bridge Kit (CCTP) | Repaying Arc debt from other chains | No: needs USDC on another testnet |
| Earn (ERC-4626 Morpho vault) | Optional yield on deposits | See below |
| Arc Studio | Contracts, tests, screens, deployment | Yes |

## Deliberate limits

- **Testnet only.** Nothing here has been used with real money.
- **The operator is trusted** to repay the pool and report losses honestly. The
  pool's limits bound what that trust can cost, and do not remove it.
- **The pool is not yet the source of credit.** Lenders can deposit, and the operator can
  draw and repay, but drawdowns are still funded by Lifeline's operator, not drawn from
  the pool automatically.
- **Pool interest** goes to whoever is in the pool when it is repaid. The one-day lockup
  delays timing that, and does not remove it.
- **Marketplace on testnet:** 134 listings take Arc testnet payments, mostly
  Quicknode RPC access, and most of those want wallet sign-in as well.
- **No paid audit.** The contracts were reviewed in Arc Studio and tested, not audited.

## Arc Studio

The new contracts and screens were built in Arc Studio and deployed from it. See
[arc-studio.md](arc-studio.md) for the project link, the addresses, how they were
checked, and what is still needed before submitting.

## How AI was used

Claude Code and Arc Studio's agent wrote the code in this phase under the direction of
the team, who chose the features, set the constraints, and reviewed the results. Planning
decisions and prompts are recorded in [prompts.md](prompts.md).

## Run it

```bash
npm install
cp .env.example .env     # the keys are listed there
npm run dev              # http://localhost:3000
npm run test:contracts
npm --workspace=web run test
```

The deployed addresses are in `.env.example`. To test the new features live:

```bash
npm run e2e:secured
```
