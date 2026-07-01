// contracts/InvoiceSettlement.sol
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract InvoiceSettlement {
    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    address public pauser;
    address public blacklister;
    address public settlementToken;
    mapping(address => bool) public blacklisted;
    bool public paused;
    bool private locked;

    event InvoiceSettled(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed recipient,
        address feeRecipient,
        uint256 amount,
        uint256 fee
    );
    event OwnershipTransferRequested(address indexed currentOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event PauserUpdated(address indexed oldPauser, address indexed newPauser);
    event BlacklisterUpdated(address indexed oldBlacklister, address indexed newBlacklister);
    event BlacklistUpdated(address indexed account, bool blocked);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event EmergencyWithdraw(address indexed to, uint256 amount);

    error InvalidFeeRecipient();
    error InvalidFeeBps();
    error SettlementFailed();
    error NotOwner();
    error NotAuthorized();
    error InvalidAddress();
    error Blacklisted();
    error ReentrancyDetected();
    error PausedError();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != pauser) revert NotAuthorized();
        _;
    }

    modifier onlyPauserOrOwner() {
        if (msg.sender != pauser && msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyBlacklister() {
        if (msg.sender != blacklister) revert NotAuthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier whenNotBlacklisted(address account) {
        if (blacklisted[account]) revert Blacklisted();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert ReentrancyDetected();
        locked = true;
        _;
        locked = false;
    }

    constructor(address _token, address _feeRecipient, address _pauser, address _blacklister) {
        if (_token == address(0) || _feeRecipient == address(0)) revert InvalidFeeRecipient();
        if (_pauser == address(0) || _blacklister == address(0)) revert InvalidAddress();
        owner = msg.sender;
        settlementToken = _token;
        feeRecipient = _feeRecipient;
        pauser = _pauser;
        blacklister = _blacklister;
        paused = false;
        locked = false;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidFeeRecipient();
        emit FeeRecipientUpdated(feeRecipient, _feeRecipient);
        feeRecipient = _feeRecipient;
    }

    function setPauser(address _pauser) external onlyOwner {
        if (_pauser == address(0)) revert InvalidAddress();
        emit PauserUpdated(pauser, _pauser);
        pauser = _pauser;
    }

    function setBlacklister(address _blacklister) external onlyOwner {
        if (_blacklister == address(0)) revert InvalidAddress();
        emit BlacklisterUpdated(blacklister, _blacklister);
        blacklister = _blacklister;
    }

    function updateBlacklist(address account, bool blocked) external onlyBlacklister {
        if (account == address(0)) revert InvalidAddress();
        blacklisted[account] = blocked;
        emit BlacklistUpdated(account, blocked);
    }

    function requestOwnershipTransfer(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert InvalidAddress();
        pendingOwner = _newOwner;
        emit OwnershipTransferRequested(owner, _newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function pause() external onlyPauserOrOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauserOrOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function deposit(uint256 amount) external onlyOwner returns (bool) {
        if (amount == 0) revert SettlementFailed();
        if (!IERC20(settlementToken).transferFrom(msg.sender, address(this), amount)) revert SettlementFailed();
        return true;
    }

    function emergencyWithdraw(address recipient, uint256 amount) external onlyOwner nonReentrant returns (bool) {
        if (recipient == address(0)) revert InvalidFeeRecipient();
        if (amount == 0) revert SettlementFailed();
        if (IERC20(settlementToken).balanceOf(address(this)) < amount) revert SettlementFailed();
        if (!IERC20(settlementToken).transfer(recipient, amount)) revert SettlementFailed();
        emit EmergencyWithdraw(recipient, amount);
        return true;
    }

    function settleInvoice(
        uint256 invoiceId,
        address recipient,
        uint16 feeBps,
        uint256 minFee,
        uint256 maxFee,
        uint256 total
    ) external whenNotPaused whenNotBlacklisted(msg.sender) whenNotBlacklisted(recipient) whenNotBlacklisted(feeRecipient) nonReentrant returns (bool) {
        if (recipient == address(0) || feeRecipient == address(0)) revert InvalidFeeRecipient();
        if (feeBps > 10000) revert InvalidFeeBps();
        if (total == 0) revert SettlementFailed();

        if (!IERC20(settlementToken).transferFrom(msg.sender, address(this), total)) revert SettlementFailed();

        uint256 fee = (total * feeBps) / 10000;
        if (fee < minFee) fee = minFee;
        if (fee > maxFee) fee = maxFee;
        if (fee >= total) revert InvalidFeeBps();

        uint256 remainder = total - fee;

        if (!IERC20(settlementToken).transfer(feeRecipient, fee)) revert SettlementFailed();
        if (!IERC20(settlementToken).transfer(recipient, remainder)) revert SettlementFailed();

        emit InvoiceSettled(invoiceId, msg.sender, recipient, feeRecipient, total, fee);
        return true;
    }

    receive() external payable {
        revert("Direct transfers not accepted");
    }

    fallback() external payable {
        revert("Direct transfers not accepted");
    }
}
