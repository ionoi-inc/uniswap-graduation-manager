// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title SecurityEnhancements
 * @notice Enhanced security features including circuit breakers, role-based access, and emergency controls
 * @dev Extends the base UniswapGraduationManager with governance and safety mechanisms
 */
abstract contract SecurityEnhancements is AccessControl, Pausable, ReentrancyGuard {
    
    /*//////////////////////////////////////////////////////////////
                                ROLES
    //////////////////////////////////////////////////////////////*/
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    
    /*//////////////////////////////////////////////////////////////
                          CIRCUIT BREAKER STATE
    //////////////////////////////////////////////////////////////*/
    
    struct CircuitBreaker {
        bool isTripped;
        uint256 trippedAt;
        uint256 resetAfter;
        string reason;
    }
    
    CircuitBreaker public circuitBreaker;
    
    // Rate limiting
    struct RateLimit {
        uint256 maxGraduationsPerHour;
        uint256 maxTotalLiquidityPerHour;
        uint256 currentGraduations;
        uint256 currentLiquidity;
        uint256 windowStart;
    }
    
    RateLimit public rateLimit;
    
    // Transaction limits
    struct TransactionLimits {
        uint256 maxSingleGraduationLiquidity;
        uint256 minGraduationDelay;
        uint256 maxSlippageAllowed;
    }
    
    TransactionLimits public txLimits;
    
    // Emergency mode
    bool public emergencyMode;
    uint256 public emergencyModeSince;
    
    // Whitelisted addresses (for testing/privileged access)
    mapping(address => bool) public whitelistedContracts;
    
    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/
    
    event CircuitBreakerTripped(string reason, uint256 resetAfter);
    event CircuitBreakerReset(address indexed resetter);
    event EmergencyModeActivated(address indexed activator, string reason);
    event EmergencyModeDeactivated(address indexed deactivator);
    event RateLimitUpdated(uint256 maxGraduations, uint256 maxLiquidity);
    event TransactionLimitsUpdated(uint256 maxLiquidity, uint256 minDelay, uint256 maxSlippage);
    event ContractWhitelisted(address indexed contractAddress, bool whitelisted);
    event GuardianAction(address indexed guardian, string action);
    
    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/
    
    modifier whenCircuitBreakerNotTripped() {
        require(!circuitBreaker.isTripped, "Circuit breaker tripped");
        
        // Auto-reset if time has passed
        if (circuitBreaker.isTripped && block.timestamp >= circuitBreaker.resetAfter) {
            _resetCircuitBreaker();
        }
        _;
    }
    
    modifier whenNotEmergency() {
        require(!emergencyMode, "Emergency mode active");
        _;
    }
    
    modifier onlyOperatorOrAdmin() {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || 
            hasRole(OPERATOR_ROLE, msg.sender),
            "Not operator or admin"
        );
        _;
    }
    
    modifier onlyGuardianOrAdmin() {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || 
            hasRole(GUARDIAN_ROLE, msg.sender),
            "Not guardian or admin"
        );
        _;
    }
    
    modifier respectsRateLimit(uint256 liquidityAmount) {
        _checkRateLimit(liquidityAmount);
        _;
        _updateRateLimit(liquidityAmount);
    }
    
    modifier respectsTransactionLimits(uint256 liquidityAmount) {
        require(
            liquidityAmount <= txLimits.maxSingleGraduationLiquidity,
            "Exceeds single graduation limit"
        );
        _;
    }
    
    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    
    constructor() {
        // Set up roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(GUARDIAN_ROLE, msg.sender);
        _grantRole(EMERGENCY_ROLE, msg.sender);
        
        // Initialize rate limits
        rateLimit = RateLimit({
            maxGraduationsPerHour: 10,
            maxTotalLiquidityPerHour: 1000 ether,
            currentGraduations: 0,
            currentLiquidity: 0,
            windowStart: block.timestamp
        });
        
        // Initialize transaction limits
        txLimits = TransactionLimits({
            maxSingleGraduationLiquidity: 100 ether,
            minGraduationDelay: 1 hours,
            maxSlippageAllowed: 500 // 5%
        });
        
        // Circuit breaker starts inactive
        circuitBreaker = CircuitBreaker({
            isTripped: false,
            trippedAt: 0,
            resetAfter: 0,
            reason: ""
        });
    }
    
    /*//////////////////////////////////////////////////////////////
                        CIRCUIT BREAKER LOGIC
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Trip the circuit breaker to halt operations
     * @param reason Human-readable reason for tripping
     * @param resetAfterSeconds How long until auto-reset
     */
    function tripCircuitBreaker(
        string memory reason,
        uint256 resetAfterSeconds
    ) external onlyGuardianOrAdmin {
        circuitBreaker.isTripped = true;
        circuitBreaker.trippedAt = block.timestamp;
        circuitBreaker.resetAfter = block.timestamp + resetAfterSeconds;
        circuitBreaker.reason = reason;
        
        emit CircuitBreakerTripped(reason, circuitBreaker.resetAfter);
    }
    
    /**
     * @notice Manually reset the circuit breaker
     */
    function resetCircuitBreaker() external onlyGuardianOrAdmin {
        _resetCircuitBreaker();
    }
    
    function _resetCircuitBreaker() internal {
        circuitBreaker.isTripped = false;
        circuitBreaker.trippedAt = 0;
        circuitBreaker.resetAfter = 0;
        circuitBreaker.reason = "";
        
        emit CircuitBreakerReset(msg.sender);
    }
    
    /*//////////////////////////////////////////////////////////////
                         EMERGENCY CONTROLS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Activate emergency mode (pauses all operations)
     */
    function activateEmergencyMode(string memory reason) external onlyRole(EMERGENCY_ROLE) {
        emergencyMode = true;
        emergencyModeSince = block.timestamp;
        _pause();
        
        emit EmergencyModeActivated(msg.sender, reason);
    }
    
    /**
     * @notice Deactivate emergency mode
     */
    function deactivateEmergencyMode() external onlyRole(DEFAULT_ADMIN_ROLE) {
        emergencyMode = false;
        emergencyModeSince = 0;
        _unpause();
        
        emit EmergencyModeDeactivated(msg.sender);
    }
    
    /**
     * @notice Pause contract operations (guardian can pause, only admin can unpause)
     */
    function pauseContract() external onlyGuardianOrAdmin {
        _pause();
    }
    
    /**
     * @notice Unpause contract operations
     */
    function unpauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    
    /*//////////////////////////////////////////////////////////////
                           RATE LIMITING
    //////////////////////////////////////////////////////////////*/
    
    function _checkRateLimit(uint256 liquidityAmount) internal view {
        // Reset window if hour has passed
        if (block.timestamp >= rateLimit.windowStart + 1 hours) {
            return; // Will be reset in _updateRateLimit
        }
        
        require(
            rateLimit.currentGraduations < rateLimit.maxGraduationsPerHour,
            "Rate limit: too many graduations"
        );
        
        require(
            rateLimit.currentLiquidity + liquidityAmount <= rateLimit.maxTotalLiquidityPerHour,
            "Rate limit: too much liquidity"
        );
    }
    
    function _updateRateLimit(uint256 liquidityAmount) internal {
        // Reset window if hour has passed
        if (block.timestamp >= rateLimit.windowStart + 1 hours) {
            rateLimit.currentGraduations = 1;
            rateLimit.currentLiquidity = liquidityAmount;
            rateLimit.windowStart = block.timestamp;
        } else {
            rateLimit.currentGraduations++;
            rateLimit.currentLiquidity += liquidityAmount;
        }
    }
    
    /**
     * @notice Update rate limiting parameters
     */
    function updateRateLimit(
        uint256 maxGraduations,
        uint256 maxLiquidity
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(maxGraduations > 0, "Invalid max graduations");
        require(maxLiquidity > 0, "Invalid max liquidity");
        
        rateLimit.maxGraduationsPerHour = maxGraduations;
        rateLimit.maxTotalLiquidityPerHour = maxLiquidity;
        
        emit RateLimitUpdated(maxGraduations, maxLiquidity);
    }
    
    /*//////////////////////////////////////////////////////////////
                       TRANSACTION LIMITS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Update transaction limits
     */
    function updateTransactionLimits(
        uint256 maxLiquidity,
        uint256 minDelay,
        uint256 maxSlippage
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(maxLiquidity > 0, "Invalid max liquidity");
        require(maxSlippage <= 1000, "Slippage too high"); // Max 10%
        
        txLimits.maxSingleGraduationLiquidity = maxLiquidity;
        txLimits.minGraduationDelay = minDelay;
        txLimits.maxSlippageAllowed = maxSlippage;
        
        emit TransactionLimitsUpdated(maxLiquidity, minDelay, maxSlippage);
    }
    
    /*//////////////////////////////////////////////////////////////
                          WHITELIST MANAGEMENT
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Add or remove contract from whitelist
     */
    function setContractWhitelist(
        address contractAddress,
        bool whitelisted
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(contractAddress != address(0), "Invalid address");
        whitelistedContracts[contractAddress] = whitelisted;
        
        emit ContractWhitelisted(contractAddress, whitelisted);
    }
    
    /**
     * @notice Check if contract is whitelisted
     */
    function isWhitelisted(address contractAddress) public view returns (bool) {
        return whitelistedContracts[contractAddress];
    }
    
    /*//////////////////////////////////////////////////////////////
                              ROLE MANAGEMENT
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Grant operator role to address
     */
    function addOperator(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(OPERATOR_ROLE, operator);
    }
    
    /**
     * @notice Revoke operator role from address
     */
    function removeOperator(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(OPERATOR_ROLE, operator);
    }
    
    /**
     * @notice Grant guardian role to address
     */
    function addGuardian(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(GUARDIAN_ROLE, guardian);
    }
    
    /**
     * @notice Revoke guardian role from address
     */
    function removeGuardian(address guardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(GUARDIAN_ROLE, guardian);
    }
    
    /**
     * @notice Grant emergency role to address
     */
    function addEmergencyResponder(address responder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(EMERGENCY_ROLE, responder);
    }
    
    /**
     * @notice Revoke emergency role from address
     */
    function removeEmergencyResponder(address responder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(EMERGENCY_ROLE, responder);
    }
    
    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Get current circuit breaker status
     */
    function getCircuitBreakerStatus() external view returns (
        bool isTripped,
        uint256 trippedAt,
        uint256 resetAfter,
        string memory reason,
        uint256 secondsUntilReset
    ) {
        isTripped = circuitBreaker.isTripped;
        trippedAt = circuitBreaker.trippedAt;
        resetAfter = circuitBreaker.resetAfter;
        reason = circuitBreaker.reason;
        
        if (isTripped && block.timestamp < resetAfter) {
            secondsUntilReset = resetAfter - block.timestamp;
        } else {
            secondsUntilReset = 0;
        }
    }
    
    /**
     * @notice Get current rate limit status
     */
    function getRateLimitStatus() external view returns (
        uint256 graduationsUsed,
        uint256 graduationsRemaining,
        uint256 liquidityUsed,
        uint256 liquidityRemaining,
        uint256 windowEndsIn
    ) {
        // Check if window has expired
        if (block.timestamp >= rateLimit.windowStart + 1 hours) {
            return (0, rateLimit.maxGraduationsPerHour, 0, rateLimit.maxTotalLiquidityPerHour, 0);
        }
        
        graduationsUsed = rateLimit.currentGraduations;
        graduationsRemaining = rateLimit.maxGraduationsPerHour - rateLimit.currentGraduations;
        liquidityUsed = rateLimit.currentLiquidity;
        liquidityRemaining = rateLimit.maxTotalLiquidityPerHour - rateLimit.currentLiquidity;
        windowEndsIn = (rateLimit.windowStart + 1 hours) - block.timestamp;
    }
    
    /**
     * @notice Check if address has any privileged role
     */
    function hasAnyRole(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account) ||
               hasRole(OPERATOR_ROLE, account) ||
               hasRole(GUARDIAN_ROLE, account) ||
               hasRole(EMERGENCY_ROLE, account);
    }
    
    /**
     * @notice Get all roles for an address
     */
    function getRoles(address account) external view returns (
        bool isAdmin,
        bool isOperator,
        bool isGuardian,
        bool isEmergencyResponder
    ) {
        isAdmin = hasRole(DEFAULT_ADMIN_ROLE, account);
        isOperator = hasRole(OPERATOR_ROLE, account);
        isGuardian = hasRole(GUARDIAN_ROLE, account);
        isEmergencyResponder = hasRole(EMERGENCY_ROLE, account);
    }
}

