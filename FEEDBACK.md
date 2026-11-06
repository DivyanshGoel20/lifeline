# Feedback for Uniswap

From building Lifeline's "repay in any token" feature on TJAR (the Token Jar and Releaser)
and Uniswap v3 on Base, at ETHGlobal Mumbai. Written from what actually happened.

## What worked

- **TJAR is the right shape for this.** A protocol that receives many tokens and wants one can
  skip running its own swaps. The Factory deploy is one call, and the jar and releaser come
  wired together.
- **The README explains its own trade-offs.** The reasoning on burn configurations and why
  `setConfig` is atomic saved real design time.
- **Forking Base with Anvil worked first time** against the real Factory, pools and QuoterV2.
  The full flow could be tested with no real money.

## What got in the way

- **No testnet deployment.** The Factory has no code on Sepolia, and the only network where we
  found it was Base mainnet. A testnet Factory would make it far easier for hackathon teams to
  try this. Forking works, but a shared testnet is what a demo needs.
- **No Arc deployment.** Uniswap v4 and the Universal Router are on Arc mainnet, but the TJAR
  Factory is not, so a jar for an Arc app has to live on another chain and bridge its proceeds.
- **Picking a route took work.** With QuoterV2 we try three fee tiers directly and nine through
  WETH, and take the best quote. We went with on-chain quoting so the fork test could run with
  no API key, and have not tried the Trading API here. A short "which do I use for what" guide
  would help.
- **Thresholds are fixed.** `threshold` is a set amount of the resource token, so a jar holding
  small repayments waits a long time, and its owner has to judge what is worth clearing. An
  example of how to pick one, by asset value and gas, would help.
