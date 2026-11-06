// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @notice Minimal ERC4626-ish yield vault. 1:1 on first deposit, then pro rata. `donate` raises
/// the share price; `lose` lowers it; `depositFeeBps` / `withdrawShortfall` make it misbehave.
contract MockERC4626 {
    address public immutable asset;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public depositFeeBps;
    uint256 public withdrawShortfall;

    constructor(address asset_) {
        asset = asset_;
    }

    function totalAssets() public view returns (uint256) {
        return IMockToken(asset).balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (totalSupply == 0) return shares;
        return (shares * totalAssets()) / totalSupply;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 ta = totalAssets();
        if (totalSupply == 0 || ta == 0) return assets;
        return (assets * totalSupply) / ta;
    }

    function setDepositFeeBps(uint256 bps) external {
        depositFeeBps = bps;
    }

    function setWithdrawShortfall(uint256 s) external {
        withdrawShortfall = s;
    }

    /// @dev yield: raises the price of every share
    function donate(uint256 amount) external {
        IMockToken(asset).mint(address(this), amount);
    }

    /// @dev loss: lowers the price of every share
    function lose(uint256 amount) external {
        IMockToken(asset).burn(address(this), amount);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        IMockToken(asset).transferFrom(msg.sender, address(this), assets);
        uint256 fee = (assets * depositFeeBps) / 10_000;
        if (fee > 0) IMockToken(asset).burn(address(this), fee);
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares) {
        uint256 ta = totalAssets();
        shares = totalSupply == 0 ? 0 : (assets * totalSupply + ta - 1) / ta;
        _burn(owner_, shares);
        IMockToken(asset).transfer(receiver, assets - withdrawShortfall);
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        _burn(owner_, shares);
        IMockToken(asset).transfer(receiver, assets);
    }

    function _burn(address owner_, uint256 shares) internal {
        if (owner_ != msg.sender) revert("allowance unsupported");
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
    }
}
