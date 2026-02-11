const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deployment script for UniswapGraduationManager
 * 
 * This script handles:
 * - Contract deployment with configurable parameters
 * - Verification on block explorers
 * - Configuration management
 * - Post-deployment setup
 */

// Deployment configuration
const DEPLOYMENT_CONFIG = {
    // Network-specific Uniswap V2 Router addresses
    routers: {
        mainnet: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        goerli: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        sepolia: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
        polygon: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
        bsc: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap
        arbitrum: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
        optimism: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
        base: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
        // Local/hardhat - will be deployed
        hardhat: null,
        localhost: null,
    },

    // Default graduation thresholds
    thresholds: {
        marketCap: ethers.parseEther("100"), // 100 ETH market cap
        liquidity: ethers.parseEther("50"),  // 50 ETH liquidity
    },

    // LP lock duration (7 days in seconds)
    lockDuration: 7 * 24 * 60 * 60,

    // Initial configuration
    initialConfig: {
        autoGraduationEnabled: true,
        slippageTolerance: 100, // 1%
    }
};

/**
 * Get network-specific router address
 */
function getRouterAddress(network) {
    const router = DEPLOYMENT_CONFIG.routers[network];
    if (!router && network !== "hardhat" && network !== "localhost") {
        throw new Error(`No router configured for network: ${network}`);
    }
    return router;
}

/**
 * Deploy mock Uniswap V2 contracts for testing networks
 */
async function deployMockUniswap() {
    console.log("Deploying mock Uniswap V2 contracts...");

    const MockUniswapV2Factory = await ethers.getContractFactory("MockUniswapV2Factory");
    const factory = await MockUniswapV2Factory.deploy();
    await factory.waitForDeployment();
    console.log(`Mock Factory deployed to: ${factory.target}`);

    const MockUniswapV2Router = await ethers.getContractFactory("MockUniswapV2Router");
    const router = await MockUniswapV2Router.deploy(factory.target);
    await router.waitForDeployment();
    console.log(`Mock Router deployed to: ${router.target}`);

    return { factory: factory.target, router: router.target };
}

/**
 * Deploy UniswapGraduationManager contract
 */
async function deployGraduationManager(routerAddress, config) {
    console.log("\n=== Deploying UniswapGraduationManager ===");
    console.log(`Router Address: ${routerAddress}`);
    console.log(`Market Cap Threshold: ${ethers.formatEther(config.thresholds.marketCap)} ETH`);
    console.log(`Liquidity Threshold: ${ethers.formatEther(config.thresholds.liquidity)} ETH`);
    console.log(`Lock Duration: ${config.lockDuration / 86400} days`);

    const UniswapGraduationManager = await ethers.getContractFactory("UniswapGraduationManager");
    const manager = await UniswapGraduationManager.deploy(
        routerAddress,
        config.thresholds.marketCap,
        config.thresholds.liquidity,
        config.lockDuration
    );

    await manager.waitForDeployment();
    const managerAddress = manager.target;

    console.log(`\n✅ UniswapGraduationManager deployed to: ${managerAddress}`);

    return { manager, address: managerAddress };
}

/**
 * Configure contract after deployment
 */
async function configureContract(manager, config) {
    console.log("\n=== Configuring Contract ===");

    const tx1 = await manager.setAutoGraduation(config.initialConfig.autoGraduationEnabled);
    await tx1.wait();
    console.log(`Auto-graduation enabled: ${config.initialConfig.autoGraduationEnabled}`);

    const tx2 = await manager.setSlippageTolerance(config.initialConfig.slippageTolerance);
    await tx2.wait();
    console.log(`Slippage tolerance set to: ${config.initialConfig.slippageTolerance / 100}%`);

    console.log("✅ Configuration complete");
}

/**
 * Save deployment information
 */
function saveDeploymentInfo(network, deploymentData) {
    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const networkDir = path.join(deploymentsDir, network);
    if (!fs.existsSync(networkDir)) {
        fs.mkdirSync(networkDir, { recursive: true });
    }

    const deploymentFile = path.join(networkDir, "UniswapGraduationManager.json");
    const data = {
        ...deploymentData,
        timestamp: new Date().toISOString(),
        network: network,
    };

    fs.writeFileSync(deploymentFile, JSON.stringify(data, null, 2));
    console.log(`\n📁 Deployment info saved to: ${deploymentFile}`);
}

