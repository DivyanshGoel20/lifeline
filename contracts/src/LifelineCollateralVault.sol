// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILifelineVaultERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ILifelineVaultERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface ILifelineVaultFacility {
    function getOutstandingDebt(bytes32 profileId) external view returns (uint256);

    /// @dev Public getter of `LifelineCreditFacility.profiles`. `status` is the 8th field
    /// (0 Inactive, 1 Active, 2 Suspended, 3 Defaulted).
    function profiles(bytes32 profileId)
        external
        view
        returns (
            bytes32 profileId_,
            address humanOwner,
            bytes32 humanRoot,
            uint256 creditLimit,
            uint256 outstandingDebt,
            uint256 totalBorrowed,
            uint256 totalRepaid,
            uint8 status,
            uint256 createdAt
        );

    function repayWithToken(bytes32 profileId, address beneficiaryAgent, uint256 amount)
        external
        returns (uint256 actualRepaid, uint256 remainingDebt);
}

/**
 * @title LifelineCollateralVault
 * @notice Deposit-backed credit for Lifeline profiles on Arc. Whoever walks away from a debt
 *         leaves their deposit behind: once the facility marks a profile Defaulted, anyone can
 *         call `seize`, which repays that profile's debt from that profile's own deposit.
 *
 * @dev Trust model
 *  - owner: sets terms (LTV, withdraw delay), binds each profile to exactly one controller
 *    (once), and may move all funds into an optional ERC-4626 yield source. The owner can never
 *    move a profile's deposit to itself; the only exits for deposited funds are the controller's
 *    delayed `withdraw` and the permissionless `seize` (which pays the facility only).
 *  - controller: the only address that can deposit, request, cancel or complete a withdrawal for
 *    its profile. Binding is owner-only and one-shot so a stranger cannot claim a public id.
 *  - anyone: `seize` on a defaulted profile, and `latchDefault` while the facility reports Defaulted.
 *    The owner may also latch a default itself (the facility owner is the underwriter and already
 *    decides defaults), which makes seizure immune to a borrower suspending their own profile.
 *  - The yield vault (if set) is trusted: if it reverts or loses funds, vault accounting follows.
 *
 * @dev Arc notes. USDC is the chain's native gas asset and is read here only through its 6-decimal
 *  ERC-20 interface. This contract has no receive/fallback/payable function (stray value-bearing
 *  calls revert), never reads `address(this).balance`, and never uses selfdestruct. Native
 *  USDC can be force-sent to the contract; holdings are therefore tracked as shares with virtual
 *  shares/assets so a donation cannot be used to steal from later depositors. Value transfers to
 *  address(0) or to a blocklisted address revert on Arc: payouts go to a recipient chosen by the
 *  controller, so a blocklisted recipient can only block its own withdrawal. Time gates use `>=`
 *  because Arc block timestamps are non-decreasing, not strictly increasing.
 */
