# Planning record

ETHGlobal asks for spec files, prompts and planning artifacts to be included.
These are the instructions this phase was built from.

## Direction from the team

- Build on Lifeline in the Continuity track, for Arc first.
- Work in this repo, on testnet for now, with mainnet a later decision.
- Keep the interface exactly as it is.
- Use Arc Studio, and check the qualification requirements.
- Commit regularly. The team pushes.

## The plan agreed before building

1. Real services through Circle's Discovery API, replacing a demo-only catalogue.
2. Deposit-backed credit, so "what if everyone runs?" has a real answer.
3. Limits on lending and an automatic stop when defaults rise.
4. A lender side: a pool that earns what borrowers pay.
5. Repayment from other chains through Bridge Kit.
6. Seller quality scores, using the output formats published in the marketplace.

## Decisions made while building

- **Licence:** MIT, chosen because the team left it open and the contracts were
  already marked MIT.
- **Controller binding:** the operator binds a deposit's controller once, and only
  to a wallet the human has already proved is theirs. If the first depositor were
  the controller, anyone could claim a stranger's profile with a dust deposit.
- **Withdrawal delay:** drawdowns reach the chain in batches, so debt can exist
  that the facility has not seen. The delay leaves time to settle it.
- **Seizure is open to anyone:** the facility decides who is in default, and the
  money can only go to that profile's debt, so collection need not depend on
  Lifeline's servers.
- **Seller record ignores 4xx responses:** a refusal can come from Lifeline's own
  request or signature, which says nothing about the seller.