/**
 * Verify contract on block explorer
 */
async function verifyContract(address, constructorArgs) {
    console.log("\n=== Verifying Contract ===");
    
    try {
        await hre.run("verify:verify", {
            address: address,
            constructorArguments: constructorArgs,
        });
        console.log("✅ Contract verified successfully");
    } catch (error) {
        if (error.message.includes("already verified")) {
            console.log("ℹ️  Contract already verified");
        } else {
            console.error("❌ Verification failed:", error.message);
        }
    }
}

/**
 * Display deployment summary
 */
function displaySummary(deploymentData) {
    console.log("\n" + "=".repeat(60));
    console.log("DEPLOYMENT SUMMARY");
    console.log("=".repeat(60));
    console.log(`Network: ${deploymentData.network}`);
    console.log(`Deployer: ${deploymentData.deployer}`);
    console.log(`Manager Address: ${deploymentData.managerAddress}`);
    console.log(`Router Address: ${deploymentData.routerAddress}`);
    console.log(`Market Cap Threshold: ${ethers.formatEther(deploymentData.config.thresholds.marketCap)} ETH`);
    console.log(`Liquidity Threshold: ${ethers.formatEther(deploymentData.config.thresholds.liquidity)} ETH`);
    console.log(`Lock Duration: ${deploymentData.config.lockDuration / 86400} days`);
    console.log(`Timestamp: ${deploymentData.timestamp}`);
    console.log("=".repeat(60) + "\n");
}

/**
 * Main deployment function
 */
async function main() {
    const [deployer] = await ethers.getSigners();
    const network = hre.network.name;

    console.log("\n" + "=".repeat(60));
    console.log("UNISWAP GRADUATION MANAGER DEPLOYMENT");
    console.log("=".repeat(60));
    console.log(`Network: ${network}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
    console.log("=".repeat(60));

    let routerAddress = getRouterAddress(network);
    let factoryAddress = null;

    // Deploy mock contracts for local networks
    if (!routerAddress) {
        const mocks = await deployMockUniswap();
        routerAddress = mocks.router;
        factoryAddress = mocks.factory;
    }

    // Deploy graduation manager
    const { manager, address: managerAddress } = await deployGraduationManager(
        routerAddress,
        DEPLOYMENT_CONFIG
    );

    // Configure contract
    await configureContract(manager, DEPLOYMENT_CONFIG);

    // Prepare deployment data
    const deploymentData = {
        network: network,
        deployer: deployer.address,
        managerAddress: managerAddress,
        routerAddress: routerAddress,
        factoryAddress: factoryAddress,
        config: {
            thresholds: {
                marketCap: DEPLOYMENT_CONFIG.thresholds.marketCap.toString(),
                liquidity: DEPLOYMENT_CONFIG.thresholds.liquidity.toString(),
            },
            lockDuration: DEPLOYMENT_CONFIG.lockDuration,
            autoGraduationEnabled: DEPLOYMENT_CONFIG.initialConfig.autoGraduationEnabled,
            slippageTolerance: DEPLOYMENT_CONFIG.initialConfig.slippageTolerance,
        },
        constructorArgs: [
            routerAddress,
            DEPLOYMENT_CONFIG.thresholds.marketCap,
            DEPLOYMENT_CONFIG.thresholds.liquidity,
            DEPLOYMENT_CONFIG.lockDuration,
        ],
        timestamp: new Date().toISOString(),
    };

    // Save deployment info
    saveDeploymentInfo(network, deploymentData);

    // Display summary
    displaySummary(deploymentData);

    // Verify on block explorer (skip for local networks)
    if (network !== "hardhat" && network !== "localhost" && process.env.ETHERSCAN_API_KEY) {
        console.log("\nWaiting 30 seconds before verification...");
        await new Promise(resolve => setTimeout(resolve, 30000));
        await verifyContract(managerAddress, deploymentData.constructorArgs);
    }

    console.log("\n✅ Deployment complete!");
    console.log("\nNext steps:");
    console.log("1. Register your bonding curve contract");
    console.log("2. Set up monitoring for graduation events");
    console.log("3. Configure LP recipient addresses");
    console.log("4. Test with a small token deployment\n");

    return deploymentData;
}

// Execute deployment
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = { main, deployGraduationManager, DEPLOYMENT_CONFIG };
