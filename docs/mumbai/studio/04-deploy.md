The deployer is funded: 40 USDC on Arc testnet, confirmed on chain. Run steps 4, 5 and 6 of the previous deploy message now, in order. Keep test deposits small (under 2 USDC each). Reminder:

4a. Test copy of LifelineCreditFacility and a vault wired to it. For real onchain: create profile, authorize agent, bind controller, deposit, record a drawdown, an over-limit withdrawal that reverts, default, seize from a different address. Then a second profile: latchDefault after default, suspendOwnProfile, seize still works.
4b. Production vault: facility 0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f, ltvBps 8000, withdrawDelay 3600.
4c. Production pool: maxUtilizationBps 8000, exposureCap 100000000. Exercise on a separate test pool with lockup 0: deposit, draw, repay with interest, withdraw.
4d. Transfer ownership of the production vault and pool to 0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3, then read owner() back.
5. Write contracts/deployments.arc-testnet.json: every address, role and tx hash, from receipts only. No keys. Put the production addresses in src/lifeline/addresses.ts.
6. From what you checked on Arc testnet: is the Gateway wallet contract deployed, and is any ERC-4626 Earn or Morpho vault with USDC as its asset deployed? Give addresses or say none found.

Run steps efficiently, no new audits. Never simulate a step and report it as done. If a step fails, report the failure and tx hash.
