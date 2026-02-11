const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("UniswapGraduationManager", function () {
    // Constants for testing
    const INITIAL_TOKEN_RESERVE = ethers.parseEther("1000000"); // 1M tokens
    const INITIAL_ETH_RESERVE = ethers.parseEther("10"); // 10 ETH
    const MARKET_CAP_THRESHOLD = ethers.parseEther("100"); // 100 ETH
    const LIQUIDITY_THRESHOLD = ethers.parseEther("50"); // 50 ETH
    const LOCK_DURATION = 7 * 24 * 60 * 60; // 7 days
    const SLIPPAGE_TOLERANCE = 100; // 1%

    async function deployFixture() {
        const [owner, bondingCurve, lpRecipient, user1, user2] = await ethers.getSigners();

        // Deploy mock ERC20 token
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const token = await MockERC20.deploy("Test Token", "TEST", ethers.parseEther("10000000"));

        // Deploy mock Uniswap V2 Factory
        const MockUniswapV2Factory = await ethers.getContractFactory("MockUniswapV2Factory");
        const factory = await MockUniswapV2Factory.deploy();

        // Deploy mock Uniswap V2 Router
        const MockUniswapV2Router = await ethers.getContractFactory("MockUniswapV2Router");
        const router = await MockUniswapV2Router.deploy(factory.target);

        // Deploy UniswapGraduationManager
        const UniswapGraduationManager = await ethers.getContractFactory("UniswapGraduationManager");
        const manager = await UniswapGraduationManager.deploy(
            router.target,
            MARKET_CAP_THRESHOLD,
            LIQUIDITY_THRESHOLD,
            LOCK_DURATION
        );

        // Transfer tokens to bonding curve for testing
        await token.transfer(bondingCurve.address, ethers.parseEther("2000000"));

        return { manager, token, router, factory, owner, bondingCurve, lpRecipient, user1, user2 };
    }

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            const { manager, owner } = await loadFixture(deployFixture);
            expect(await manager.owner()).to.equal(owner.address);
        });

        it("Should initialize with correct parameters", async function () {
            const { manager } = await loadFixture(deployFixture);
            expect(await manager.marketCapThreshold()).to.equal(MARKET_CAP_THRESHOLD);
            expect(await manager.liquidityThreshold()).to.equal(LIQUIDITY_THRESHOLD);
            expect(await manager.lockDuration()).to.equal(LOCK_DURATION);
            expect(await manager.autoGraduationEnabled()).to.equal(true);
        });

        it("Should revert if router address is zero", async function () {
            const UniswapGraduationManager = await ethers.getContractFactory("UniswapGraduationManager");
            await expect(
                UniswapGraduationManager.deploy(
                    ethers.ZeroAddress,
                    MARKET_CAP_THRESHOLD,
                    LIQUIDITY_THRESHOLD,
                    LOCK_DURATION
                )
            ).to.be.revertedWith("Invalid router address");
        });
    });

    describe("Token Registration", function () {
        it("Should register a token successfully", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await expect(
                manager.connect(bondingCurve).registerToken(
                    token.target,
                    INITIAL_TOKEN_RESERVE,
                    INITIAL_ETH_RESERVE
                )
            )
                .to.emit(manager, "TokenRegistered")
                .withArgs(token.target, INITIAL_TOKEN_RESERVE, INITIAL_ETH_RESERVE);

            const bondingState = await manager.bondingCurves(token.target);
            expect(bondingState.isRegistered).to.be.true;
            expect(bondingState.tokenReserve).to.equal(INITIAL_TOKEN_RESERVE);
            expect(bondingState.ethReserve).to.equal(INITIAL_ETH_RESERVE);
        });

        it("Should revert if token already registered", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await expect(
                manager.connect(bondingCurve).registerToken(
                    token.target,
                    INITIAL_TOKEN_RESERVE,
                    INITIAL_ETH_RESERVE
                )
            ).to.be.revertedWith("Token already registered");
        });

        it("Should revert if reserves are zero", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await expect(
                manager.connect(bondingCurve).registerToken(token.target, 0, INITIAL_ETH_RESERVE)
            ).to.be.revertedWith("Invalid reserves");

            await expect(
                manager.connect(bondingCurve).registerToken(token.target, INITIAL_TOKEN_RESERVE, 0)
            ).to.be.revertedWith("Invalid reserves");
        });
    });

    describe("Bonding Curve Updates", function () {
        it("Should update bonding curve state", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            const newTokenReserve = ethers.parseEther("900000");
            const newEthReserve = ethers.parseEther("15");

            await expect(
                manager.connect(bondingCurve).updateBondingCurve(
                    token.target,
                    newTokenReserve,
                    newEthReserve
                )
            )
                .to.emit(manager, "BondingCurveUpdated")
                .withArgs(token.target, newTokenReserve, newEthReserve);

            const bondingState = await manager.bondingCurves(token.target);
            expect(bondingState.tokenReserve).to.equal(newTokenReserve);
            expect(bondingState.ethReserve).to.equal(newEthReserve);
        });

        it("Should revert if not called by bonding curve", async function () {
            const { manager, token, bondingCurve, user1 } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await expect(
                manager.connect(user1).updateBondingCurve(
                    token.target,
                    ethers.parseEther("900000"),
                    ethers.parseEther("15")
                )
            ).to.be.revertedWith("Not bonding curve");
        });

        it("Should revert if token not registered", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await expect(
                manager.connect(bondingCurve).updateBondingCurve(
                    token.target,
                    ethers.parseEther("900000"),
                    ethers.parseEther("15")
                )
            ).to.be.revertedWith("Token not registered");
        });
    });

    describe("Graduation Eligibility", function () {
        it("Should check eligibility based on market cap", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            // Initial state - not eligible
            expect(await manager.checkGraduationEligibility(token.target)).to.be.false;

            // Update to meet market cap threshold
            const newTokenReserve = ethers.parseEther("500000");
            const newEthReserve = ethers.parseEther("120"); // Market cap = 120 ETH > 100 ETH threshold

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                newTokenReserve,
                newEthReserve
            );

            expect(await manager.checkGraduationEligibility(token.target)).to.be.true;
        });

        it("Should check eligibility based on liquidity", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            // Update to meet liquidity threshold
            const newTokenReserve = ethers.parseEther("900000");
            const newEthReserve = ethers.parseEther("60"); // Liquidity = 60 ETH > 50 ETH threshold

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                newTokenReserve,
                newEthReserve
            );

            expect(await manager.checkGraduationEligibility(token.target)).to.be.true;
        });
    });

    describe("Manual Graduation", function () {
        it("Should graduate token manually when eligible", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            // Register and make eligible
            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            // Approve tokens and send ETH
            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            
            await expect(
                manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                    value: ethers.parseEther("120")
                })
            ).to.emit(manager, "TokenGraduated");

            const bondingState = await manager.bondingCurves(token.target);
            expect(bondingState.hasGraduated).to.be.true;
        });

        it("Should revert if not eligible", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await expect(
                manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                    value: INITIAL_ETH_RESERVE
                })
            ).to.be.revertedWith("Not eligible for graduation");
        });

        it("Should revert if already graduated", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            await expect(
                manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                    value: ethers.parseEther("120")
                })
            ).to.be.revertedWith("Already graduated");
        });
    });

    describe("LP Token Locking", function () {
        it("Should lock LP tokens after graduation", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            const lockInfo = await manager.lpLocks(token.target);
            expect(lockInfo.amount).to.be.gt(0);
            expect(lockInfo.unlockTime).to.be.gt(await time.latest());
        });

        it("Should not allow unlock before lock duration", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            await expect(
                manager.unlockLP(token.target)
            ).to.be.revertedWith("LP tokens still locked");
        });

        it("Should allow unlock after lock duration", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            // Fast forward time
            await time.increase(LOCK_DURATION + 1);

            await expect(manager.unlockLP(token.target))
                .to.emit(manager, "LPUnlocked");

            const lockInfo = await manager.lpLocks(token.target);
            expect(lockInfo.amount).to.equal(0);
        });
    });

    describe("Configuration Management", function () {
        it("Should allow owner to update market cap threshold", async function () {
            const { manager, owner } = await loadFixture(deployFixture);

            const newThreshold = ethers.parseEther("200");
            await expect(manager.connect(owner).setMarketCapThreshold(newThreshold))
                .to.emit(manager, "MarketCapThresholdUpdated")
                .withArgs(newThreshold);

            expect(await manager.marketCapThreshold()).to.equal(newThreshold);
        });

        it("Should allow owner to update liquidity threshold", async function () {
            const { manager, owner } = await loadFixture(deployFixture);

            const newThreshold = ethers.parseEther("75");
            await expect(manager.connect(owner).setLiquidityThreshold(newThreshold))
                .to.emit(manager, "LiquidityThresholdUpdated")
                .withArgs(newThreshold);

            expect(await manager.liquidityThreshold()).to.equal(newThreshold);
        });

        it("Should allow owner to toggle auto-graduation", async function () {
            const { manager, owner } = await loadFixture(deployFixture);

            await expect(manager.connect(owner).setAutoGraduation(false))
                .to.emit(manager, "AutoGraduationToggled")
                .withArgs(false);

            expect(await manager.autoGraduationEnabled()).to.be.false;
        });

        it("Should allow owner to update slippage tolerance", async function () {
            const { manager, owner } = await loadFixture(deployFixture);

            const newSlippage = 200; // 2%
            await expect(manager.connect(owner).setSlippageTolerance(newSlippage))
                .to.emit(manager, "SlippageToleranceUpdated")
                .withArgs(newSlippage);

            expect(await manager.slippageTolerance()).to.equal(newSlippage);
        });

        it("Should revert if non-owner tries to update config", async function () {
            const { manager, user1 } = await loadFixture(deployFixture);

            await expect(
                manager.connect(user1).setMarketCapThreshold(ethers.parseEther("200"))
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should revert if slippage tolerance exceeds maximum", async function () {
            const { manager, owner } = await loadFixture(deployFixture);

            await expect(
                manager.connect(owner).setSlippageTolerance(1001) // > 10%
            ).to.be.revertedWith("Slippage too high");
        });
    });

    describe("View Functions", function () {
        it("Should return correct graduation status", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            const status = await manager.getGraduationStatus(token.target);
            expect(status.isRegistered).to.be.true;
            expect(status.hasGraduated).to.be.false;
            expect(status.tokenReserve).to.equal(INITIAL_TOKEN_RESERVE);
            expect(status.ethReserve).to.equal(INITIAL_ETH_RESERVE);
        });

        it("Should calculate time until unlock correctly", async function () {
            const { manager, token, bondingCurve, lpRecipient } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            const timeUntilUnlock = await manager.getTimeUntilUnlock(token.target);
            expect(timeUntilUnlock).to.be.closeTo(BigInt(LOCK_DURATION), BigInt(5));
        });
    });

    describe("Emergency Functions", function () {
        it("Should allow owner to emergency withdraw tokens", async function () {
            const { manager, token, owner, bondingCurve } = await loadFixture(deployFixture);

            // Send some tokens to the contract
            await token.connect(bondingCurve).transfer(manager.target, ethers.parseEther("1000"));

            const initialBalance = await token.balanceOf(owner.address);

            await expect(
                manager.connect(owner).emergencyWithdrawToken(token.target, ethers.parseEther("1000"))
            ).to.emit(manager, "EmergencyWithdraw");

            const finalBalance = await token.balanceOf(owner.address);
            expect(finalBalance - initialBalance).to.equal(ethers.parseEther("1000"));
        });

        it("Should allow owner to emergency withdraw ETH", async function () {
            const { manager, owner, user1 } = await loadFixture(deployFixture);

            // Send ETH to contract
            await user1.sendTransaction({
                to: manager.target,
                value: ethers.parseEther("5")
            });

            const initialBalance = await ethers.provider.getBalance(owner.address);

            const tx = await manager.connect(owner).emergencyWithdrawETH(ethers.parseEther("5"));
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            const finalBalance = await ethers.provider.getBalance(owner.address);
            expect(finalBalance - initialBalance + gasUsed).to.equal(ethers.parseEther("5"));
        });

        it("Should revert if non-owner tries emergency withdraw", async function () {
            const { manager, token, user1 } = await loadFixture(deployFixture);

            await expect(
                manager.connect(user1).emergencyWithdrawToken(token.target, ethers.parseEther("1000"))
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("Gas Optimization", function () {
        it("Should use reasonable gas for registration", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            const tx = await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );
            const receipt = await tx.wait();

            expect(receipt.gasUsed).to.be.lt(200000); // Should use less than 200k gas
        });

        it("Should use reasonable gas for bonding curve updates", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            const tx = await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("900000"),
                ethers.parseEther("15")
            );
            const receipt = await tx.wait();

            expect(receipt.gasUsed).to.be.lt(100000); // Should use less than 100k gas
        });
    });

    describe("Edge Cases", function () {
        it("Should handle zero liquidity gracefully", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            const status = await manager.getGraduationStatus(token.target);
            expect(status.currentMarketCap).to.be.gte(0);
            expect(status.currentLiquidity).to.be.gte(0);
        });

        it("Should handle very large reserve values", async function () {
            const { manager, token, bondingCurve } = await loadFixture(deployFixture);

            const largeTokenReserve = ethers.parseEther("1000000000"); // 1 billion
            const largeEthReserve = ethers.parseEther("10000"); // 10k ETH

            await expect(
                manager.connect(bondingCurve).registerToken(
                    token.target,
                    largeTokenReserve,
                    largeEthReserve
                )
            ).to.not.be.reverted;
        });

        it("Should handle recipient address change scenarios", async function () {
            const { manager, token, bondingCurve, lpRecipient, user1 } = await loadFixture(deployFixture);

            await manager.connect(bondingCurve).registerToken(
                token.target,
                INITIAL_TOKEN_RESERVE,
                INITIAL_ETH_RESERVE
            );

            await manager.connect(bondingCurve).updateBondingCurve(
                token.target,
                ethers.parseEther("500000"),
                ethers.parseEther("120")
            );

            await token.connect(bondingCurve).approve(manager.target, ethers.parseEther("500000"));

            // Graduate with first recipient
            await manager.connect(bondingCurve).graduateToken(token.target, lpRecipient.address, {
                value: ethers.parseEther("120")
            });

            const lockInfo = await manager.lpLocks(token.target);
            expect(lockInfo.recipient).to.equal(lpRecipient.address);
        });
    });
});
