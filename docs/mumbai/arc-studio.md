# Arc Studio

The track requires: built in Arc Studio, a shareable project URL, and Studio shown
in the demo.

## Status

**Not done yet.** The contracts so far were written outside Studio, because
signing in needs a person at a browser. Everything below still has to happen
before this can be submitted to the Arc track.

## Steps

1. Sign in once, in a normal terminal:

   ```bash
   arc-studio login --paste
   arc-studio whoami
   ```

2. Bring the contracts in, round-trip, so Studio's changes come back as diffs:

   ```bash
   arc-studio run \
     --file contracts/src/LifelineCollateralVault.sol:contracts/LifelineCollateralVault.sol \
     --file contracts/src/LifelineLendingPool.sol:contracts/LifelineLendingPool.sol \
     --file contracts/test/LifelineCollateralVault.t.sol:contracts/test/ \
     --file contracts/test/LifelineLendingPool.t.sol:contracts/test/ \
     "Audit these contracts for Arc, fix what you find, test them, and deploy both to Arc testnet"
   ```

3. Check what it did and bring changes back:

   ```bash
   arc-studio deployments
   arc-studio pull --changed --out ./studio-out --dry-run
   ```

4. Get the workspace URL for the submission:

   ```bash
   arc-studio open
   ```

   The docs do not say whether others can open that URL. Check it in a private
   window before submitting.

## Ownership after a Studio deploy

The vault's owner binds wallets to profiles, and the pool's owner draws funds.
If Studio deploys with its own wallet, ownership has to move to Lifeline's
operator with `transferOwnership`, or the backend cannot write to them.
