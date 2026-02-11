const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

/**
 * Event Monitoring and Analytics System
 * 
 * Tracks graduation events, LP locks, configuration changes, and security events
 * Provides real-time alerts and historical analytics
 */

class GraduationMonitor {
    constructor(contractAddress, providerUrl, contractABI) {
        this.contractAddress = contractAddress;
        this.provider = new ethers.JsonRpcProvider(providerUrl);
        this.contract = new ethers.Contract(contractAddress, contractABI, this.provider);
        this.eventHistory = [];
        this.alerts = [];
        this.metrics = {
            totalGraduations: 0,
            totalLiquidityAdded: 0n,
            totalLPLocked: 0n,
            averageGraduationSize: 0n,
            circuitBreakerTrips: 0,
            emergencyModeActivations: 0
        };
    }

    /**
     * Start monitoring all events
     */
    async startMonitoring() {
        console.log(`🔍 Starting monitor for contract: ${this.contractAddress}`);
        
        // Listen for graduation events
        this.contract.on("TokenRegistered", (token, tokenReserve, ethReserve, event) => {
            this.handleTokenRegistered(token, tokenReserve, ethReserve, event);
        });

        this.contract.on("BondingCurveUpdated", (token, tokenReserve, ethReserve, event) => {
            this.handleBondingCurveUpdated(token, tokenReserve, ethReserve, event);
        });

        this.contract.on("TokenGraduated", (token, pair, liquidity, event) => {
            this.handleTokenGraduated(token, pair, liquidity, event);
        });

        this.contract.on("LPLocked", (token, amount, unlockTime, event) => {
            this.handleLPLocked(token, amount, unlockTime, event);
        });

        this.contract.on("LPUnlocked", (token, amount, recipient, event) => {
            this.handleLPUnlocked(token, amount, recipient, event);
        });

        // Listen for security events
        this.contract.on("CircuitBreakerTripped", (reason, resetAfter, event) => {
            this.handleCircuitBreakerTripped(reason, resetAfter, event);
        });

        this.contract.on("CircuitBreakerReset", (resetter, event) => {
            this.handleCircuitBreakerReset(resetter, event);
        });

        this.contract.on("EmergencyModeActivated", (activator, reason, event) => {
            this.handleEmergencyModeActivated(activator, reason, event);
        });

        this.contract.on("EmergencyModeDeactivated", (deactivator, event) => {
            this.handleEmergencyModeDeactivated(deactivator, event);
        });

        // Listen for configuration events
        this.contract.on("MarketCapThresholdUpdated", (newThreshold, event) => {
            this.handleConfigUpdate("MarketCapThreshold", newThreshold, event);
        });

        this.contract.on("LiquidityThresholdUpdated", (newThreshold, event) => {
            this.handleConfigUpdate("LiquidityThreshold", newThreshold, event);
        });

        this.contract.on("AutoGraduationToggled", (enabled, event) => {
            this.handleConfigUpdate("AutoGraduation", enabled, event);
        });

        console.log("✅ Monitor started successfully");
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        this.contract.removeAllListeners();
        console.log("🛑 Monitor stopped");
    }

    /**
     * Event Handlers
     */

