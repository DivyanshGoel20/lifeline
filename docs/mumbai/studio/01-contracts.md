Build two production contracts for Lifeline, a credit line for AI agents on Arc, then test them and deploy on Arc testnet. Use real Arc testnet USDC at 0x3600000000000000000000000000000000000000 (6-decimal ERC-20 interface). context/LifelineCreditFacility.sol is Lifeline's existing, already-deployed ledger at 0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f on Arc testnet. Do not change it.

Check Arc's EVM differences (native USDC, value transfers, blocklist reverts) and account for anything that affects these contracts. Use Solidity ^0.8.24, no external dependencies, MIT licence. Keep every public name below exactly, because a backend already calls them.

## LifelineCollateralVault
Deposit-backed credit: whoever walks away from a debt leaves their deposit behind.
constructor(address usdc, address facility, uint256 ltvBps, uint256 withdrawDelay)
- owner: transferOwnership(next), setTerms(ltvBps, withdrawDelay), bindController(bytes32 profileId, address controller) settable once per profile, because profile ids are public and the first depositor must not be able to claim a stranger's profile. setYieldVault(address next) moves all funds to an optional ERC-4626 source, or back to plain USDC with address(0).
- controller only: deposit(profileId, assets) returns shares; requestWithdrawal(profileId, assets); cancelWithdrawal(profileId); withdraw(profileId, to) returns assets, allowed only after withdrawDelay, and only if (remaining assets * ltvBps / 10000) still >= facility.getOutstandingDebt(profileId). Drawdowns reach the chain in batches, which is why the delay exists.
- seize(profileId) returns assets: callable by ANYONE, only when the facility reports status 3 (Defaulted). Takes min(debt, collateral), repays through facility.repayWithToken(profileId, address(0), assets), and clears any pending withdrawal. Money can only ever go to that profile's debt.
- views: totalAssets(), assetsOf(profileId), creditableOf(profileId) = (assets minus pending withdrawal) * ltvBps / 10000, sharesOf, totalShares, controllerOf, withdrawalOf (assets, readyAt), ltvBps, withdrawDelay, yieldVault, usdc, facility, owner.
- Holdings tracked as shares so yield accrues to each profile. Virtual shares (1e6) and virtual assets (1) to stop first-depositor inflation. Round partial exits against the withdrawer. Reentrancy guard.
- Facility calls needed: getOutstandingDebt(bytes32), the public profiles(bytes32) getter (status is the 8th field), repayWithToken(bytes32,address,uint256).

## LifelineLendingPool
Lenders fund the credit and earn what borrowers pay.
constructor(address usdc, uint256 maxUtilizationBps, uint256 exposureCap)
- anyone: deposit(assets) returns shares; withdraw(assets) returns shares, limited to the pool's cash and the lender's own assets; repay(principal, interest), where interest raises every lender's value.
- owner: transferOwnership, setLimits(maxUtilizationBps, exposureCap); draw(to, assets), enforcing exposureCap and maxUtilization; writeOff(assets), which lowers lenders' value by exactly that amount.
- views: cash(), totalAssets() = cash + outstanding, assetsOf(lender), utilizationBps(), drawable(), outstanding, totalInterestEarned, totalWrittenOff, sharesOf, totalShares, maxUtilizationBps, exposureCap.
- Same virtual-share and reentrancy protection.

## Do this, in order
1. Write both contracts under contracts/ and full Foundry tests, including attacks: first-depositor donation, reentrancy, a stranger withdrawing or binding, withdrawing collateral that backs debt, and fuzzing that nobody exits with more than they put in. Audit them and fix what you find. Tell me each issue found.
2. Deploy to Arc testnet a fresh test copy of LifelineCreditFacility (from context/) plus a vault wired to it, and run a REAL onchain end-to-end with real testnet USDC: create a profile, authorise an agent, bind a controller, deposit, record a drawdown, try an over-limit withdrawal (must revert), mark default, have a different address call seize, and confirm the debt fell. Report every tx hash.
3. Deploy the production vault with facility = 0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f, ltvBps 8000, withdrawDelay 3600, and the production pool with maxUtilizationBps 8000, exposureCap 100000000. Exercise the pool on testnet: deposit, draw, repay with interest, withdraw. Report tx hashes.
4. Then transfer ownership of the production vault and pool to FACILITY_OWNER, the current owner of the facility at 0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f (read owner() from chain). Do this last.
5. Answer from what you can actually verify on Arc testnet right now: Are Circle Gateway nanopayments live here? Does an Earn or Morpho vault exist here that speaks ERC-4626 and could be the vault's yield source? If so give the address.

If you need testnet USDC and cannot get it, tell me the address to fund rather than faking the step. Never simulate a step and report it as done.
