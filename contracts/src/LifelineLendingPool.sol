// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILifelinePoolERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title LifelineLendingPool
 * @notice Lenders deposit USDC and earn what borrowers pay. Lender positions are shares of
 *         `totalAssets() = cash() + outstanding`, so interest repaid into the pool raises every
 *         lender's value and a write-off lowers it by exactly the amount written off.
 *
 * @dev Trust model
 *  - Lenders: deposit and withdraw freely, limited by the pool's cash. They bear write-off risk.
 *  - owner: trusted to `draw` funds out to borrowers (bounded by `exposureCap` and
 *    `maxUtilizationBps`), to `writeOff` bad debt, and to change those limits. The owner has no way
 *    to take lender funds except by drawing within those limits, so it should be a multisig/ops
 *    account. Ownership transfer is single step.
 *  - anyone: `repay` (principal and interest). Repaying for the pool is always value-positive for
 *    the pool, so it is not restricted.
 *
 * @dev Arc notes. USDC is Arc's native gas asset and is touched only through its 6-decimal ERC-20
 *  interface. There is no receive/fallback/payable function, no `address(this).balance`, and no
 *  selfdestruct. Native USDC can be force-sent in; share accounting uses virtual shares/assets so a
 *  donation cannot be used to steal from later depositors. A blocklisted lender (or a blocklisted
 *  `draw` recipient) can only block its own transfer: payouts go to the caller, never to a shared
 *  queue, so nobody else is affected. `draw` rejects address(0) because value sent there reverts.
 */
