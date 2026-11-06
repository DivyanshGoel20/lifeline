Continue from where you stopped. Do these in order and keep each step short.

1. Compile and run all contract tests, including FullExit and the entry-fee mock. Fix what fails.

2. One change to `LifelineLendingPool`: stop the interest sandwich with a lockup. Add `uint256 public lockup` with `setLockup(uint256)` (owner, capped at 7 days), default 1 day set in the constructor, and a per-lender `lockedUntil` set on each deposit. `withdraw` reverts inside the lockup. Keep all existing names and constructor arguments. Add tests.

3. Fund the deployer. Use this project's own faucet workflow or tooling if there is one. If your tooling cannot fund it, stop here and tell me exactly which address needs how much testnet USDC, and I will fund it. Do not spend the turn hunting.

4. Deploy to Arc testnet (5042002):
   a. A test copy of LifelineCreditFacility and a vault wired to it. Run for real onchain: create profile, authorize agent, bind controller, deposit, record a drawdown, an over-limit withdrawal that reverts, default, then seize from a different address. Also: suspendOwnProfile after a default, latchDefault beforehand, seize still works.
   b. Production vault: facility 0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f, ltvBps 8000, withdrawDelay 3600.
   c. Production pool: maxUtilizationBps 8000, exposureCap 100000000. Exercise it on a separate test pool with lockup 0: deposit, draw, repay with interest, withdraw.
   d. Transfer ownership of the production vault and pool to 0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3. Read `owner()` afterwards.

5. Write `contracts/deployments.arc-testnet.json`: every address, role and transaction hash, from receipts only. Never put keys in it.

6. Answer from what you actually checked on Arc testnet: is the Gateway wallet contract deployed there, and is any ERC-4626 Earn or Morpho vault with USDC as its asset deployed there? Give addresses or say none found.

Never simulate a step and report it as done. If a step fails, report the failure and the transaction hash.
