// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockFeeToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function burn(address from, uint256 amount) external;
}

/// @notice ERC4626-ish yield vault with a configurable EXIT fee in bps.
///  - withdraw(assets): receiver gets exactly `assets`; the owner is charged `assets + fee` worth of
///    shares and `fee` underlying leaves the vault (burned), so the owner's position loses more than `assets`.
///  - redeem(shares): receiver gets `convertToAssets(shares) - fee`; the fee leaves the vault (burned).
/// With `exitFeeBps == 0` it behaves like a plain 1:1-then-pro-rata vault.
contract MockFeeERC4626 {
    address public immutable asset;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public exitFeeBps;

    constructor(address asset_) {
        asset = asset_;
    }

    uint256 public entryFeeBps;

    function setExitFeeBps(uint256 bps) external {
        exitFeeBps = bps;
    }

    function setEntryFeeBps(uint256 bps) external {
        entryFeeBps = bps;
    }

    function totalAssets() public view returns (uint256) {
        return IMockFeeToken(asset).balanceOf(address(this));
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

    /// @dev Entry fee: `fee` of the deposit leaves the vault (burned) and the receiver is credited
    /// shares only for `assets - fee`, so the vault's total assets grow by `assets - fee`.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        uint256 fee = (assets * entryFeeBps) / 10_000;
        shares = convertToShares(assets - fee);
        IMockFeeToken(asset).transferFrom(msg.sender, address(this), assets);
        if (fee > 0) IMockFeeToken(asset).burn(address(this), fee);
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares) {
        uint256 fee = (assets * exitFeeBps) / 10_000;
        uint256 ta = totalAssets();
        shares = totalSupply == 0 ? 0 : ((assets + fee) * totalSupply + ta - 1) / ta;
        _burn(owner_, shares);
        IMockFeeToken(asset).transfer(receiver, assets);
        if (fee > 0) IMockFeeToken(asset).burn(address(this), fee);
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets) {
        uint256 gross = convertToAssets(shares);
        uint256 fee = (gross * exitFeeBps) / 10_000;
        assets = gross - fee;
        _burn(owner_, shares);
        IMockFeeToken(asset).transfer(receiver, assets);
        if (fee > 0) IMockFeeToken(asset).burn(address(this), fee);
    }

    function _burn(address owner_, uint256 shares) internal {
        if (owner_ != msg.sender) revert("allowance unsupported");
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
    }
}