/**
 * @title GovernanceModule
 * @notice Time-locked configuration changes with proposal system
 */
abstract contract GovernanceModule is SecurityEnhancements {
    
    struct ConfigProposal {
        uint256 proposalId;
        address proposer;
        bytes configData;
        uint256 proposedAt;
        uint256 executeAfter;
        bool executed;
        bool cancelled;
        string description;
    }
    
    uint256 public proposalCount;
    uint256 public timelock = 2 days;
    
    mapping(uint256 => ConfigProposal) public proposals;
    
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ProposalCancelled(uint256 indexed proposalId, address indexed canceller);
    event TimelockUpdated(uint256 newTimelock);
    
    /**
     * @notice Create a configuration change proposal
     */
    function proposeConfigChange(
        bytes memory configData,
        string memory description
    ) external onlyOperatorOrAdmin returns (uint256) {
        proposalCount++;
        
        proposals[proposalCount] = ConfigProposal({
            proposalId: proposalCount,
            proposer: msg.sender,
            configData: configData,
            proposedAt: block.timestamp,
            executeAfter: block.timestamp + timelock,
            executed: false,
            cancelled: false,
            description: description
        });
        
        emit ProposalCreated(proposalCount, msg.sender, description);
        return proposalCount;
    }
    
    /**
     * @notice Execute a proposal after timelock
     */
    function executeProposal(uint256 proposalId) external onlyOperatorOrAdmin {
        ConfigProposal storage proposal = proposals[proposalId];
        
        require(!proposal.executed, "Already executed");
        require(!proposal.cancelled, "Proposal cancelled");
        require(block.timestamp >= proposal.executeAfter, "Timelock not expired");
        
        proposal.executed = true;
        
        // Execute the configuration change
        _executeConfigChange(proposal.configData);
        
        emit ProposalExecuted(proposalId, msg.sender);
    }
    
    /**
     * @notice Cancel a pending proposal
     */
    function cancelProposal(uint256 proposalId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ConfigProposal storage proposal = proposals[proposalId];
        
        require(!proposal.executed, "Already executed");
        require(!proposal.cancelled, "Already cancelled");
        
        proposal.cancelled = true;
        
        emit ProposalCancelled(proposalId, msg.sender);
    }
    
    /**
     * @notice Update timelock duration
     */
    function updateTimelock(uint256 newTimelock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTimelock >= 1 hours && newTimelock <= 7 days, "Invalid timelock");
        timelock = newTimelock;
        
        emit TimelockUpdated(newTimelock);
    }
    
    /**
     * @notice Internal function to execute config changes
     * @dev Should be overridden by implementing contract
     */
    function _executeConfigChange(bytes memory configData) internal virtual;
}
