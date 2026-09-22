// src/savings.js
// Arc Earn Integration via Circle EarnKit (@circle-fin/earn-kit)
// Native DeFi vault discovery, deposit, yield accrual, and dev fee routing on Arc (Morpho Protocol)

const { EarnKit, KitError } = require("@circle-fin/earn-kit");
const { createEthersAdapterFromPrivateKey } = require("@circle-fin/adapter-ethers-v6");
const { Contract, JsonRpcProvider } = require("ethers");
const { getNetworkConfig } = require("./network");
const db = require("./db");
const walletLib = require("./wallet");

const PAYIT_FEE_FRACTION = 0.10; // PayIT keeps 10% of APY profit on withdrawal
const DEMO_SPEED = parseFloat(process.env.SAVINGS_DEMO_SPEED || "1");

let _earnKit = null;
function getEarnKit() {
  if (!_earnKit) _earnKit = new EarnKit();
  return _earnKit;
}

// Standard ERC-4626 Vault ABI for direct Arc EVM Morpho calls
const ERC4626_ABI = [
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

/**
 * Discover live yield vaults on Arc via Circle EarnKit.
 * Falls back to curated Arc Morpho vaults if offline or rate-limited.
 */
async function getYieldPools() {
  const net = getNetworkConfig();
  const chainName = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;

  try {
    const kit = getEarnKit();
    const res = await kit.exploreVaults({
      chain: chainName,
      sortBy: "apy",
      ...(apiKey ? { config: { apiKey } } : {}),
    });

    if (res?.vaults && res.vaults.length > 0) {
      const activeVaults = res.vaults
        .filter(v => v.status === "active" && (v.asset === "USDC" || v.asset === "EURC"))
        .slice(0, 5);

      if (activeVaults.length > 0) {
        return activeVaults.map(v => {
          const rawApy = (v.currentApy || v.nativeApy || 0.048) * 100;
          const vaultAddress = v.vaultAddress || v.address;
          return {
            symbol: v.asset,
            project: v.name || `${v.protocol || "Morpho"} Vault`,
            chain: net.name,
            vaultAddress,
            rawApy: parseFloat(rawApy.toFixed(2)),
            userApy: parseFloat((rawApy * (1 - PAYIT_FEE_FRACTION)).toFixed(2)),
            payitApy: parseFloat((rawApy * PAYIT_FEE_FRACTION).toFixed(2)),
            totalDeposits: v.totalDeposits || "0",
          };
        });
      }
    }
  } catch (err) {
    console.warn("[savings] EarnKit exploreVaults fallback:", err.message);
  }

  // Curated Arc Mainnet / Testnet Morpho vaults fallback
  return [
    {
      symbol: "USDC",
      project: "Steakhouse Prime USDC",
      chain: net.name,
      vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124",
      rawApy: 5.20,
      userApy: 4.68,
      payitApy: 0.52,
    },
    {
      symbol: "USDC",
      project: "Flowmark USDC Turbo",
      chain: net.name,
      vaultAddress: "0xbd69ce1b1027e932158aa96a873a91c41cb729f9",
      rawApy: 4.80,
      userApy: 4.32,
      payitApy: 0.48,
    },
    {
      symbol: "EURC",
      project: "Gauntlet EURC Prime",
      chain: net.name,
      vaultAddress: "0x85894c0b83e564bb44854bda5991b05ccf88831e",
      rawApy: 3.50,
      userApy: 3.15,
      payitApy: 0.35,
    },
  ];
}

/**
 * Format available Arc Earn vaults for the Telegram UI.
 */
function formatYieldList(pools) {
  const net = getNetworkConfig();
  const lines = pools.map((p, i) =>
    `${i + 1}. <b>${p.project}</b> (${p.symbol})\n` +
    `   Est. APY: <b>${p.userApy}%</b> (Vault: <code>${p.vaultAddress?.slice(0, 6)}...${p.vaultAddress?.slice(-4)}</code>)`
  ).join("\n\n");

  return (
    `📈 <b>Arc Earn Vaults (${net.name})</b>\n──────────────────────────\n` +
    `${lines}\n\n` +
    `Vaults are powered by Circle EarnKit and Morpho Protocol on Arc.\n` +
    `• Instant deposits & withdrawals anytime (no lockups).\n` +
    `• Funds idle > 2 hours can earn automatically.\n\n` +
    `Tap <b>Start Saving</b> to deposit funds into a vault.`
  );
}

/**
 * Open a savings position for a user in the database.
 */
function openYieldPosition(telegramId, amountUsdc, pool, options = {}) {
  db.openYieldPosition(telegramId, amountUsdc, pool, options);
}

/**
 * Calculate accrued yield for a user position.
 */
function calcAccruedYield(position) {
  const openedAt = new Date(position.opened_at).getTime();
  const elapsedMs = (Date.now() - openedAt) * DEMO_SPEED;
  const elapsedYears = elapsedMs / (1000 * 60 * 60 * 24 * 365);
  return position.amount_usdc * (position.apy / 100) * elapsedYears;
}

/**
 * Format position details for display in Telegram.
 */
function formatPosition(position) {
  const accrued = calcAccruedYield(position);
  const grossYield = position.apy > 0 ? (accrued / (1 - PAYIT_FEE_FRACTION)) : accrued;
  const estDevFee = grossYield * PAYIT_FEE_FRACTION;
  const netAccrued = grossYield - estDevFee;
  const vaultAddr = position.vault_address || position.vaultAddress || "—";
  const shortVault = vaultAddr.length > 12 ? `${vaultAddr.slice(0, 6)}...${vaultAddr.slice(-4)}` : vaultAddr;

  const autoBadge = position.is_auto_earn ? " <i>(🤖 Auto-Earn)</i>" : "";

  return (
    `📊 <b>Your Active Savings Position</b>${autoBadge}\n──────────────────────────\n` +
    `• <b>Principal:</b> $${position.amount_usdc.toFixed(2)} USDC\n` +
    `• <b>Vault:</b> ${position.project || "Arc Morpho Vault"} (<code>${shortVault}</code>)\n` +
    `• <b>Network:</b> ${position.chain || "Arc"}\n` +
    `• <b>APY:</b> ${position.apy}% per year\n` +
    `• <b>Started:</b> ${position.opened_at}\n` +
    `• <b>Accrued Interest:</b> +$${netAccrued.toFixed(4)} USDC\n` +
    `• <b>Current Value:</b> $${(position.amount_usdc + netAccrued).toFixed(4)} USDC\n\n` +
    `<i>Withdraw anytime to return your principal and interest. 10% dev fee applies only to accrued profits upon withdrawal.</i>`
  );
}

/**
 * Get pre-flight deposit quote from Arc EarnKit.
 */
async function getDepositQuote(privateKey, vaultAddress, amountUsdc) {
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const adapter = createEthersAdapterFromPrivateKey({ privateKey });
  const kit = getEarnKit();

  return await kit.getDepositQuote({
    from: { adapter, chain },
    vaultAddress,
    amount: String(amountUsdc),
  });
}

/**
 * Execute on-chain deposit into an Arc Earn vault.
 */
async function depositIntoVault(privateKey, vaultAddress, amountUsdc) {
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;
  const adapter = createEthersAdapterFromPrivateKey({ privateKey });
  const kit = getEarnKit();

  // Try EarnKit native deposit first
  try {
    const res = await kit.deposit({
      from: { adapter, chain },
      vaultAddress,
      amount: String(amountUsdc),
      ...(apiKey ? { config: { apiKey } } : {}),
    });
    return {
      success: true,
      hash: res?.hash || res?.txHash || null,
      txHash: res?.hash || res?.txHash || null,
      vaultAddress,
      amountUsdc,
    };
  } catch (kitErr) {
    console.warn("[savings:deposit] EarnKit deposit fallback to direct ERC-4626:", kitErr.message);
  }

  // Direct ERC-4626 fallback on Arc
  try {
    const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
    const userWallet = walletLib.walletFromPrivateKey(privateKey);
    const amountMicro = walletLib.parseToMicro(amountUsdc.toString());
    const vaultContract = new Contract(vaultAddress, ERC4626_ABI, userWallet);

    const assetAddress = await vaultContract.asset();
    const erc20Abi = [
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ];
    const assetContract = new Contract(assetAddress, erc20Abi, userWallet);
    const allowance = await assetContract.allowance(userWallet.address, vaultAddress);
    if (allowance < amountMicro) {
      const approveTx = await assetContract.approve(vaultAddress, amountMicro);
      await approveTx.wait();
    }

    const tx = await vaultContract.deposit(amountMicro, userWallet.address);
    const receipt = await tx.wait();
    return {
      success: true,
      hash: receipt?.hash || tx.hash,
      txHash: receipt?.hash || tx.hash,
      vaultAddress,
      amountUsdc,
    };
  } catch (contractErr) {
    console.warn("[savings:deposit] Direct ERC-4626 deposit note:", contractErr.message);
    return {
      success: false,
      error: contractErr.message,
      txHash: null,
      vaultAddress,
      amountUsdc,
    };
  }
}

/**
 * Execute on-chain withdrawal from an Arc Earn vault.
 */
async function withdrawFromVault(privateKey, vaultAddress, amountUsdc) {
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;
  const adapter = createEthersAdapterFromPrivateKey({ privateKey });
  const kit = getEarnKit();

  try {
    const res = await kit.withdraw({
      from: { adapter, chain },
      vaultAddress,
      amount: String(amountUsdc),
      ...(apiKey ? { config: { apiKey } } : {}),
    });
    return {
      success: true,
      hash: res?.hash || res?.txHash || null,
      txHash: res?.hash || res?.txHash || null,
      vaultAddress,
      amountUsdc,
    };
  } catch (kitErr) {
    console.warn("[savings:withdraw] EarnKit withdraw fallback to direct ERC-4626:", kitErr.message);
  }

  // Direct ERC-4626 fallback on Arc
  try {
    const userWallet = walletLib.walletFromPrivateKey(privateKey);
    const amountMicro = walletLib.parseToMicro(amountUsdc.toString());
    const vaultContract = new Contract(vaultAddress, ERC4626_ABI, userWallet);

    const tx = await vaultContract.withdraw(amountMicro, userWallet.address, userWallet.address);
    const receipt = await tx.wait();
    return {
      success: true,
      hash: receipt?.hash || tx.hash,
      txHash: receipt?.hash || tx.hash,
      vaultAddress,
      amountUsdc,
    };
  } catch (contractErr) {
    console.warn("[savings:withdraw] Direct ERC-4626 withdraw note:", contractErr.message);
    return {
      success: false,
      error: contractErr.message,
      txHash: null,
      vaultAddress,
      amountUsdc,
    };
  }
}

/**
 * Execute full withdrawal with on-chain Dev Fee routing.
 * Dev fee (10% of accrued yield profit) is deducted and routed to fee recipient.
 *
 * @param {object} params
 * @param {object} params.userWallet - User's ethers Wallet instance
 * @param {object} params.position - User's active yield position record from DB
 * @param {string} [params.feeRecipientAddress] - Dev fee recipient address
 * @returns {Promise<object>}
 */
async function withdrawFromVaultWithFee({ userWallet, position, feeRecipientAddress }) {
  if (!position) {
    throw new Error("No active savings position found");
  }

  const vaultAddress = position.vault_address || position.vaultAddress || "0xa8fd51b78370c7ca948566d7ba97d252bc325124";
  const feeTarget = feeRecipientAddress ||
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

  // Calculate yield and fee breakdown
  const grossYield = calcAccruedYield(position);
  const devFee = parseFloat((grossYield * PAYIT_FEE_FRACTION).toFixed(6));
  const netYield = parseFloat((grossYield - devFee).toFixed(6));
  const totalUserPayout = parseFloat((position.amount_usdc + netYield).toFixed(6));

  // 1. Withdraw principal + gross yield from vault back to user's wallet
  let withdrawRes = null;
  try {
    withdrawRes = await withdrawFromVault(userWallet.privateKey, vaultAddress, position.amount_usdc);
  } catch (err) {
    throw new Error(`Vault withdrawal failed: ${err.message}`);
  }

  if (!withdrawRes || !withdrawRes.success) {
    throw new Error(`Vault withdrawal failed: ${withdrawRes?.error || "Unknown error"}`);
  }

  const withdrawTxHash = withdrawRes.txHash || withdrawRes.hash || null;

  // 2. Route Dev Fee on-chain to project fee address
  let feeTxHash = null;
  if (devFee > 0.0001 && feeTarget && walletLib.isValidAddress(feeTarget)) {
    try {
      const devFeeMicro = walletLib.parseToMicro(devFee.toFixed(6));
      const feeTx = await walletLib.sendSponsoredOrDirectTransaction(userWallet, feeTarget, devFeeMicro);
      feeTxHash = feeTx.txHash;
    } catch (feeErr) {
      console.warn("[savings] Dev fee transfer note:", feeErr.message);
    }
  }

  // 3. Mark position closed in SQLite
  db.closeYieldPosition(userWallet.telegramId || position.telegram_id, totalUserPayout, {
    devFee,
    withdrawTxHash,
    feeTxHash,
    positionId: position.id,
    accountType: position.account_type || "personal",
  });

  return {
    success: true,
    principal: position.amount_usdc,
    principalUsdc: position.amount_usdc,
    grossYield,
    grossYieldUsdc: grossYield,
    netYield,
    netYieldUsdc: netYield,
    devFee,
    devFeeUsdc: devFee,
    totalUserPayout,
    netUserAmountUsdc: totalUserPayout,
    withdrawTxHash,
    feeTxHash,
  };
}

module.exports = {
  getEarnKit,
  getYieldPools,
  formatYieldList,
  openYieldPosition,
  calcAccruedYield,
  formatPosition,
  getDepositQuote,
  depositIntoVault,
  withdrawFromVault,
  withdrawFromVaultWithFee,
  PAYIT_FEE_FRACTION,
};
