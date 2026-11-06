# Deploying Lifeline

**Now on Vercel.** The Railway setup below is kept for reference; the Railway services no
longer answer.

| project | URL | root |
|---|---|---|
| lifeline-arc | https://lifeline-arc.vercel.app | `web` |
| lifeline-premium | https://lifeline-premium.vercel.app | `premium-api` |
| lifeline-feed | https://lifeline-feed.vercel.app | `sui` |

Vercel has no lasting disk, so the app's ledgers live in Upstash Redis (`web/src/lib/storeFs.ts`).
With no Redis configured they are plain files, as they are locally. Limits of this setup:

- It is not a database. Two instances can lose an update to the same file, and the ledger lock
  is per process. Fine for a testnet deployment in light use.
- The hourly sweep is daily on Vercel's Hobby plan.
- The Sui seller's record of settled payments lasts only as long as its instance.

Deploying from the repo root (`.vercelignore` keeps `.env` out of the upload):

```bash
node scripts/bundle-sellers.mjs     # the two sellers are bundled first
VERCEL_ORG_ID=<team> VERCEL_PROJECT_ID=<project> vercel deploy --prod --yes
```

# On Railway (previous setup)

Three services from this one repo. Each has a config here (`*.railway.json`):
point a Railway service at the repo, set its config path, and the build and
start commands come from there.

| service | what | public | volume | config |
|---|---|---|---|---|
| **web** | the app, the agent APIs, the MCP server's backend | yes | `/app/web/data` | `deploy/web.railway.json` |
| **premium** | the Arc x402 seller (`/premium-data`, `/risk-curve`, ...) | yes | none | `deploy/premium.railway.json` |
| **feed** | the Sui x402 seller (`/risk?records=N`) | yes | `/app/sui/data` | `deploy/feed.railway.json` |
| **sweep** | hourly cron (`curlimages/curl`): `POST /api/standing/sweep` with `LIFELINE_CRON_SECRET`, which suspends, defaults and restores lines | no | none | set in the service: cron `0 * * * *` |

## Live

| service | URL |
|---|---|
| web | https://lifeline-arc.vercel.app |
| premium | https://lifeline-premium.vercel.app |
| feed | https://lifeline-feed.vercel.app |

## Build commands

Nixpacks installs dependencies itself (`npm ci`) before the build command
runs, so the build commands never install again: a second `npm ci` fights the
build cache over `node_modules/.cache` and fails with `EBUSY`. The web service
builds; the two sellers run TypeScript through `tsx` and have nothing to build.

## Node 22

`@mysten/sui` needs Node 22 or newer. The root `package.json` says so in
`engines`, which Nixpacks reads; if a build picks an older Node anyway, set
`NIXPACKS_NODE_VERSION=22` on the service.

## Not serverless, and one replica

The ledgers are JSON files: agents, loans, Sui debts, holds, keys (encrypted),
sessions, card bookings. They need a disk that survives a redeploy, which is
the volume at `web/data`. The feed keeps the digests it has already settled
in `sui/data`, so a payment cannot be replayed after a restart.

Keep **one replica** of each. The ledger lock, the rate limits and the
reputation queue live in the process; two web replicas would each think they
were alone.

## Order

1. **feed.** Needs `SUI_NETWORK=testnet` and `SUI_PRIVATE_KEY` (the operator,
   who is also the Sui seller). Mount the `sui/data` volume. Then
   `curl https://<feed>/risk?records=1` should answer `402`.
2. **premium.** Needs the Arc seller key, the facilitator and Intercepta
   (see `.env.production.example`). `curl https://<premium>/premium-data`
   should answer `402`.
3. **web.** Everything in the web block of `.env.production.example`, with
   `NEXT_PUBLIC_X402_RESOURCE_BASE` and `SUI_SERVICE_URL` set to the two
   sellers' public URLs, and `NEXT_PUBLIC_APP_URL` / `LIFELINE_APP_URL` to its
   own. Mount the `web/data` volume.

`NEXT_PUBLIC_*` values are compiled into the page at build time. Change one and
Railway rebuilds; that is expected.

## Outside Railway

- **World Developer Portal**: set the mini app's App URL to
  `https://<web>/mini`. For World ID for Agents, register the redirect URI
  `https://<web>/api/auth/world-agents/callback`.
- **Stripe** (test mode): optionally add a webhook to
  `https://<web>/api/repay/card/webhook` (event `payment_intent.succeeded`)
  and put its secret in `STRIPE_WEBHOOK_SECRET`. The browser's confirmation
  books repayments without it. For Apple Pay, add the web domain under
  Settings → Payment method domains.
- **Claude Code (MCP)**: point `.mcp.json`'s `LIFELINE_URL` at `https://<web>`.

## Two things that fail quietly

**`PORT`.** Railway injects it and expects the process to bind to it. The
sellers prefer their own variable first (`PREMIUM_API_PORT`, `SUI_SERVICE_PORT`),
so setting either on Railway points the process away from the proxy. Leave
them unset.

**The secrets.** `LIFELINE_SESSION_SECRET` (32+ characters) signs sessions
and mandates; unset, every restart signs everyone out. `LIFELINE_KEYSTORE_SECRET`
encrypts the agent keys on the volume; without it, no agent can be created, and
changing it later loses the keys already stored.

## Funds

The testnet wallets that pay for everything, and what to watch:

- **Arc funding wallet** (`PRIVATE_KEY`): its Circle Gateway balance pays
  sellers on credit, and it pays gas for facility writes. Top up with
  `npm run deposit -- 5`; see balances with `npm run balances`.
- **Arc seller** (`SELLER_PRIVATE_KEY`): collects in Gateway. Send it back to
  the funding wallet with `npm run withdraw:seller`.
- **Sui operator** (`SUI_PRIVATE_KEY`): sponsors gas, funds card repayments on
  Sui, and is the Sui seller. Testnet USDC from faucet.circle.com (Sui Testnet),
  SUI from the Sui faucet.

## Check it

```bash
npm run preflight -- https://<web> https://<premium> https://<feed>
```

It checks that the sellers answer `402` with the right network and that the
feed's price moves with the request, that every spending route turns away an
anonymous caller, that card repayment is on, and that cookies are `Secure`.
