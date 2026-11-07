# Arc Studio

The track requires: built in Arc Studio, a shareable project URL, and Studio shown
in the demo.

**Project:** https://studio.arc.io/app/db053ebe-5c54-478f-a695-2ea57b95a171

**Share link:** https://studio.arc.io/share/arc-lifeline-credit-contract-builder-9dk7348o2w

## What the Studio project is

The Studio project runs Lifeline's real interface. `scripts/sync-studio.mjs` copies the product's own
page and component files into it, unchanged. Next.js pieces are replaced by small shims in `studio/`, because
Studio's app is Vite. Its `/api` calls go to the same backend, at https://lifeline-arc.vercel.app.

So the interface is the same product in both places, but not all of it was written in Studio:

- **Built in Studio:** the vault and pool contracts, their tests and review, and their deployment.
- **Built outside and brought in:** most of the interface and everything from before the event.
- **Not in Studio:** the backend, which runs on Vercel, because Studio's app has no server.

## What was built there

| Studio turn | Prompt | Result |
|---|---|---|
| Contracts and audit | [01-contracts.md](studio/01-contracts.md) | `LifelineCollateralVault`, `LifelineLendingPool`, tests, and the fixes the review led to |
| Lockup and funding | [03-deploy.md](studio/03-deploy.md) | Lender lockup, 229 tests in Studio |
| Screens | [02-ui.md](studio/02-ui.md) | Marketplace, deposit-backed credit, lending pool, limits and cross-chain repay, in Lifeline's design |
| Deployment | [04-deploy.md](studio/04-deploy.md) | Everything in [deployments.arc-testnet.json](../../contracts/deployments.arc-testnet.json) |

The screens live in `web/src/components/arc/`, copied from Studio's `src/lifeline/`.
`BuySheet.tsx` and the wiring into the dashboard were added outside Studio, to
connect them to the existing app. The contracts in `contracts/src/` and the tests
in `contracts/test/` also come from Studio, with import paths adjusted to this repo.

## Deployed on Arc testnet

| Contract | Address | Owner |
|---|---|---|
| LifelineCollateralVault | `0x59B00E85d191bCC376f2593c937E260722bd10Fb` | `0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3` |
| LifelineLendingPool | `0x70cF07af1Cd055ceCeE3A2efDc7d623D23EDA02A` | `0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3` |
| LifelineCreditFacility (from Tokyo, unchanged) | `0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f` | `0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3` |

Ownership moved from Studio's deployer to Lifeline's operator, so the backend can
write to both contracts.

The vault's deposits earn through Arc testnet's Earn vault
`0x8f2d33b5d4b9b5f02df635ae308f7b4c9da8d2dc`, set by the owner in
`0x9c7dd2d37840cab0e3ba00b36ba55158b0088e57bde9c01aa20dfae6adf01918`. This step was done
outside Studio. `setYieldVault(address(0))` moves everything back to plain USDC.

## How the deployment was checked

Studio's report was not taken on trust. Separately from Studio:

- Every transaction in the deployment record was read from Arc: 39 succeeded and 3
  reverted, the 3 being the deliberate refusals the test expects.
- `owner()` and every parameter were read back from the chain.
- The deployed bytecode of both contracts was compared with a compile of this
  repo's source. They match, leaving aside constructor-set values and metadata.
- `forge test` passes here, and `npm run e2e:secured` runs the whole path against
  the deployed contracts.

## Found by the review

- **A borrower could dodge seizure.** The Tokyo facility lets a profile's owner call
  `suspendOwnProfile`, which overwrites `Defaulted`. It cannot be changed in place,
  so the vault now keeps its own record of a default (`latchDefault`).
- **Yield sources with fees could shift cost to other depositors.** The vault now
  refuses sources that charge on the way in or out.
- **A lender could join just before a repayment and leave after it,** taking a share
  of interest earned before they arrived. Lenders are now locked in for a day. This
  delays the trick and does not remove it: interest is still shared by whoever is in
  the pool when it is repaid.

## Before submitting

- Submit the share link above as the shareable URL. The `/app/` link redirects to Studio's home page when logged out.
- `arc-studio deployments` lists nothing, because the contracts were deployed by a script
  in the sandbox rather than through Studio's deploy workflow. The deployment record and
  explorer links above are the evidence. Ask Arc's team whether that is enough.
- Show Studio in the demo video.
