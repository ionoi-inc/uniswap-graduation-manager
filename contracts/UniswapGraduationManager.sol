// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity);
    
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable returns (uint amountToken, uint amountETH, uint liquidity);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint);
}

/**
 * @title UniswapGraduationManager
 * @notice Manages token graduation from bonding curve to Uniswap V2
 * @dev Handles automatic migration when market cap or liquidity thresholds are met
 */
contract UniswapGraduationManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct GraduationConfig {
        uint256 marketCapThreshold;      // Required market cap for graduation
        uint256 liquidityThreshold;      // Required liquidity for graduation
        uint256 minLockDuration;         // Minimum LP lock duration
        uint256 slippageTolerance;       // Max slippage in basis points (e.g., 100 = 1%)
        bool autoGraduateEnabled;        // Whether auto-graduation is enabled
    }

    struct TokenGraduation {
        address token;
        address pair;
        uint256 graduatedAt;
        uint256 initialLiquidity;
        uint256 lpTokensLocked;
        uint256 unlockTime;
        bool graduated;
    }

    struct BondingCurveData {
        uint256 tokenReserve;
        uint256 ethReserve;
        uint256 virtualLiquidity;
        uint256 currentMarketCap;
    }

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    IUniswapV2Router02 public immutable uniswapRouter;
    IUniswapV2Factory public immutable uniswapFactory;
    address public immutable WETH;

    GraduationConfig public config;
    
    // Token address => Graduation data
    mapping(address => TokenGraduation) public graduations;
    
    // Token address => Bonding curve data
    mapping(address => BondingCurveData) public bondingCurves;
    
    // Token address => whether it's eligible for graduation
    mapping(address => bool) public eligibleTokens;

    // LP lock recipient (could be a vesting contract)
    address public lpLockRecipient;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event TokenRegistered(address indexed token, uint256 initialReserve);
    event GraduationTriggered(address indexed token, uint256 marketCap, uint256 liquidity);
    event LiquidityMigrated(address indexed token, address indexed pair, uint256 liquidity);
    event LPTokensLocked(address indexed token, uint256 amount, uint256 unlockTime);
    event ConfigUpdated(uint256 marketCapThreshold, uint256 liquidityThreshold);
    event EmergencyWithdraw(address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotEligible();
    error AlreadyGraduated();
    error ThresholdNotMet();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error InvalidConfiguration();
    error MigrationFailed();
    error LockPeriodActive();

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _router,
        uint256 _marketCapThreshold,
        uint256 _liquidityThreshold,
        uint256 _minLockDuration,
        address _lpLockRecipient
    ) Ownable(msg.sender) {
        require(_router != address(0), "Invalid router");
        require(_lpLockRecipient != address(0), "Invalid lock recipient");
        
        uniswapRouter = IUniswapV2Router02(_router);
        uniswapFactory = IUniswapV2Factory(IUniswapV2Router02(_router).factory());
        WETH = IUniswapV2Router02(_router).WETH();
        lpLockRecipient = _lpLockRecipient;

        config = GraduationConfig({
            marketCapThreshold: _marketCapThreshold,
            liquidityThreshold: _liquidityThreshold,
            minLockDuration: _minLockDuration,
            slippageTolerance: 100, // 1% default
            autoGraduateEnabled: true
        });
    }

    /*//////////////////////////////////////////////////////////////
                        REGISTRATION FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Register a token for graduation tracking
     * @param token The token address
     * @param initialTokenReserve Initial token reserve in bonding curve
     * @param initialEthReserve Initial ETH reserve in bonding curve
     */
    function registerToken(
        address token,
        uint256 initialTokenReserve,
        uint256 initialEthReserve
    ) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(!eligibleTokens[token], "Already registered");
        
        eligibleTokens[token] = true;
        
        bondingCurves[token] = BondingCurveData({
            tokenReserve: initialTokenReserve,
            ethReserve: initialEthReserve,
            virtualLiquidity: initialEthReserve,
            currentMarketCap: 0
        });

        emit TokenRegistered(token, initialTokenReserve);
    }

    /**
     * @notice Update bonding curve state (called by bonding curve contract)
     * @param token The token address
     * @param tokenReserve Current token reserve
     * @param ethReserve Current ETH reserve
     * @param marketCap Current market cap
     */
    function updateBondingCurve(
        address token,
        uint256 tokenReserve,
        uint256 ethReserve,
        uint256 marketCap
    ) external {
        require(eligibleTokens[token], "Token not registered");
        
        BondingCurveData storage curve = bondingCurves[token];
        curve.tokenReserve = tokenReserve;
        curve.ethReserve = ethReserve;
        curve.currentMarketCap = marketCap;
        curve.virtualLiquidity = ethReserve;

        // Auto-graduate if conditions are met
        if (config.autoGraduateEnabled && !graduations[token].graduated) {
            if (checkGraduationEligibility(token)) {
                _graduateToken(token);
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                        GRADUATION FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Check if a token meets graduation requirements
     * @param token The token address
     * @return Whether the token is eligible for graduation
     */
    function checkGraduationEligibility(address token) public view returns (bool) {
        if (!eligibleTokens[token] || graduations[token].graduated) {
            return false;
        }

        BondingCurveData memory curve = bondingCurves[token];
        
        return curve.currentMarketCap >= config.marketCapThreshold &&
               curve.ethReserve >= config.liquidityThreshold;
    }

    /**
     * @notice Manually trigger graduation (owner or automated)
     * @param token The token address to graduate
     */
    function graduateToken(address token) external onlyOwner nonReentrant {
        _graduateToken(token);
    }

    /**
     * @notice Internal graduation logic
     * @param token The token address to graduate
     */
    function _graduateToken(address token) internal {
        if (!eligibleTokens[token]) revert NotEligible();
        if (graduations[token].graduated) revert AlreadyGraduated();
        if (!checkGraduationEligibility(token)) revert ThresholdNotMet();

        BondingCurveData memory curve = bondingCurves[token];
        
        emit GraduationTriggered(token, curve.currentMarketCap, curve.ethReserve);

        // Create or get Uniswap pair
        address pair = uniswapFactory.getPair(token, WETH);
        if (pair == address(0)) {
            pair = uniswapFactory.createPair(token, WETH);
        }

        // Migrate liquidity to Uniswap V2
        uint256 lpTokens = _migrateLiquidity(token, curve.tokenReserve, curve.ethReserve);

        // Lock LP tokens
        uint256 unlockTime = block.timestamp + config.minLockDuration;
        
        graduations[token] = TokenGraduation({
            token: token,
            pair: pair,
            graduatedAt: block.timestamp,
            initialLiquidity: curve.ethReserve,
            lpTokensLocked: lpTokens,
            unlockTime: unlockTime,
            graduated: true
        });

        emit LPTokensLocked(token, lpTokens, unlockTime);
    }

    /**
     * @notice Migrate liquidity from bonding curve to Uniswap V2
     * @param token The token address
     * @param tokenAmount Amount of tokens to migrate
     * @param ethAmount Amount of ETH to migrate
     * @return liquidity The amount of LP tokens received
     */
    function _migrateLiquidity(
        address token,
        uint256 tokenAmount,
        uint256 ethAmount
    ) internal returns (uint256 liquidity) {
        if (tokenAmount == 0 || ethAmount == 0) revert InsufficientLiquidity();

        // Calculate minimum amounts with slippage
        uint256 minTokenAmount = (tokenAmount * (10000 - config.slippageTolerance)) / 10000;
        uint256 minEthAmount = (ethAmount * (10000 - config.slippageTolerance)) / 10000;

        // Approve router to spend tokens
        IERC20(token).safeApprove(address(uniswapRouter), tokenAmount);

        // Add liquidity to Uniswap V2
        uint256 amountToken;
        uint256 amountETH;
        
        try uniswapRouter.addLiquidityETH{value: ethAmount}(
            token,
            tokenAmount,
            minTokenAmount,
            minEthAmount,
            address(this), // LP tokens come to this contract
            block.timestamp + 300 // 5 minute deadline
        ) returns (uint256 _amountToken, uint256 _amountETH, uint256 _liquidity) {
            amountToken = _amountToken;
            amountETH = _amountETH;
            liquidity = _liquidity;
        } catch {
            revert MigrationFailed();
        }

        // Refund any unused tokens/ETH
        if (tokenAmount > amountToken) {
            IERC20(token).safeTransfer(owner(), tokenAmount - amountToken);
        }
        if (ethAmount > amountETH) {
            payable(owner()).transfer(ethAmount - amountETH);
        }

        address pair = uniswapFactory.getPair(token, WETH);
        emit LiquidityMigrated(token, pair, liquidity);

        return liquidity;
    }

    /*//////////////////////////////////////////////////////////////
                        LP MANAGEMENT FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Unlock and transfer LP tokens after lock period
     * @param token The token address
     */
    function unlockLPTokens(address token) external nonReentrant {
        TokenGraduation storage grad = graduations[token];
        
        require(grad.graduated, "Not graduated");
        if (block.timestamp < grad.unlockTime) revert LockPeriodActive();
        require(grad.lpTokensLocked > 0, "No LP tokens to unlock");

        uint256 amount = grad.lpTokensLocked;
        grad.lpTokensLocked = 0;

        IERC20(grad.pair).safeTransfer(lpLockRecipient, amount);
    }

    /**
     * @notice Get LP token balance for a graduated token
     * @param token The token address
     * @return The amount of locked LP tokens
     */
    function getLockedLPBalance(address token) external view returns (uint256) {
        return graduations[token].lpTokensLocked;
    }

    /**
     * @notice Get time remaining until LP unlock
     * @param token The token address
     * @return Time in seconds until unlock (0 if already unlocked)
     */
    function getTimeUntilUnlock(address token) external view returns (uint256) {
        TokenGraduation memory grad = graduations[token];
        if (!grad.graduated || block.timestamp >= grad.unlockTime) {
            return 0;
        }
        return grad.unlockTime - block.timestamp;
    }

    /*//////////////////////////////////////////////////////////////
                        CONFIGURATION FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update graduation configuration
     */
    function updateConfig(
        uint256 _marketCapThreshold,
        uint256 _liquidityThreshold,
        uint256 _minLockDuration,
        uint256 _slippageTolerance,
        bool _autoGraduateEnabled
    ) external onlyOwner {
        if (_slippageTolerance > 1000) revert InvalidConfiguration(); // Max 10%
        
        config.marketCapThreshold = _marketCapThreshold;
        config.liquidityThreshold = _liquidityThreshold;
        config.minLockDuration = _minLockDuration;
        config.slippageTolerance = _slippageTolerance;
        config.autoGraduateEnabled = _autoGraduateEnabled;

        emit ConfigUpdated(_marketCapThreshold, _liquidityThreshold);
    }

    /**
     * @notice Update LP lock recipient
     */
    function updateLPLockRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Invalid recipient");
        lpLockRecipient = _newRecipient;
    }

    /*//////////////////////////////////////////////////////////////
                        VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get comprehensive graduation status
     * @param token The token address
     */
    function getGraduationStatus(address token) external view returns (
        bool isEligible,
        bool hasGraduated,
        uint256 currentMarketCap,
        uint256 currentLiquidity,
        uint256 marketCapProgress,
        uint256 liquidityProgress
    ) {
        BondingCurveData memory curve = bondingCurves[token];
        TokenGraduation memory grad = graduations[token];

        isEligible = eligibleTokens[token];
        hasGraduated = grad.graduated;
        currentMarketCap = curve.currentMarketCap;
        currentLiquidity = curve.ethReserve;
        
        marketCapProgress = config.marketCapThreshold > 0 
            ? (curve.currentMarketCap * 10000) / config.marketCapThreshold 
            : 0;
        liquidityProgress = config.liquidityThreshold > 0
            ? (curve.ethReserve * 10000) / config.liquidityThreshold
            : 0;
    }

    /**
     * @notice Get Uniswap pair reserves for graduated token
     */
    function getPairReserves(address token) external view returns (
        uint256 reserve0,
        uint256 reserve1,
        address token0,
        address token1
    ) {
        TokenGraduation memory grad = graduations[token];
        require(grad.graduated, "Not graduated");

        IUniswapV2Pair pair = IUniswapV2Pair(grad.pair);
        (uint112 _reserve0, uint112 _reserve1,) = pair.getReserves();
        
        return (
            uint256(_reserve0),
            uint256(_reserve1),
            pair.token0(),
            pair.token1()
        );
    }

    /*//////////////////////////////////////////////////////////////
                        EMERGENCY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Emergency withdraw tokens (only owner)
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdraw(token, amount);
    }

    /**
     * @notice Emergency withdraw ETH (only owner)
     */
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(owner()).transfer(balance);
    }

    /*//////////////////////////////////////////////////////////////
                        RECEIVE FUNCTION
    //////////////////////////////////////////////////////////////*/

    receive() external payable {}
}