contract LifelineLendingPool {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
    error Reentrancy();
    error ZeroAddress();
    error NotAContract();
    error InvalidUtilization();
    error ZeroAmount();
    error ZeroShares();
    error ExceedsBalance();
    error InsufficientCash();
    error ExceedsOutstanding();
    error ExceedsExposureCap();
    error ExceedsUtilization();
    error TokenCallFailed();
    error TransferAmountMismatch();
    error LockupTooLong();
    error LockedUp(uint256 lockedUntil);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LimitsUpdated(uint256 maxUtilizationBps, uint256 exposureCap);
    event LockupUpdated(uint256 lockup);
    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event Drawn(address indexed to, uint256 assets, uint256 outstanding);
    event Repaid(address indexed payer, uint256 principal, uint256 interest, uint256 outstanding);
    event WrittenOff(uint256 assets, uint256 outstanding);

    // ---------------------------------------------------------------------
    // Constants / storage
    // ---------------------------------------------------------------------
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LOCKUP = 7 days;
    uint256 public constant DEFAULT_LOCKUP = 1 days;

    address public immutable usdc;

    address public owner;
    uint256 public maxUtilizationBps;
    uint256 public exposureCap;

    /// @notice Seconds a lender's position stays locked after each of its deposits. Stops a lender from
    /// joining just before an interest repayment and leaving right after it.
    uint256 public lockup;
    mapping(address => uint256) public lockedUntil;

    uint256 public outstanding;
    uint256 public totalInterestEarned;
    uint256 public totalWrittenOff;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    uint256 private _locked = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address usdc_, uint256 maxUtilizationBps_, uint256 exposureCap_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NotAContract();
        if (maxUtilizationBps_ == 0 || maxUtilizationBps_ > BPS) revert InvalidUtilization();
        usdc = usdc_;
        maxUtilizationBps = maxUtilizationBps_;
        exposureCap = exposureCap_;
        lockup = DEFAULT_LOCKUP;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit LimitsUpdated(maxUtilizationBps_, exposureCap_);
        emit LockupUpdated(DEFAULT_LOCKUP);
    }

    // ---------------------------------------------------------------------
    // Lenders / anyone
    // ---------------------------------------------------------------------

    /// @notice Deposits `assets` USDC (needs allowance) and mints shares to the caller.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets() + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroShares();

        sharesOf[msg.sender] += shares;
        totalShares += shares;
        lockedUntil[msg.sender] = block.timestamp + lockup;

        _pull(msg.sender, assets);
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Withdraws `assets` USDC to the caller. Limited to the pool's cash and to the
    /// caller's own assets. Shares burned are rounded up, against the withdrawer.
    function withdraw(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert LockedUp(lockedUntil[msg.sender]);
        uint256 ta = totalAssets();
        uint256 ts = totalShares;
        uint256 held = sharesOf[msg.sender];

        if (assets > _toAssetsDown(held, ta, ts)) revert ExceedsBalance();
        if (assets > cash()) revert InsufficientCash();

        uint256 num = assets * (ts + VIRTUAL_SHARES);
        uint256 den = ta + VIRTUAL_ASSETS;
        shares = (num + den - 1) / den;
        if (shares > held) shares = held;

        sharesOf[msg.sender] = held - shares;
        totalShares = ts - shares;

        _push(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice Pays back `principal` (reduces `outstanding`) and `interest` (raises every lender's
    /// value). The caller needs allowance for principal + interest.
    function repay(uint256 principal, uint256 interest) external nonReentrant {
        if (principal == 0 && interest == 0) revert ZeroAmount();
        if (principal > outstanding) revert ExceedsOutstanding();

        outstanding -= principal;
        totalInterestEarned += interest;

        _pull(msg.sender, principal + interest);
        emit Repaid(msg.sender, principal, interest, outstanding);
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    /// @notice Sets the post-deposit lockup (at most 7 days). Applies to deposits made after the change.
    function setLockup(uint256 lockup_) external onlyOwner {
        if (lockup_ > MAX_LOCKUP) revert LockupTooLong();
        lockup = lockup_;
        emit LockupUpdated(lockup_);
    }

    /// @notice Lowering a limit below current `outstanding` forces nothing; it only blocks new draws.
    function setLimits(uint256 maxUtilizationBps_, uint256 exposureCap_) external onlyOwner {
        if (maxUtilizationBps_ == 0 || maxUtilizationBps_ > BPS) revert InvalidUtilization();
        maxUtilizationBps = maxUtilizationBps_;
        exposureCap = exposureCap_;
        emit LimitsUpdated(maxUtilizationBps_, exposureCap_);
    }

    /// @notice Sends `assets` of pool cash to `to` and books it as outstanding.
    function draw(address to, uint256 assets) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        if (assets > cash()) revert InsufficientCash();

        uint256 newOutstanding = outstanding + assets;
        if (newOutstanding > exposureCap) revert ExceedsExposureCap();
        // totalAssets is unchanged by a draw (cash moves into outstanding).
        if (newOutstanding * BPS > totalAssets() * maxUtilizationBps) revert ExceedsUtilization();

        outstanding = newOutstanding;
        _push(to, assets);
        emit Drawn(to, assets, newOutstanding);
    }

    /// @notice Writes off `assets` of outstanding principal. Lenders' value falls by exactly `assets`.
    function writeOff(uint256 assets) external onlyOwner nonReentrant {
        if (assets == 0) revert ZeroAmount();
        if (assets > outstanding) revert ExceedsOutstanding();
        outstanding -= assets;
        totalWrittenOff += assets;
        emit WrittenOff(assets, outstanding);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function cash() public view returns (uint256) {
        return ILifelinePoolERC20(usdc).balanceOf(address(this));
    }

    function totalAssets() public view returns (uint256) {
        return cash() + outstanding;
    }

    function assetsOf(address lender) external view returns (uint256) {
        return _toAssetsDown(sharesOf[lender], totalAssets(), totalShares);
    }

    function utilizationBps() external view returns (uint256) {
        uint256 ta = totalAssets();
        if (ta == 0) return 0;
        return (outstanding * BPS) / ta;
    }

    /// @notice The most the owner could draw right now.
    function drawable() external view returns (uint256) {
        uint256 out = outstanding;
        uint256 cap = exposureCap;
        uint256 byCap = cap > out ? cap - out : 0;
        uint256 maxOut = (totalAssets() * maxUtilizationBps) / BPS;
        uint256 byUtil = maxOut > out ? maxOut - out : 0;
        uint256 c = cash();
        uint256 m = byCap < byUtil ? byCap : byUtil;
        return m < c ? m : c;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _toAssetsDown(uint256 shares, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return (shares * (ta + VIRTUAL_ASSETS)) / (ts + VIRTUAL_SHARES);
    }

    function _pull(address from, uint256 amount) internal {
        uint256 balBefore = cash();
        _callToken(abi.encodeCall(ILifelinePoolERC20.transferFrom, (from, address(this), amount)));
        if (cash() - balBefore != amount) revert TransferAmountMismatch();
    }

    function _push(address to, uint256 amount) internal {
        _callToken(abi.encodeCall(ILifelinePoolERC20.transfer, (to, amount)));
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
