// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title LifelineLendingPool
 * @notice Where the money Lifeline lends can come from: anyone deposits USDC and
 * earns what borrowers pay.
 *
 * Lifeline lends through Circle Gateway, so money leaves the pool as a draw to
 * the operator and comes back as a repayment. The pool counts what is out as an
 * asset until it is repaid or written off, so interest lifts every lender's
 * share and a write-off lowers it.
 *
 * Two limits are enforced here, not on a server: draws cannot take the pool past
 * maxUtilizationBps, and the total out cannot pass exposureCap. The operator is
 * trusted to repay and to report losses honestly; the limits bound how much that
 * trust can cost.
 */
contract LifelineLendingPool {
    uint256 private constant BPS = 10_000;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IPoolERC20 public immutable usdc;
    address public owner;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    /// @notice Principal drawn and not yet repaid or written off.
    uint256 public outstanding;
    uint256 public maxUtilizationBps;
    uint256 public exposureCap;

    uint256 public totalInterestEarned;
    uint256 public totalWrittenOff;

    bool private locked;

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event Drawn(address indexed to, uint256 assets, uint256 outstanding);
    event Repaid(address indexed from, uint256 principal, uint256 interest, uint256 outstanding);
    event WrittenOff(uint256 assets, uint256 outstanding);
    event LimitsChanged(uint256 maxUtilizationBps, uint256 exposureCap);

    modifier onlyOwner() {
        require(msg.sender == owner, "Pool: not owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Pool: reentered");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _usdc, uint256 _maxUtilizationBps, uint256 _exposureCap) {
        require(_usdc != address(0), "Pool: zero address");
        require(_maxUtilizationBps <= BPS, "Pool: bad utilization");
        usdc = IPoolERC20(_usdc);
        owner = msg.sender;
        maxUtilizationBps = _maxUtilizationBps;
        exposureCap = _exposureCap;
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "Pool: zero address");
        owner = next;
    }

    function setLimits(uint256 _maxUtilizationBps, uint256 _exposureCap) external onlyOwner {
        require(_maxUtilizationBps <= BPS, "Pool: bad utilization");
        maxUtilizationBps = _maxUtilizationBps;
        exposureCap = _exposureCap;
        emit LimitsChanged(_maxUtilizationBps, _exposureCap);
    }

    // ---------------------------------------------------------------- lenders

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "Pool: zero amount");
        shares = (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets() + VIRTUAL_ASSETS);
        require(shares > 0, "Pool: deposit too small");
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        require(usdc.transferFrom(msg.sender, address(this), assets), "Pool: transfer failed");
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Lenders leave from what is in the pool. Money out on loan comes back first.
    function withdraw(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "Pool: zero amount");
        require(assets <= cash(), "Pool: not enough liquidity");
        require(assets <= assetsOf(msg.sender), "Pool: more than deposited");

        uint256 num = assets * (totalShares + VIRTUAL_SHARES);
        uint256 den = totalAssets() + VIRTUAL_ASSETS;
        shares = (num + den - 1) / den;
        if (shares > sharesOf[msg.sender]) shares = sharesOf[msg.sender];

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        require(usdc.transfer(msg.sender, assets), "Pool: transfer failed");
        emit Withdrawn(msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------- operator

    /// @notice Take money out to fund lending, within the limits.
    function draw(address to, uint256 assets) external onlyOwner nonReentrant {
        require(to != address(0), "Pool: zero address");
        require(assets > 0 && assets <= cash(), "Pool: not enough liquidity");
        uint256 nextOut = outstanding + assets;
        require(nextOut <= exposureCap, "Pool: over exposure cap");
        require(nextOut * BPS <= totalAssets() * maxUtilizationBps, "Pool: over utilization");
        outstanding = nextOut;
        require(usdc.transfer(to, assets), "Pool: transfer failed");
        emit Drawn(to, assets, nextOut);
    }

    /// @notice Bring money back. Anything above principal is interest for the lenders.
    function repay(uint256 principal, uint256 interest) external nonReentrant {
        require(principal <= outstanding, "Pool: more than outstanding");
        require(principal + interest > 0, "Pool: zero amount");
        outstanding -= principal;
        totalInterestEarned += interest;
        require(usdc.transferFrom(msg.sender, address(this), principal + interest), "Pool: transfer failed");
        emit Repaid(msg.sender, principal, interest, outstanding);
    }

    /// @notice Recognise a loss. The lenders' shares fall by exactly this much.
    function writeOff(uint256 assets) external onlyOwner {
        require(assets > 0 && assets <= outstanding, "Pool: bad amount");
        outstanding -= assets;
        totalWrittenOff += assets;
        emit WrittenOff(assets, outstanding);
    }

    // ---------------------------------------------------------------- views

    function cash() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function totalAssets() public view returns (uint256) {
        return cash() + outstanding;
    }

    function assetsOf(address lender) public view returns (uint256) {
        return (sharesOf[lender] * (totalAssets() + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
    }

    function utilizationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 ? 0 : (outstanding * BPS) / total;
    }

    /// @notice How much the operator could draw right now.
    function drawable() external view returns (uint256) {
        uint256 byUtilization = (totalAssets() * maxUtilizationBps) / BPS;
        uint256 limit = byUtilization < exposureCap ? byUtilization : exposureCap;
        if (limit <= outstanding) return 0;
        uint256 room = limit - outstanding;
        uint256 available = cash();
        return room < available ? room : available;
    }
}