contract LifelineCollateralVault {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
    error NotController();
    error Reentrancy();
    error ZeroAddress();
    error NotAContract();
    error InvalidLtv();
    error InvalidDelay();
    error ZeroAmount();
    error ZeroShares();
    error ControllerAlreadyBound();
    error ProfileNotFound();
    error ExceedsBalance();
    error NoPendingWithdrawal();
    error WithdrawalNotReady();
    error WithdrawalExceedsLtv();
    error ProfileDefaulted();
    error NotDefaulted();
    error NothingToSeize();
    error RepayMismatch();
    error TokenCallFailed();
    error TransferAmountMismatch();
    error InsufficientLiquidity();
    error YieldVaultAssetMismatch();
    error YieldVaultMisbehaved();
    error SameYieldVault();
    error MigrationLoss();
    error YieldExitCost();
    error YieldEntryCost();
    error NothingToLatch();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TermsUpdated(uint256 ltvBps, uint256 withdrawDelay);
    event ControllerBound(bytes32 indexed profileId, address indexed controller);
    event YieldVaultChanged(address indexed previousVault, address indexed newVault, uint256 assetsBefore, uint256 assetsAfter);
    event Deposited(bytes32 indexed profileId, address indexed controller, uint256 assets, uint256 shares);
    event WithdrawalRequested(bytes32 indexed profileId, uint256 assets, uint256 readyAt);
    event WithdrawalCancelled(bytes32 indexed profileId);
    event Withdrawn(bytes32 indexed profileId, address indexed to, uint256 assets, uint256 shares);
    event DefaultLatched(bytes32 indexed profileId, address indexed by);
    event DefaultCleared(bytes32 indexed profileId);
    event Seized(bytes32 indexed profileId, address indexed caller, uint256 assets, uint256 shares, uint256 remainingDebt);

    // ---------------------------------------------------------------------
    // Constants / storage
    // ---------------------------------------------------------------------
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_WITHDRAW_DELAY = 30 days;
    uint8 internal constant STATUS_DEFAULTED = 3;

    struct Withdrawal {
        uint256 assets;
        uint256 readyAt;
    }

    address public immutable usdc;
    address public immutable facility;

    address public owner;
    uint256 public ltvBps;
    uint256 public withdrawDelay;
    address public yieldVault;

    uint256 public totalShares;
    mapping(bytes32 => uint256) public sharesOf;
    mapping(bytes32 => address) public controllerOf;
    mapping(bytes32 => Withdrawal) internal _withdrawals;

    /// @notice True once a default has been recorded in this vault for the profile. The facility lets a
    /// profile's human owner overwrite a Defaulted status with Suspended (`suspendOwnProfile`), so the
    /// facility status alone cannot be relied on to stay Defaulted until someone calls `seize`.
    mapping(bytes32 => bool) public defaultLatched;

    uint256 private _locked = 1;

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyController(bytes32 profileId) {
        if (msg.sender != controllerOf[profileId]) revert NotController();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address usdc_, address facility_, uint256 ltvBps_, uint256 withdrawDelay_) {
        if (usdc_ == address(0) || facility_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0 || facility_.code.length == 0) revert NotAContract();
        _validateTerms(ltvBps_, withdrawDelay_);
        usdc = usdc_;
        facility = facility_;
        ltvBps = ltvBps_;
        withdrawDelay = withdrawDelay_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TermsUpdated(ltvBps_, withdrawDelay_);
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    /// @notice Hands ownership to `next`. Single step: double check the address.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    /// @notice Updates LTV and withdrawal delay. Applies to future requests/checks only: a request
    /// already made keeps the `readyAt` it was given.
    function setTerms(uint256 ltvBps_, uint256 withdrawDelay_) external onlyOwner {
        _validateTerms(ltvBps_, withdrawDelay_);
        ltvBps = ltvBps_;
        withdrawDelay = withdrawDelay_;
        emit TermsUpdated(ltvBps_, withdrawDelay_);
    }

    /// @notice Binds the only address allowed to manage `profileId`'s deposit. One-shot per profile,
    /// owner-only, and the profile must already exist in the facility.
    function bindController(bytes32 profileId, address controller) external onlyOwner {
        if (controller == address(0)) revert ZeroAddress();
        if (controllerOf[profileId] != address(0)) revert ControllerAlreadyBound();
        (,,,,,,,, uint256 createdAt) = ILifelineVaultFacility(facility).profiles(profileId);
        if (createdAt == 0) revert ProfileNotFound();
        controllerOf[profileId] = controller;
        emit ControllerBound(profileId, controller);
    }

    /// @notice Moves ALL funds into the ERC-4626 vault `next`, or back to plain USDC with address(0).
    /// Reverts if the move loses more than 1 bp (+2 wei) of total assets.
    function setYieldVault(address next) external onlyOwner nonReentrant {
        address prev = yieldVault;
        if (next == prev) revert SameYieldVault();
        if (next != address(0)) {
            if (next.code.length == 0) revert NotAContract();
            if (ILifelineVaultERC4626(next).asset() != usdc) revert YieldVaultAssetMismatch();
        }

        uint256 beforeAssets = totalAssets();

        if (prev != address(0)) {
            uint256 held = ILifelineVaultERC4626(prev).balanceOf(address(this));
            if (held > 0) ILifelineVaultERC4626(prev).redeem(held, address(this), address(this));
            if (ILifelineVaultERC4626(prev).balanceOf(address(this)) != 0) revert YieldVaultMisbehaved();
        }

        yieldVault = next;

        if (next != address(0)) {
            uint256 idle = _idle();
            if (idle > 0) _depositToYield(next, idle);
        }

        uint256 afterAssets = totalAssets();
        if (afterAssets + beforeAssets / BPS + 2 < beforeAssets) revert MigrationLoss();
        emit YieldVaultChanged(prev, next, beforeAssets, afterAssets);
    }

    /// @notice Records a default in the vault so that a borrower cannot defeat `seize` afterwards by
    /// flipping the facility status (the facility lets a profile's human owner set its own status to
    /// Suspended). Anyone may latch while the facility reports Defaulted (status 3). The owner may latch
    /// any profile that has debt, which is the race-free path: latch right before/after `markDefault`.
    /// Latching never moves money; it only widens when `seize` is allowed, and `seize` can only ever
    /// repay that profile's own debt from that profile's own deposit.
    function latchDefault(bytes32 profileId) external {
        if (ILifelineVaultFacility(facility).getOutstandingDebt(profileId) == 0) revert NothingToLatch();
        if (msg.sender != owner && _status(profileId) != STATUS_DEFAULTED) revert NotDefaulted();
        defaultLatched[profileId] = true;
        emit DefaultLatched(profileId, msg.sender);
    }

    /// @notice Owner-only: clears a latch, e.g. after the underwriter has reinstated the profile.
    function clearDefault(bytes32 profileId) external onlyOwner {
        delete defaultLatched[profileId];
        emit DefaultCleared(profileId);
    }

    // ---------------------------------------------------------------------
    // Controller
    // ---------------------------------------------------------------------

    /// @notice Pulls `assets` USDC from the controller (needs allowance) and credits `profileId`.
    function deposit(bytes32 profileId, uint256 assets)
        external
        nonReentrant
        onlyController(profileId)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 ta = totalAssets();
        shares = _toSharesDown(assets, ta, totalShares);
        if (shares == 0) revert ZeroShares();

        sharesOf[profileId] += shares;
        totalShares += shares;

        _pull(msg.sender, assets);
        address yv = yieldVault;
        if (yv != address(0)) {
            _depositToYield(yv, assets);
            // A yield source that charges an entry cost beyond rounding would credit this profile
            // with `assets` while the vault gained less, shifting the loss onto everyone else.
            if (totalAssets() + assets / BPS + 2 < ta + assets) revert YieldEntryCost();
        }

        emit Deposited(profileId, msg.sender, assets, shares);
    }

    /// @notice Starts (or replaces and restarts) a withdrawal request for `assets`.
    function requestWithdrawal(bytes32 profileId, uint256 assets)
        external
        nonReentrant
        onlyController(profileId)
    {
        if (assets == 0) revert ZeroAmount();
        if (assets > assetsOf(profileId)) revert ExceedsBalance();
        uint256 readyAt = block.timestamp + withdrawDelay;
        _withdrawals[profileId] = Withdrawal({assets: assets, readyAt: readyAt});
        emit WithdrawalRequested(profileId, assets, readyAt);
    }

    /// @notice Cancels the pending withdrawal request.
    function cancelWithdrawal(bytes32 profileId) external nonReentrant onlyController(profileId) {
        if (_withdrawals[profileId].assets == 0) revert NoPendingWithdrawal();
        delete _withdrawals[profileId];
        emit WithdrawalCancelled(profileId);
    }

    /// @notice Completes a ready withdrawal, paying `to`. Allowed only if the remaining deposit
    /// still covers the profile's outstanding debt at the current LTV, and never while the profile
    /// is Defaulted with debt (that deposit belongs to `seize`).
    function withdraw(bytes32 profileId, address to)
        external
        nonReentrant
        onlyController(profileId)
        returns (uint256 assets)
    {
        if (to == address(0)) revert ZeroAddress();
        Withdrawal memory w = _withdrawals[profileId];
        if (w.assets == 0) revert NoPendingWithdrawal();
        if (block.timestamp < w.readyAt) revert WithdrawalNotReady();

        uint256 ta = totalAssets();
        uint256 ts = totalShares;
        uint256 held = sharesOf[profileId];
        uint256 beforeAssets = _toAssetsDown(held, ta, ts);

        assets = w.assets < beforeAssets ? w.assets : beforeAssets;
        if (assets == 0) revert ZeroAmount();

        uint256 burn = _toSharesUp(assets, ta, ts);
        if (burn > held) burn = held;

        uint256 debt = ILifelineVaultFacility(facility).getOutstandingDebt(profileId);
        if (debt > 0) {
            if (_isDefaulted(profileId)) revert ProfileDefaulted();
            uint256 remaining = burn == held ? 0 : beforeAssets - assets;
            if ((remaining * ltvBps) / BPS < debt) revert WithdrawalExceedsLtv();
        }

        sharesOf[profileId] = held - burn;
        totalShares = ts - burn;
        delete _withdrawals[profileId];

        uint256 paid = _ensureIdle(assets);
        _push(to, paid);
        _checkExitCost(ta, assets);

        emit Withdrawn(profileId, to, paid, burn);
        return paid;
    }

    // ---------------------------------------------------------------------
    // Permissionless
    // ---------------------------------------------------------------------

    /// @notice Anyone may call once the profile is in default: the facility reports it Defaulted (status 3)
    /// or a default was latched in this vault via `latchDefault`. Repays min(debt, deposit) from the
    /// profile's deposit to the facility. Nothing goes to the caller.
    function seize(bytes32 profileId) external nonReentrant returns (uint256 assets) {
        if (!_isDefaulted(profileId)) revert NotDefaulted();

        uint256 debt = ILifelineVaultFacility(facility).getOutstandingDebt(profileId);
        uint256 ta = totalAssets();
        uint256 ts = totalShares;
        uint256 held = sharesOf[profileId];
        uint256 collateral = _toAssetsDown(held, ta, ts);

        assets = debt < collateral ? debt : collateral;
        if (assets == 0) revert NothingToSeize();

        uint256 burn = assets == collateral ? held : _toSharesUp(assets, ta, ts);
        if (burn > held) burn = held;

        sharesOf[profileId] = held - burn;
        totalShares = ts - burn;
        delete _withdrawals[profileId];

        // If the exit takes the whole yield position, the exiting profile bears any exit cost, so the
        // facility may receive slightly less than `assets`.
        uint256 pay = _ensureIdle(assets);
        if (pay == 0) revert NothingToSeize();
        uint256 idleBefore = _idle();

        _approve(facility, pay);
        (uint256 repaid, uint256 remainingDebt) =
            ILifelineVaultFacility(facility).repayWithToken(profileId, address(0), pay);
        _approve(facility, 0);

        if (repaid != pay || idleBefore - _idle() != pay) revert RepayMismatch();
        _checkExitCost(ta, assets);
        if (remainingDebt == 0) delete defaultLatched[profileId];

        emit Seized(profileId, msg.sender, pay, burn, remainingDebt);
        return pay;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice All USDC the vault controls: idle balance plus the yield vault position.
    function totalAssets() public view returns (uint256) {
        address yv = yieldVault;
        uint256 total = _idle();
        if (yv != address(0)) {
            total += ILifelineVaultERC4626(yv).convertToAssets(ILifelineVaultERC4626(yv).balanceOf(address(this)));
        }
        return total;
    }

    function assetsOf(bytes32 profileId) public view returns (uint256) {
        return _toAssetsDown(sharesOf[profileId], totalAssets(), totalShares);
    }

    /// @notice (deposit minus pending withdrawal) * ltvBps / 10000: the credit this deposit can back.
    function creditableOf(bytes32 profileId) external view returns (uint256) {
        uint256 assets = assetsOf(profileId);
        uint256 pending = _withdrawals[profileId].assets;
        uint256 net = pending >= assets ? 0 : assets - pending;
        return (net * ltvBps) / BPS;
    }

    function withdrawalOf(bytes32 profileId) external view returns (uint256 assets, uint256 readyAt) {
        Withdrawal memory w = _withdrawals[profileId];
        return (w.assets, w.readyAt);
    }

    // ---------------------------------------------------------------------
    // Internals: share math (rounds against the caller of the exit/entry)
    // ---------------------------------------------------------------------

    function _toSharesDown(uint256 assets, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return (assets * (ts + VIRTUAL_SHARES)) / (ta + VIRTUAL_ASSETS);
    }

    function _toSharesUp(uint256 assets, uint256 ta, uint256 ts) internal pure returns (uint256) {
        uint256 num = assets * (ts + VIRTUAL_SHARES);
        uint256 den = ta + VIRTUAL_ASSETS;
        return (num + den - 1) / den;
    }

    function _toAssetsDown(uint256 shares, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return (shares * (ta + VIRTUAL_ASSETS)) / (ts + VIRTUAL_SHARES);
    }

    function _validateTerms(uint256 ltvBps_, uint256 withdrawDelay_) internal pure {
        if (ltvBps_ == 0 || ltvBps_ > BPS) revert InvalidLtv();
        if (withdrawDelay_ > MAX_WITHDRAW_DELAY) revert InvalidDelay();
    }

    function _isDefaulted(bytes32 profileId) internal view returns (bool) {
        return defaultLatched[profileId] || _status(profileId) == STATUS_DEFAULTED;
    }

    /// @dev After paying out `assets`, total assets may fall by more than `assets` only by rounding
    /// (<= 1 bp + 2 wei). A yield source that charges a larger exit cost would silently move that
    /// cost onto the other profiles and skew the LTV check, so the whole call reverts instead.
    function _checkExitCost(uint256 totalAssetsBefore, uint256 assets) internal view {
        if (totalAssets() + assets + assets / BPS + 2 < totalAssetsBefore) revert YieldExitCost();
    }

    function _status(bytes32 profileId) internal view returns (uint8 status) {
        (,,,,,,, status,) = ILifelineVaultFacility(facility).profiles(profileId);
    }

    // ---------------------------------------------------------------------
    // Internals: token + yield plumbing
    // ---------------------------------------------------------------------

    function _idle() internal view returns (uint256) {
        return ILifelineVaultERC20(usdc).balanceOf(address(this));
    }

    /// @dev Makes `amount` of USDC available as idle balance and returns how much is available. It is
    /// less than `amount` only when the payout empties the whole yield position and the yield source
    /// charges an exit cost: then the exiting profile (whose shares are burned for `amount`) bears it.
    function _ensureIdle(uint256 amount) internal returns (uint256 available) {
        uint256 idle = _idle();
        if (idle >= amount) return amount;
        address yv = yieldVault;
        if (yv == address(0)) revert InsufficientLiquidity();
        uint256 need = amount - idle;
        uint256 yvShares = ILifelineVaultERC4626(yv).balanceOf(address(this));
        if (need >= ILifelineVaultERC4626(yv).convertToAssets(yvShares)) {
            if (yvShares > 0) ILifelineVaultERC4626(yv).redeem(yvShares, address(this), address(this));
            idle = _idle();
            return idle < amount ? idle : amount;
        }
        ILifelineVaultERC4626(yv).withdraw(need, address(this), address(this));
        if (_idle() - idle < need) revert YieldVaultMisbehaved();
        return amount;
    }

    function _depositToYield(address yv, uint256 amount) internal {
        uint256 idleBefore = _idle();
        _approve(yv, amount);
        ILifelineVaultERC4626(yv).deposit(amount, address(this));
        _approve(yv, 0);
        if (idleBefore - _idle() != amount) revert YieldVaultMisbehaved();
    }

    function _pull(address from, uint256 amount) internal {
        uint256 balBefore = _idle();
        _callToken(abi.encodeCall(ILifelineVaultERC20.transferFrom, (from, address(this), amount)));
        if (_idle() - balBefore != amount) revert TransferAmountMismatch();
    }

    function _push(address to, uint256 amount) internal {
        _callToken(abi.encodeCall(ILifelineVaultERC20.transfer, (to, amount)));
    }

    function _approve(address spender, uint256 amount) internal {
        _callToken(abi.encodeCall(ILifelineVaultERC20.approve, (spender, amount)));
    }

    /// @dev Low-level token call accepting both bool-returning and no-return tokens.
    function _callToken(bytes memory data) private {
        address token = usdc;
        if (token.code.length == 0) revert NotAContract();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TokenCallFailed();
        if (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1)) revert TokenCallFailed();
    }
}
