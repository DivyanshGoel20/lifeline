// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 6-decimal ERC20 test double with Arc-style blocklist, optional transfer fee and a
/// one-shot reentrancy hook fired during transfer/transferFrom.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Arc-style blocklist: blocked `from` or `to` makes transfer/transferFrom revert.
    mapping(address => bool) public blocked;
    // Optional fee (burned) taken from the amount received.
    uint256 public transferFeeBps;

    // One-shot reentrancy hook.
    address public hookTarget;
    bytes public hookData;
    bool public hookAfter;
    bool public hookOk;
    bytes public hookRet;
    uint256 public hookFired;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Blocked(address who);
    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function setTransferFeeBps(uint256 bps) external {
        transferFeeBps = bps;
    }

    function setHook(address target, bytes calldata data, bool after_) external {
        hookTarget = target;
        hookData = data;
        hookAfter = after_;
        hookOk = false;
        delete hookRet;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        if (hookTarget != address(0) && !hookAfter) _fire();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        uint256 fee = (amount * transferFeeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        if (hookTarget != address(0) && hookAfter) _fire();
    }

    function _fire() internal {
        address t = hookTarget;
        bytes memory d = hookData;
        hookTarget = address(0);
        hookFired++;
        (bool ok, bytes memory ret) = t.call(d);
        hookOk = ok;
        hookRet = ret;
    }
}
