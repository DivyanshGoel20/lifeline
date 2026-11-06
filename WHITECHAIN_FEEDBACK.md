# Feedback for Whitechain

From adding USDT credit and an x402 facilitator to Lifeline at ETHGlobal Mumbai.

## What worked

- **Plain EVM.** Lifeline's credit facility and Foundry tooling needed no changes to compile
  and deploy. Forking Whitechain Sepolia with Anvil worked, so the whole flow could run against
  the real USDT contract before spending anything.
- **USDT has EIP-3009.** `transferWithAuthorization` is what makes a payer with no WBT possible,
  and the token's source is verified on the explorer, which made it quick to confirm.
- **`llms-full.txt`.** Having the docs in one file made it fast to look things up.

## Where we got stuck

- **Two USDTs.** The bounty requires `0xcedf…55a7`, but the docs' token list only names
  `0xaa79…8f46`, which reports itself as `USDT.e`. `0xcedf…` does not appear in the docs we
  searched. A builder following the docs alone would use the wrong token.
- **No documented way to get test USDT.** The faucet page covers WBT only.
  We could see the token's top holder sending 100 USDT to many addresses, but could not find how
  to ask for it.
- **The token's EIP-712 domain is undocumented.** `eip712Domain()` reverts and `version()` is
  absent, so we worked out `name: "Tether USD", version: "1"` by computing candidates against
  `DOMAIN_SEPARATOR`. A one-line note would save this.
- **The faucet needs a person.** It requires a GitHub login, so an agent building or testing
  cannot claim WBT for itself, even though the docs have an agent skill for it.
- **Ankr's endpoint.** Connecting to `whitechain-testnet.rpc.ankr.com` from our tooling failed
  with a certificate error. We used `rpc.testnet.whitechain.io` instead.

## What was missing

A reference x402 facilitator for USDT on Whitechain would help the most: the Scale bounty asks for
one, and nothing on the chain can be reused today, so every team writes its own.
