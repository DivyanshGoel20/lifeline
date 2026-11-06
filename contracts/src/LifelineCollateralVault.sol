// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IVaultFacility {
    function getOutstandingDebt(bytes32 profileId) external view returns (uint256);
    function profiles(bytes32 profileId)
        external
        view
        returns (
            bytes32 id,
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

/// @notice The subset of ERC-4626 this vault needs from a yield source.
interface IYieldVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title LifelineCollateralVault
 * @notice Deposit-backed credit for a Lifeline profile.
 *
 * An unsecured line rests on one thing: a human who does not want to lose their
 * record. Collateral answers the question that leaves open, what happens if
 * everyone walks away, because whoever walks away leaves their deposit behind.
 *
 * The vault never decides who is in default. It reads that from the facility,
 * and once the facility says Defaulted anyone may call seize: collection does
 * not depend on Lifeline's servers being up.
 *
 * Deposits can earn in an optional ERC-4626 yield source. Holdings are tracked
 * as shares, so yield accrues to each profile without touching every balance.
 */
contract LifelineCollateralVault {
    uint8 private constant STATUS_DEFAULTED = 3;
    uint256 private constant BPS = 10_000;
    // Virtual holdings, so a first depositor cannot skew the share price by
    // donating to the vault and rounding the next deposit away.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IVaultERC20 public immutable usdc;
    IVaultFacility public immutable facility;
    address public owner;
    IYieldVault public yieldVault;

    /// @notice How much of a deposit may be borrowed, in basis points.
    uint256 public ltvBps;
    /// @notice The wait between asking to withdraw and withdrawing. Drawdowns are
    /// batched on the way to the chain, so debt can exist that the facility has
    /// not seen yet; the delay gives the operator time to settle it.
    uint256 public withdrawDelay;

    uint256 public totalShares;
    mapping(bytes32 => uint256) public sharesOf;
    /// @notice The wallet allowed to fund and withdraw for a profile.
    mapping(bytes32 => address) public controllerOf;

    struct WithdrawalRequest {
        uint256 assets;
        uint256 readyAt;
    }

    mapping(bytes32 => WithdrawalRequest) public withdrawalOf;

    bool private locked;

    event ControllerBound(bytes32 indexed profileId, address indexed controller);
    event Deposited(bytes32 indexed profileId, address indexed from, uint256 assets, uint256 shares);
    event WithdrawalRequested(bytes32 indexed profileId, uint256 assets, uint256 readyAt);
    event WithdrawalCancelled(bytes32 indexed profileId);
    event Withdrawn(bytes32 indexed profileId, address indexed to, uint256 assets, uint256 shares);
    event Seized(bytes32 indexed profileId, address indexed caller, uint256 assets, uint256 remainingDebt);
    event YieldVaultChanged(address indexed previous, address indexed next);
    event TermsChanged(uint256 ltvBps, uint256 withdrawDelay);

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    modifier onlyController(bytes32 profileId) {
        require(msg.sender == controllerOf[profileId], "Vault: not controller");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Vault: reentered");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _usdc, address _facility, uint256 _ltvBps, uint256 _withdrawDelay) {
        require(_usdc != address(0) && _facility != address(0), "Vault: zero address");
        require(_ltvBps > 0 && _ltvBps <= BPS, "Vault: bad ltv");
        usdc = IVaultERC20(_usdc);
        facility = IVaultFacility(_facility);
        owner = msg.sender;
        ltvBps = _ltvBps;
        withdrawDelay = _withdrawDelay;
    }

    // ---------------------------------------------------------------- admin

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "Vault: zero address");
        owner = next;
    }

    function setTerms(uint256 _ltvBps, uint256 _withdrawDelay) external onlyOwner {
        require(_ltvBps > 0 && _ltvBps <= BPS, "Vault: bad ltv");
        ltvBps = _ltvBps;
        withdrawDelay = _withdrawDelay;
        emit TermsChanged(_ltvBps, _withdrawDelay);
    }

    /**
     * @notice Lifeline has confirmed this wallet belongs to the profile's human.
     * Set once. Profile ids are public, so if the first depositor became the
     * controller, anyone could claim a stranger's profile with a dust deposit.
     */
    function bindController(bytes32 profileId, address controller) external onlyOwner {
        require(controller != address(0), "Vault: zero address");
        require(controllerOf[profileId] == address(0), "Vault: already bound");
        controllerOf[profileId] = controller;
        emit ControllerBound(profileId, controller);
    }

    /// @notice Move everything to a new yield source, or back to plain USDC with address(0).
    function setYieldVault(address next) external onlyOwner nonReentrant {
        address previous = address(yieldVault);
        if (previous != address(0)) {
            uint256 held = yieldVault.convertToAssets(yieldVault.balanceOf(address(this)));
            if (held > 0) yieldVault.withdraw(held, address(this), address(this));
            require(usdc.approve(previous, 0), "Vault: approve failed");
        }
        yieldVault = IYieldVault(next);
        if (next != address(0)) {
            require(usdc.approve(next, type(uint256).max), "Vault: approve failed");
            uint256 idle = usdc.balanceOf(address(this));
            if (idle > 0) yieldVault.deposit(idle, address(this));
        }
        emit YieldVaultChanged(previous, next);
    }

    // ---------------------------------------------------------------- deposits

    function deposit(bytes32 profileId, uint256 assets) external onlyController(profileId) nonReentrant returns (uint256 shares) {
        require(assets > 0, "Vault: zero amount");
        // Priced before the money arrives, or the deposit would dilute itself.
        shares = (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets() + VIRTUAL_ASSETS);
        require(shares > 0, "Vault: deposit too small");

        sharesOf[profileId] += shares;
        totalShares += shares;

        require(usdc.transferFrom(msg.sender, address(this), assets), "Vault: transfer failed");
        if (address(yieldVault) != address(0)) yieldVault.deposit(assets, address(this));

        emit Deposited(profileId, msg.sender, assets, shares);
    }

    /// @notice Announce a withdrawal. From this moment the amount no longer backs new credit.
    function requestWithdrawal(bytes32 profileId, uint256 assets) external onlyController(profileId) {
        require(assets > 0 && assets <= assetsOf(profileId), "Vault: bad amount");
        uint256 readyAt = block.timestamp + withdrawDelay;
        withdrawalOf[profileId] = WithdrawalRequest({assets: assets, readyAt: readyAt});
        emit WithdrawalRequested(profileId, assets, readyAt);
    }

    function cancelWithdrawal(bytes32 profileId) external onlyController(profileId) {
        delete withdrawalOf[profileId];
        emit WithdrawalCancelled(profileId);
    }

    /// @notice Complete a withdrawal. What stays behind must still cover the debt on chain.
    function withdraw(bytes32 profileId, address to) external onlyController(profileId) nonReentrant returns (uint256 assets) {
        WithdrawalRequest memory req = withdrawalOf[profileId];
        require(req.assets > 0, "Vault: nothing requested");
        require(block.timestamp >= req.readyAt, "Vault: too early");
        require(to != address(0), "Vault: zero address");
        delete withdrawalOf[profileId];

        uint256 held = assetsOf(profileId);
        // Yield can move the value of a share between request and withdrawal.
        assets = req.assets > held ? held : req.assets;
        require(((held - assets) * ltvBps) / BPS >= facility.getOutstandingDebt(profileId), "Vault: collateral backs debt");

        uint256 shares = assets == held ? sharesOf[profileId] : _sharesFor(assets);
        sharesOf[profileId] -= shares;
        totalShares -= shares;

        _free(assets);
        require(usdc.transfer(to, assets), "Vault: transfer failed");
        emit Withdrawn(profileId, to, assets, shares);
    }

    // ---------------------------------------------------------------- default

    /**
     * @notice Use a defaulted profile's collateral to repay its debt. Anyone may
     * call this: the facility has already decided, and the money can only go to
     * the facility, against this profile's debt.
     */
    function seize(bytes32 profileId) external nonReentrant returns (uint256 assets) {
        (, , , , , , , uint8 status, ) = facility.profiles(profileId);
        require(status == STATUS_DEFAULTED, "Vault: not in default");

        uint256 debt = facility.getOutstandingDebt(profileId);
        require(debt > 0, "Vault: no debt");
        uint256 held = assetsOf(profileId);
        require(held > 0, "Vault: no collateral");

        assets = debt < held ? debt : held;
        uint256 shares = assets == held ? sharesOf[profileId] : _sharesFor(assets);
        sharesOf[profileId] -= shares;
        totalShares -= shares;
        delete withdrawalOf[profileId];

        _free(assets);
        require(usdc.approve(address(facility), assets), "Vault: approve failed");
        (, uint256 remaining) = facility.repayWithToken(profileId, address(0), assets);
        emit Seized(profileId, msg.sender, assets, remaining);
    }

    // ---------------------------------------------------------------- views

    function totalAssets() public view returns (uint256) {
        uint256 idle = usdc.balanceOf(address(this));
        if (address(yieldVault) == address(0)) return idle;
        return idle + yieldVault.convertToAssets(yieldVault.balanceOf(address(this)));
    }

    function assetsOf(bytes32 profileId) public view returns (uint256) {
        return (sharesOf[profileId] * (totalAssets() + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
    }

    /// @notice What this profile's collateral can back right now, leaving out
    /// anything already asked to be withdrawn.
    function creditableOf(bytes32 profileId) external view returns (uint256) {
        uint256 held = assetsOf(profileId);
        uint256 leaving = withdrawalOf[profileId].assets;
        uint256 staying = leaving >= held ? 0 : held - leaving;
        return (staying * ltvBps) / BPS;
    }

    // ---------------------------------------------------------------- internal

    /// @dev Rounded up, so a partial exit can never take more than it paid for.
    function _sharesFor(uint256 assets) private view returns (uint256) {
        uint256 num = assets * (totalShares + VIRTUAL_SHARES);
        uint256 den = totalAssets() + VIRTUAL_ASSETS;
        return (num + den - 1) / den;
    }

    function _free(uint256 assets) private {
        uint256 idle = usdc.balanceOf(address(this));
        if (idle < assets) yieldVault.withdraw(assets - idle, address(this), address(this));
    }
}