    handleTokenRegistered(token, tokenReserve, ethReserve, event) {
        const eventData = {
            type: "TokenRegistered",
            token,
            tokenReserve: tokenReserve.toString(),
            ethReserve: ethReserve.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.logEvent("📝 Token Registered", eventData);
    }

    handleBondingCurveUpdated(token, tokenReserve, ethReserve, event) {
        const eventData = {
            type: "BondingCurveUpdated",
            token,
            tokenReserve: tokenReserve.toString(),
            ethReserve: ethReserve.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        
        // Check if close to graduation
        this.checkGraduationProximity(token, ethReserve);
    }

    handleTokenGraduated(token, pair, liquidity, event) {
        const eventData = {
            type: "TokenGraduated",
            token,
            pair,
            liquidity: liquidity.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.metrics.totalGraduations++;
        this.metrics.totalLiquidityAdded += liquidity;

        this.logEvent("🎓 Token Graduated!", eventData);
        this.sendAlert({
            level: "info",
            title: "Token Graduated",
            message: `Token ${token} graduated with ${ethers.formatEther(liquidity)} LP tokens`,
            data: eventData
        });
    }

    handleLPLocked(token, amount, unlockTime, event) {
        const eventData = {
            type: "LPLocked",
            token,
            amount: amount.toString(),
            unlockTime: unlockTime.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.metrics.totalLPLocked += amount;

        this.logEvent("🔒 LP Tokens Locked", eventData);
    }

    handleLPUnlocked(token, amount, recipient, event) {
        const eventData = {
            type: "LPUnlocked",
            token,
            amount: amount.toString(),
            recipient,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);

        this.logEvent("🔓 LP Tokens Unlocked", eventData);
        this.sendAlert({
            level: "info",
            title: "LP Tokens Unlocked",
            message: `${ethers.formatEther(amount)} LP tokens unlocked for ${token}`,
            data: eventData
        });
    }

    handleCircuitBreakerTripped(reason, resetAfter, event) {
        const eventData = {
            type: "CircuitBreakerTripped",
            reason,
            resetAfter: resetAfter.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.metrics.circuitBreakerTrips++;

        this.logEvent("⚠️ CIRCUIT BREAKER TRIPPED", eventData);
        this.sendAlert({
            level: "critical",
            title: "Circuit Breaker Tripped",
            message: `Reason: ${reason}`,
            data: eventData
        });
    }

    handleCircuitBreakerReset(resetter, event) {
        const eventData = {
            type: "CircuitBreakerReset",
            resetter,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.logEvent("✅ Circuit Breaker Reset", eventData);
    }

    handleEmergencyModeActivated(activator, reason, event) {
        const eventData = {
            type: "EmergencyModeActivated",
            activator,
            reason,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.metrics.emergencyModeActivations++;

        this.logEvent("🚨 EMERGENCY MODE ACTIVATED", eventData);
        this.sendAlert({
            level: "critical",
            title: "Emergency Mode Activated",
            message: `Reason: ${reason}`,
            data: eventData
        });
    }

    handleEmergencyModeDeactivated(deactivator, event) {
        const eventData = {
            type: "EmergencyModeDeactivated",
            deactivator,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.logEvent("✅ Emergency Mode Deactivated", eventData);
    }

    handleConfigUpdate(configType, value, event) {
        const eventData = {
            type: "ConfigUpdate",
            configType,
            value: value.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            timestamp: Date.now()
        };

        this.eventHistory.push(eventData);
        this.logEvent(`⚙️ Config Updated: ${configType}`, eventData);
    }

    /**
     * Alert system
     */

    async checkGraduationProximity(token, ethReserve) {
        try {
            const threshold = await this.contract.liquidityThreshold();
            const percentage = (ethReserve * 100n) / threshold;

            if (percentage >= 90n && percentage < 100n) {
                this.sendAlert({
                    level: "warning",
                    title: "Approaching Graduation",
                    message: `Token ${token} is at ${percentage}% of graduation threshold`,
                    data: { token, ethReserve: ethReserve.toString(), percentage: percentage.toString() }
                });
            }
        } catch (error) {
            console.error("Error checking graduation proximity:", error);
        }
    }

    sendAlert(alert) {
        alert.timestamp = Date.now();
        this.alerts.push(alert);

        // Console output with color coding
        const icon = {
            info: "ℹ️",
            warning: "⚠️",
            critical: "🚨"
        }[alert.level] || "📢";

        console.log(`\n${icon} ${alert.level.toUpperCase()}: ${alert.title}`);
        console.log(`   ${alert.message}`);
    }

    logEvent(title, data) {
        console.log(`\n${title}`);
        console.log(`   Token: ${data.token || "N/A"}`);
        console.log(`   Block: ${data.blockNumber}`);
        console.log(`   TX: ${data.transactionHash}`);
    }

    /**
     * Analytics and Reporting
     */

    getMetrics() {
        return {
            ...this.metrics,
            averageGraduationSize: this.metrics.totalGraduations > 0
                ? this.metrics.totalLiquidityAdded / BigInt(this.metrics.totalGraduations)
                : 0n,
            totalEvents: this.eventHistory.length,
            totalAlerts: this.alerts.length
        };
    }

    getEventHistory(filter = {}) {
        let filtered = this.eventHistory;

        if (filter.type) {
            filtered = filtered.filter(e => e.type === filter.type);
        }

        if (filter.token) {
            filtered = filtered.filter(e => e.token === filter.token);
        }

        if (filter.fromBlock) {
            filtered = filtered.filter(e => e.blockNumber >= filter.fromBlock);
        }

        return filtered;
    }

    getAlerts(level = null) {
        if (level) {
            return this.alerts.filter(a => a.level === level);
        }
        return this.alerts;
    }

    /**
     * Export data
     */

    exportToJSON(filename) {
        const data = {
            metrics: this.getMetrics(),
            eventHistory: this.eventHistory,
            alerts: this.alerts,
            exportedAt: new Date().toISOString()
        };

        const filepath = path.join(__dirname, "..", "monitoring", filename);
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        fs.writeFileSync(filepath, JSON.stringify(data, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        , 2));

        console.log(`📊 Data exported to ${filepath}`);
    }

    /**
     * Generate report
     */

    generateReport() {
        const metrics = this.getMetrics();

        console.log("\n" + "=".repeat(60));
        console.log("GRADUATION MANAGER MONITORING REPORT");
        console.log("=".repeat(60));
        console.log(`Total Graduations: ${metrics.totalGraduations}`);
        console.log(`Total Liquidity Added: ${ethers.formatEther(metrics.totalLiquidityAdded)} ETH`);
        console.log(`Total LP Locked: ${ethers.formatEther(metrics.totalLPLocked)} LP`);
        console.log(`Average Graduation Size: ${ethers.formatEther(metrics.averageGraduationSize)} LP`);
        console.log(`Total Events: ${metrics.totalEvents}`);
        console.log(`Total Alerts: ${metrics.totalAlerts}`);
        console.log(`  - Critical: ${this.getAlerts("critical").length}`);
        console.log(`  - Warning: ${this.getAlerts("warning").length}`);
        console.log(`  - Info: ${this.getAlerts("info").length}`);
        console.log(`Circuit Breaker Trips: ${metrics.circuitBreakerTrips}`);
        console.log(`Emergency Mode Activations: ${metrics.emergencyModeActivations}`);
        console.log("=".repeat(60) + "\n");

        return metrics;
    }
}

/**
 * Health Check Monitor
 */

class HealthMonitor {
    constructor(contractAddress, providerUrl, contractABI) {
        this.contractAddress = contractAddress;
        this.provider = new ethers.JsonRpcProvider(providerUrl);
        this.contract = new ethers.Contract(contractAddress, contractABI, this.provider);
    }

    async checkHealth() {
        const health = {
            timestamp: new Date().toISOString(),
            contractAddress: this.contractAddress,
            checks: {}
        };

        try {
            // Check if contract is paused
            health.checks.paused = await this.contract.paused();

            // Check circuit breaker status
            const cbStatus = await this.contract.getCircuitBreakerStatus();
            health.checks.circuitBreaker = {
                isTripped: cbStatus.isTripped,
                reason: cbStatus.reason,
                secondsUntilReset: cbStatus.secondsUntilReset.toString()
            };

            // Check emergency mode
            health.checks.emergencyMode = await this.contract.emergencyMode();

            // Check rate limits
            const rateLimitStatus = await this.contract.getRateLimitStatus();
            health.checks.rateLimit = {
                graduationsUsed: rateLimitStatus.graduationsUsed.toString(),
                graduationsRemaining: rateLimitStatus.graduationsRemaining.toString(),
                liquidityUsed: ethers.formatEther(rateLimitStatus.liquidityUsed),
                liquidityRemaining: ethers.formatEther(rateLimitStatus.liquidityRemaining),
                windowEndsIn: rateLimitStatus.windowEndsIn.toString()
            };

            // Overall health status
            health.status = (!health.checks.paused && 
                           !health.checks.circuitBreaker.isTripped && 
                           !health.checks.emergencyMode) ? "healthy" : "unhealthy";

        } catch (error) {
            health.status = "error";
            health.error = error.message;
        }

        return health;
    }

    async startHealthChecks(intervalSeconds = 60) {
        console.log(`🏥 Starting health checks every ${intervalSeconds} seconds`);

        setInterval(async () => {
            const health = await this.checkHealth();
            
            if (health.status !== "healthy") {
                console.log(`\n⚠️ Health Check Alert: ${health.status}`);
                console.log(JSON.stringify(health, null, 2));
            } else {
                console.log(`✅ Health check passed at ${health.timestamp}`);
            }
        }, intervalSeconds * 1000);
    }
}

/**
 * Usage Example
 */

async function main() {
    const contractAddress = process.env.CONTRACT_ADDRESS;
    const providerUrl = process.env.RPC_URL;
    const contractABI = require("../artifacts/contracts/UniswapGraduationManager.sol/UniswapGraduationManager.json").abi;

    // Start event monitoring
    const monitor = new GraduationMonitor(contractAddress, providerUrl, contractABI);
    await monitor.startMonitoring();

    // Start health monitoring
    const healthMonitor = new HealthMonitor(contractAddress, providerUrl, contractABI);
    await healthMonitor.startHealthChecks(300); // Check every 5 minutes

    // Generate report every hour
    setInterval(() => {
        monitor.generateReport();
        monitor.exportToJSON(`report-${Date.now()}.json`);
    }, 3600000);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n🛑 Shutting down monitors...");
        monitor.stopMonitoring();
        monitor.generateReport();
        process.exit(0);
    });
}

// Export classes
module.exports = {
    GraduationMonitor,
    HealthMonitor,
    main
};

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}
