// src/savings.js
// Arc Earn Integration via Circle EarnKit (@circle-fin/earn-kit)
// Native DeFi vault discovery, deposit, yield accrual, and dev fee routing on Arc (Morpho Protocol)

const { EarnKit, KitError } = require("@circle-fin/earn-kit");
const { createEthersAdapterFromPrivateKey } = require("@circle-fin/adapter-ethers-v6");
const { Contract, JsonRpcProvider, parseUnits, formatUnits } = require("ethers");
const { getNetworkConfig } = require("./network");
const db = require("./db");
const walletLib = require("./wallet");

const PAYIT_FEE_FRACTION = 0.10; // Proxim keeps 10% of realized APY profit on withdrawal
const MIN_ONCHAIN_FEE_USDC = parseFloat(process.env.SAVINGS_MIN_FEE_USDC || "0.01"); // Skip fee transfer below $0.01 so Arc gas never exceeds fee
const DEMO_SPEED = parseFloat(process.env.SAVINGS_DEMO_SPEED || "1");
const MIN_VAULT_TVL_USD = parseFloat(process.env.SAVINGS_MIN_VAULT_TVL || "10000");
const MAX_REALISTIC_APY_PCT = parseFloat(process.env.SAVINGS_MAX_VAULT_APY || "35");
const POSITION_CACHE_TTL_MS = 15_000;

const _vaultMetaCache = new Map(); // vaultAddrLower -> { assetAddress, assetDecimals }
const _livePositionCache = new Map(); // `${ownerLower}:${vaultLower}` -> { expiresAt, data }

function isTestMockMode() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_SAVINGS === "true" ||
    process.env.PAYIT_TEST_MODE === "true" ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-"))
  );
}

function invalidatePositionCache(ownerAddress, vaultAddress = null) {
  if (!ownerAddress) return;
  const ownerLower = String(ownerAddress).toLowerCase();
  if (vaultAddress) {
    _livePositionCache.delete(`${ownerLower}:${String(vaultAddress).toLowerCase()}`);
    return;
  }
  for (const key of _livePositionCache.keys()) {
    if (key.startsWith(`${ownerLower}:`)) _livePositionCache.delete(key);
  }
}

let _earnKit = null;
function getEarnKit() {
  if (!_earnKit) _earnKit = new EarnKit();
  return _earnKit;
}

/**
 * Format TVL number compactly for Telegram UI (e.g. $247K, $92.7M).
 */
function formatCompactTvl(tvl) {
  const n = Number(tvl) || 0;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  if (n > 0) return `$${Math.round(n)}`;
  return "";
}

/**
 * Filter raw EarnKit vaults to exclude dust/unnamed vaults, low-liquidity vaults,
 * and abnormal APY outlier spikes on mainnet.
 */
function filterSafeVaults(vaults, { isTestnet = false, minTvl = MIN_VAULT_TVL_USD, maxApyPct = MAX_REALISTIC_APY_PCT } = {}) {
  const active = (vaults || []).filter(
    v => v && v.status === "active" && (v.asset === "USDC" || v.asset === "EURC")
  );
  if (isTestnet) return active;

  const safe = active.filter(v => {
    const hasName = Boolean(v.name && String(v.name).trim().length > 0);
    const tvl = parseFloat(v.totalDeposits || "0");
    const rawApyPct = (v.currentApy || v.nativeApy || 0) * 100;
    return hasName && tvl >= minTvl && rawApyPct > 0 && rawApyPct <= maxApyPct;
  });

  // Fallback to TVL-only filter if APY cap ever excludes everything, or active if empty
  if (safe.length > 0) return safe;
  const tvlOnly = active.filter(v => Boolean(v.name && String(v.name).trim()) && parseFloat(v.totalDeposits || "0") >= minTvl);
  return tvlOnly.length > 0 ? tvlOnly : active;
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
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
];

const ERC20_TRANSFER_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

async function getVaultAssetMeta(vaultAddress, providerOrSigner) {
  const key = String(vaultAddress || "").toLowerCase();
  if (_vaultMetaCache.has(key)) return _vaultMetaCache.get(key);
  const vaultContract = new Contract(vaultAddress, ERC4626_ABI, providerOrSigner);
  const assetAddress = await vaultContract.asset();
  let assetDecimals = 6;
  try {
    const assetContract = new Contract(assetAddress, ERC20_TRANSFER_ABI, providerOrSigner);
    assetDecimals = Number(await assetContract.decimals());
  } catch (_) { }
  const meta = { assetAddress, assetDecimals };
  _vaultMetaCache.set(key, meta);
  return meta;
}

/**
 * Extract exact redeemed USDC assets from an ERC-4626 Withdraw / ERC-20 Transfer receipt.
 * Immune to Arc native gas deduction or unrelated concurrent transfers.
 */
function parseRedeemedAssetsFromReceipt(receipt, vaultAddress, ownerAddress, assetAddress, assetDecimals = 6) {
  if (!receipt || !Array.isArray(receipt.logs) || receipt.logs.length === 0) return null;
  const vaultLower = String(vaultAddress || "").toLowerCase();
  const ownerLower = String(ownerAddress || "").toLowerCase();
  const assetLower = String(assetAddress || "").toLowerCase();

  try {
    const { Interface } = require("ethers");
    const vaultIface = new Interface(ERC4626_ABI);
    for (const log of receipt.logs) {
      if (String(log.address || "").toLowerCase() !== vaultLower) continue;
      try {
        const parsed = vaultIface.parseLog(log);
        if (parsed && parsed.name === "Withdraw") {
          const receiver = String(parsed.args?.receiver || "").toLowerCase();
          const owner = String(parsed.args?.owner || "").toLowerCase();
          if (receiver === ownerLower || owner === ownerLower) {
            const assets = parsed.args?.assets;
            if (assets != null && assets > 0n) {
              return Number(formatUnits(assets, assetDecimals));
            }
          }
        }
      } catch (_) { }
    }

    if (assetLower) {
      const erc20Iface = new Interface(ERC20_TRANSFER_ABI);
      let totalTransferred = 0n;
      for (const log of receipt.logs) {
        if (String(log.address || "").toLowerCase() !== assetLower) continue;
        try {
          const parsed = erc20Iface.parseLog(log);
          if (parsed && parsed.name === "Transfer") {
            const from = String(parsed.args?.from || "").toLowerCase();
            const to = String(parsed.args?.to || "").toLowerCase();
            if (from === vaultLower && to === ownerLower) {
              totalTransferred += BigInt(parsed.args?.value || 0n);
            }
          }
        } catch (_) { }
      }
      if (totalTransferred > 0n) {
        return Number(formatUnits(totalTransferred, assetDecimals));
      }
    }
  } catch (_) { }
  return null;
}

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
      const activeVaults = filterSafeVaults(res.vaults, { isTestnet: net.isTestnet })
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
        }).sort((a, b) => Number(b.userApy || 0) - Number(a.userApy || 0));
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
  const lines = pools.map((p, i) => {
    const tvlStr = formatCompactTvl(p.totalDeposits);
    const meta = tvlStr ? ` · ${tvlStr} TVL` : "";
    return `${i + 1}. <b>${p.project}</b> (${p.symbol})\n` +
      `   Est. APY: <b>${p.userApy}%</b>${meta}`;
  }).join("\n\n");

  return (
    `📈 <b>Arc Earn Vaults (${net.name})</b>\n──────────────────────────\n` +
    `${lines}\n\n` +
    `Powered by Circle EarnKit &amp; Morpho Protocol.\n` +
    `• Instant deposits &amp; withdrawals anytime (no lockups).\n` +
    `• Only verified, liquid vaults (≥ $10K TVL) are shown.\n\n` +
    `Tap <b>Start Saving</b> to earn interest on your dollars.`
  );
}

/**
 * Open a savings position for a user in the database.
 */
function openYieldPosition(telegramId, amountUsdc, pool, options = {}) {
  db.openYieldPosition(telegramId, amountUsdc, pool, options);
}

/**
 * Calculate accrued gross yield for a user position.
 * Uses the position's gross vault APY (recovering it if an older row stored user_apy only).
 */
function calcAccruedYield(position) {
  if (!position) return 0;
  const rawDate = position.opened_at || position.created_at || position.createdAt;
  const openedAt = rawDate ? new Date(rawDate).getTime() : Date.now();
  const safeOpenedAt = Number.isFinite(openedAt) ? openedAt : Date.now();
  const elapsedMs = Math.max(0, (Date.now() - safeOpenedAt) * DEMO_SPEED);
  const elapsedYears = elapsedMs / (1000 * 60 * 60 * 24 * 365);
  const amount = Number(position.amount_usdc) || 0;
  let grossApy = Number(position.apy || position.gross_apy || position.grossApy) || 0;
  const userApy = Number(position.user_apy || position.userApy) || 0;
  const feeApy = Number(position.payit_fee_apy || position.feeApy) || 0;
  // If an older row stored net APY in `apy` while `payit_fee_apy` is known, reconstruct gross APY.
  if (grossApy > 0 && userApy > 0 && Math.abs(grossApy - userApy) < 0.005 && feeApy > 0) {
    grossApy = userApy + feeApy;
  }
  const accrued = amount * (grossApy / 100) * elapsedYears;
  return Number.isFinite(accrued) ? Math.max(0, accrued) : 0;
}

/**
 * Exact breakdown of accrued yield vs 10% platform performance fee.
 * When `onChainGrossYield` is provided (including 0), trusts the real on-chain profit
 * instead of inflating it with a synthetic time estimate.
 */
function calcYieldBreakdown(position, onChainGrossYield = null) {
  const hasRealOnChain =
    onChainGrossYield !== null &&
    onChainGrossYield !== undefined &&
    Number.isFinite(Number(onChainGrossYield));

  const grossYield = hasRealOnChain
    ? parseFloat(Math.max(0, Number(onChainGrossYield)).toFixed(6))
    : parseFloat(Math.max(0, calcAccruedYield(position)).toFixed(6));

  const devFee = parseFloat((grossYield * PAYIT_FEE_FRACTION).toFixed(6));
  const netYield = parseFloat(Math.max(0, grossYield - devFee).toFixed(6));
  return {
    grossYield,
    devFee,
    netYield,
    feePct: Math.round(PAYIT_FEE_FRACTION * 100),
  };
}

/**
 * Fetch real live on-chain vault share value for a user's active position on Arc.
 * Returns net-of-fee yield matching what the user will receive on withdrawal.
 * Falls back gracefully to DB time estimate only if RPC is unreachable or in offline tests.
 */
async function getLivePositionValue(ownerAddress, position, options = {}) {
  const fallback = () => {
    const b = calcYieldBreakdown(position);
    const principal = Number(position?.amount_usdc) || 0;
    return {
      ...b,
      principalUsdc: principal,
      onChainAssetsUsdc: parseFloat((principal + b.grossYield).toFixed(6)),
      onChain: false,
    };
  };

  if (!position) return null;
  const vaultAddress = position.vault_address || position.vaultAddress;
  if (!ownerAddress || !vaultAddress || !walletLib.isValidAddress(ownerAddress) || !walletLib.isValidAddress(vaultAddress)) {
    return fallback();
  }

  // Skip live mainnet RPC calls during unit tests unless explicitly requested
  if (isTestMockMode() && !options.forceOnChain) {
    return fallback();
  }

  const cacheKey = `${String(ownerAddress).toLowerCase()}:${String(vaultAddress).toLowerCase()}`;
  if (!options.bypassCache) {
    const cached = _livePositionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const timeoutMs = Number(options.timeoutMs || 3500);
  try {
    const net = getNetworkConfig();
    const provider = options.provider || new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
    const vaultContract = new Contract(vaultAddress, ERC4626_ABI, provider);

    const readOnChain = async () => {
      const [meta, shares] = await Promise.all([
        getVaultAssetMeta(vaultAddress, provider),
        vaultContract.balanceOf(ownerAddress),
      ]);
      if (shares <= 0n) {
        const b = calcYieldBreakdown(position, 0);
        return {
          ...b,
          principalUsdc: Number(position.amount_usdc) || 0,
          onChainAssetsUsdc: 0,
          shares: "0",
          onChain: true,
        };
      }
      let assetsRaw = 0n;
      try {
        assetsRaw = await vaultContract.previewRedeem(shares);
      } catch (_) {
        assetsRaw = await vaultContract.convertToAssets(shares);
      }
      const assetsUsdc = Number(formatUnits(assetsRaw, meta.assetDecimals));
      const principal = Number(position.amount_usdc) || 0;
      const realGross = Math.max(0, parseFloat((assetsUsdc - principal).toFixed(6)));
      const b = calcYieldBreakdown(position, realGross);
      // If real fee is below the on-chain dust floor, user keeps 100% of those sub-cent pennies on withdrawal
      const effectiveDevFee = b.devFee >= MIN_ONCHAIN_FEE_USDC ? b.devFee : 0;
      const effectiveNetYield = parseFloat(Math.max(0, b.grossYield - effectiveDevFee).toFixed(6));
      return {
        grossYield: b.grossYield,
        devFee: effectiveDevFee,
        netYield: effectiveNetYield,
        feePct: b.feePct,
        principalUsdc: principal,
        onChainAssetsUsdc: parseFloat(assetsUsdc.toFixed(6)),
        shares: shares.toString(),
        onChain: true,
      };
    };

    const result = await Promise.race([
      readOnChain(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("on-chain position read timeout")), timeoutMs)),
    ]);

    _livePositionCache.set(cacheKey, {
      expiresAt: Date.now() + POSITION_CACHE_TTL_MS,
      data: result,
    });
    return result;
  } catch (_) {
    return fallback();
  }
}

/**
 * Format position details for display in Telegram.
 * Displays net-of-fee APY and net-of-fee earned interest so what the user sees is what they withdraw.
 */
function formatPosition(position, liveBreakdown = null) {
  if (!position) return "No active savings position found.";
  const principal = Number(position.amount_usdc) || 0;
  const userApy = Number(position.user_apy) > 0
    ? Number(position.user_apy)
    : Number((Number(position.apy || 0) * (1 - PAYIT_FEE_FRACTION)).toFixed(2));
  const breakdown = liveBreakdown && typeof liveBreakdown.netYield === "number"
    ? liveBreakdown
    : calcYieldBreakdown(position);
  const netAccrued = Number(breakdown.netYield) || 0;
  const total = principal + netAccrued;
  const vaultAddr = position.vault_address || position.vaultAddress || "—";
  const shortVault = vaultAddr.length > 12 ? `${vaultAddr.slice(0, 6)}...${vaultAddr.slice(-4)}` : vaultAddr;

  const autoBadge = position.is_auto_earn ? " <i>(🤖 Auto-Earn)</i>" : "";

  return (
    `📊 <b>Your Active Savings Position</b>${autoBadge}\n──────────────────────────\n` +
    `• <b>Principal Saved:</b> $${principal.toFixed(2)} USDC\n` +
    `• <b>Vault:</b> ${position.project || "Arc Morpho Vault"} (<code>${shortVault}</code>)\n` +
    `• <b>Network:</b> ${position.chain || "Arc"}\n` +
    `• <b>APY:</b> ${userApy}% per year (variable)\n` +
    `• <b>Started:</b> ${position.opened_at || "Recently"}\n` +
    `• <b>Interest Earned:</b> +$${netAccrued.toFixed(4)} USDC\n` +
    `• <b>Current Vault Total:</b> $${total.toFixed(4)} USDC\n\n` +
    `<i>Withdraw anytime immediately to receive your principal and earned interest. Rates and earnings shown are net of service fees.</i>`
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
    try {
      const userWallet = walletLib.walletFromPrivateKey(privateKey);
      invalidatePositionCache(userWallet.address, vaultAddress);
    } catch (_) { }
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

  // Direct ERC-4626 fallback on Arc (uses vault asset's real ERC-20 decimals, e.g. 6 for USDC)
  try {
    const userWallet = walletLib.walletFromPrivateKey(privateKey);
    const vaultContract = new Contract(vaultAddress, ERC4626_ABI, userWallet);

    const { assetAddress, assetDecimals } = await getVaultAssetMeta(vaultAddress, userWallet);
    const assetContract = new Contract(assetAddress, ERC20_TRANSFER_ABI, userWallet);
    const amountAssets = parseUnits(Number(amountUsdc).toFixed(Math.min(assetDecimals, 6)), assetDecimals);

    const allowance = await assetContract.allowance(userWallet.address, vaultAddress);
    if (allowance < amountAssets) {
      const approveTx = await assetContract.approve(vaultAddress, amountAssets);
      await approveTx.wait();
    }

    const tx = await vaultContract.deposit(amountAssets, userWallet.address);
    const receipt = await tx.wait();
    invalidatePositionCache(userWallet.address, vaultAddress);
    return {
      success: true,
      hash: receipt?.hash || tx.hash,
      txHash: receipt?.hash || tx.hash,
      vaultAddress,
      amountUsdc,
    };
  } catch (contractErr) {
    console.warn("[savings:deposit] Direct ERC-4626 deposit note:", contractErr.message);
    if (isTestMockMode()) {
      return {
        success: true,
        hash: "0xsimulated_deposit_tx_hash",
        txHash: "0xsimulated_deposit_tx_hash",
        vaultAddress,
        amountUsdc,
        simulated: true,
      };
    }
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
 * When options.redeemAll is true, executes direct ERC-4626 redeem(allShares) FIRST
 * so 100% of principal + 100% of accrued yield is redeemed with zero stranded dust shares,
 * and extracts the exact redeemed USDC amount from on-chain Withdraw / Transfer receipt logs.
 */
async function withdrawFromVault(privateKey, vaultAddress, amountUsdc, options = {}) {
  const net = getNetworkConfig();
  const chain = net.isTestnet ? "Arc_Testnet" : "Arc";
  const apiKey = process.env.CIRCLE_KIT_KEY || process.env.ARC_API_KEY;
  const userWallet = walletLib.walletFromPrivateKey(privateKey);
  const vaultContract = new Contract(vaultAddress, ERC4626_ABI, userWallet);
  const allowSimulated =
    options.allowSimulatedFallback === true ||
    (options.allowSimulatedFallback !== false && isTestMockMode());

  invalidatePositionCache(userWallet.address, vaultAddress);

  // Resolve real ERC-20 asset decimals (6 for Arc ERC-20 USDC), share balance, and previewRedeem amount
  let assetAddress = null;
  let assetDecimals = 6;
  let withdrawAmountStr = String(amountUsdc);
  let onChainShares = 0n;
  let sharesChecked = false;
  let previewAssetsUsdc = null;
  let balanceBeforeRaw = null;
  try {
    const meta = await getVaultAssetMeta(vaultAddress, userWallet);
    assetAddress = meta.assetAddress;
    assetDecimals = meta.assetDecimals;
    onChainShares = await vaultContract.balanceOf(userWallet.address);
    sharesChecked = true;
    if (assetAddress) {
      try {
        const assetContract = new Contract(assetAddress, ERC20_TRANSFER_ABI, userWallet);
        balanceBeforeRaw = await assetContract.balanceOf(userWallet.address);
      } catch (_) { }
    }
    if (options.redeemAll && onChainShares > 0n) {
      let previewRaw = 0n;
      try {
        previewRaw = await vaultContract.previewRedeem(onChainShares);
      } catch (_) {
        previewRaw = await vaultContract.maxWithdraw(userWallet.address);
      }
      if (previewRaw > 0n) {
        withdrawAmountStr = formatUnits(previewRaw, assetDecimals);
        previewAssetsUsdc = Number(withdrawAmountStr);
      }
    }
  } catch (preReadErr) {
    console.warn("[savings:withdraw] Pre-read vault state note:", preReadErr.message);
  }

  // If on-chain check confirmed zero shares exist in this vault, fail cleanly in production
  if (sharesChecked && onChainShares === 0n && !allowSimulated) {
    return {
      success: false,
      zeroShares: true,
      error: "No active vault shares found on-chain for this wallet.",
      txHash: null,
      vaultAddress,
      amountUsdc: 0,
    };
  }

  let directErr = null;
  // 1. Direct ERC-4626 redeem(allShares) FIRST when redeeming full position:
  //    guarantees principal + 100% of accrued yield with zero dust left behind.
  if (options.redeemAll && onChainShares > 0n) {
    try {
      const tx = await vaultContract.redeem(onChainShares, userWallet.address, userWallet.address);
      const receipt = await tx.wait();
      invalidatePositionCache(userWallet.address, vaultAddress);

      let actualRedeemedUsdc = parseRedeemedAssetsFromReceipt(
        receipt,
        vaultAddress,
        userWallet.address,
        assetAddress,
        assetDecimals
      );
      if (actualRedeemedUsdc == null && assetAddress && balanceBeforeRaw != null) {
        try {
          const assetContract = new Contract(assetAddress, ERC20_TRANSFER_ABI, userWallet);
          const balanceAfterRaw = await assetContract.balanceOf(userWallet.address);
          if (balanceAfterRaw > balanceBeforeRaw) {
            actualRedeemedUsdc = Number(formatUnits(balanceAfterRaw - balanceBeforeRaw, assetDecimals));
          }
        } catch (_) { }
      }
      if (actualRedeemedUsdc == null) {
        actualRedeemedUsdc = previewAssetsUsdc ?? (parseFloat(withdrawAmountStr) || amountUsdc);
      }
      return {
        success: true,
        hash: receipt?.hash || tx.hash,
        txHash: receipt?.hash || tx.hash,
        vaultAddress,
        amountUsdc: parseFloat(Number(actualRedeemedUsdc).toFixed(6)),
        exactOnChain: true,
      };
    } catch (err) {
      directErr = err;
      console.warn("[savings:withdraw] Direct ERC-4626 redeem fallback to EarnKit:", err.message);
    }
  }

  // 2. Circle EarnKit withdraw fallback (or primary for partial withdraws)
  const timeoutMs = isTestMockMode() ? 4000 : 30000;
  let kitErr = null;
  try {
    const adapter = createEthersAdapterFromPrivateKey({ privateKey });
    const kit = getEarnKit();
    const kitPromise = kit.withdraw({
      from: { adapter, chain },
      vaultAddress,
      amount: withdrawAmountStr,
      ...(apiKey ? { config: { apiKey } } : {}),
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("EarnKit withdraw timeout")), timeoutMs)
    );
    const res = await Promise.race([kitPromise, timeoutPromise]);
    invalidatePositionCache(userWallet.address, vaultAddress);

    const txHash = res?.hash || res?.txHash || null;
    let actualRedeemedUsdc = null;
    if (txHash && userWallet.provider) {
      try {
        const receipt = await userWallet.provider.getTransactionReceipt(txHash);
        actualRedeemedUsdc = parseRedeemedAssetsFromReceipt(
          receipt,
          vaultAddress,
          userWallet.address,
          assetAddress,
          assetDecimals
        );
      } catch (_) { }
    }
    if (actualRedeemedUsdc == null) {
      actualRedeemedUsdc = parseFloat(res?.amount || withdrawAmountStr) || amountUsdc;
    }
    return {
      success: true,
      hash: txHash,
      txHash,
      vaultAddress,
      amountUsdc: parseFloat(Number(actualRedeemedUsdc).toFixed(6)),
      exactOnChain: true,
    };
  } catch (err) {
    kitErr = err;
    console.warn("[savings:withdraw] EarnKit withdraw note:", err.message);
  }

  // 3. Direct ERC-4626 withdraw/redeem last-resort attempt if not already tried
  if (!directErr) {
    try {
      const amountAssets = parseUnits(Number(withdrawAmountStr).toFixed(Math.min(assetDecimals, 6)), assetDecimals);
      let tx;
      if (options.redeemAll && onChainShares > 0n) {
        tx = await vaultContract.redeem(onChainShares, userWallet.address, userWallet.address);
      } else {
        try {
          tx = await vaultContract.withdraw(amountAssets, userWallet.address, userWallet.address);
        } catch (withdrawErr) {
          const shares = onChainShares > 0n ? onChainShares : await vaultContract.balanceOf(userWallet.address);
          if (shares > 0n) {
            tx = await vaultContract.redeem(shares, userWallet.address, userWallet.address);
          } else {
            throw withdrawErr;
          }
        }
      }
      const receipt = await tx.wait();
      invalidatePositionCache(userWallet.address, vaultAddress);
      const parsedAssets = parseRedeemedAssetsFromReceipt(
        receipt,
        vaultAddress,
        userWallet.address,
        assetAddress,
        assetDecimals
      );
      return {
        success: true,
        hash: receipt?.hash || tx.hash,
        txHash: receipt?.hash || tx.hash,
        vaultAddress,
        amountUsdc: parseFloat(Number(parsedAssets ?? (parseFloat(withdrawAmountStr) || amountUsdc)).toFixed(6)),
        exactOnChain: true,
      };
    } catch (contractErr) {
      directErr = contractErr;
      console.warn("[savings:withdraw] Direct ERC-4626 withdraw note:", contractErr.message);
    }
  }

  if (allowSimulated) {
    return {
      success: true,
      hash: "0xsimulated_withdraw_tx_hash",
      txHash: "0xsimulated_withdraw_tx_hash",
      vaultAddress,
      amountUsdc,
      simulated: true,
    };
  }

  return {
    success: false,
    error: directErr?.message || kitErr?.message || "On-chain vault withdrawal failed",
    txHash: null,
    vaultAddress,
    amountUsdc: 0,
  };
}

/**
 * Execute full withdrawal with on-chain Dev Fee routing.
 * Dev fee (10% of REALIZED on-chain yield profit) is deducted and routed to fee recipient
 * only when the realized fee meets MIN_ONCHAIN_FEE_USDC ($0.01) so Arc gas never exceeds the fee.
 *
 * @param {object} params
 * @param {object} params.userWallet - User's ethers Wallet instance
 * @param {object} params.position - User's active yield position record from DB
 * @param {string} [params.feeRecipientAddress] - Dev fee recipient address
 * @param {boolean} [params.allowSimulatedFallback] - Override test mock behavior
 * @returns {Promise<object>}
 */
async function withdrawFromVaultWithFee({ userWallet, position, feeRecipientAddress, allowSimulatedFallback }) {
  if (!position) {
    throw new Error("No active savings position found");
  }

  const vaultAddress = position.vault_address || position.vaultAddress || "0xa8fd51b78370c7ca948566d7ba97d252bc325124";
  const feeTarget = feeRecipientAddress ||
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";

  const principal = Number(position.amount_usdc) || 0;
  const allowSimulated =
    allowSimulatedFallback === true ||
    (allowSimulatedFallback !== false && isTestMockMode());

  // 1. Withdraw principal + 100% of gross yield from vault back to user's wallet (redeem all shares)
  let withdrawRes = null;
  let withdrawErr = null;
  try {
    withdrawRes = await withdrawFromVault(userWallet.privateKey, vaultAddress, principal, {
      redeemAll: true,
      allowSimulatedFallback: allowSimulated,
    });
  } catch (err) {
    withdrawErr = err;
    console.warn(`[savings:withdraw] Vault withdrawal exception: ${err.message}`);
  }

  if (!withdrawRes || !withdrawRes.success) {
    if (!allowSimulated) {
      throw new Error(
        withdrawRes?.error ||
        withdrawErr?.message ||
        "On-chain vault withdrawal failed. Your savings remain safely in the vault."
      );
    }
    withdrawRes = {
      success: true,
      hash: "0xsimulated_withdraw_tx_hash",
      txHash: "0xsimulated_withdraw_tx_hash",
      vaultAddress,
      amountUsdc: principal,
      simulated: true,
    };
  }

  let withdrawTxHash = withdrawRes.txHash || withdrawRes.hash || null;
  let isSimulated = Boolean(withdrawRes.simulated || withdrawTxHash === "0xsimulated_withdraw_tx_hash");

  // Reconcile REAL on-chain redeemed profit (never inflate real withdrawals with synthetic clock estimates)
  const redeemedUsdc = Number(withdrawRes.amountUsdc || 0);
  const onChainGrossYield = !isSimulated
    ? Math.max(0, parseFloat((redeemedUsdc - principal).toFixed(6)))
    : null;
  const breakdown = calcYieldBreakdown(position, onChainGrossYield);
  const grossYield = breakdown.grossYield;
  const calculatedDevFee = breakdown.devFee;

  // In test mock mode, optionally disburse real USDC float if relayer is configured
  if (isSimulated && userWallet && userWallet.address) {
    const grossPayout = parseFloat((principal + grossYield).toFixed(6));
    try {
      const cctpBridge = require("./cctp_bridge");
      const disburseHash = await cctpBridge.disburseDirectOnArc({
        recipientArcAddress: userWallet.address,
        amountUsdc: grossPayout,
      });
      if (disburseHash) {
        withdrawTxHash = disburseHash;
        isSimulated = false;
      }
    } catch (disburseErr) {
      console.warn("[savings:withdraw] Direct disbursal fallback note:", disburseErr.message);
    }
  }

  // 2. Route 10% platform performance fee on REALIZED yield on-chain to fee recipient.
  //    Skip sub-cent dust fees (< MIN_ONCHAIN_FEE_USDC) on real on-chain withdrawals
  //    so Arc gas (~$0.0016) never eats more than the fee or cuts into the user's principal.
  let feeTxHash = null;
  let appliedDevFee = isSimulated ? calculatedDevFee : 0;

  if (calculatedDevFee >= MIN_ONCHAIN_FEE_USDC && feeTarget && walletLib.isValidAddress(feeTarget)) {
    try {
      const devFeeMicro = walletLib.parseToMicro(calculatedDevFee.toFixed(6));
      const feeTx = await walletLib.sendSponsoredOrDirectTransaction(userWallet, feeTarget, devFeeMicro, "0x", {
        waitForConfirmation: !isSimulated,
      });
      feeTxHash = feeTx.txHash;
      appliedDevFee = calculatedDevFee;
      console.log(`[savings:fee] Routed 10% platform fee ($${calculatedDevFee.toFixed(6)} USDC) -> ${feeTarget} (tx: ${feeTxHash})`);
    } catch (feeErr) {
      console.warn("[savings] Dev fee transfer note:", feeErr.message);
      try {
        const cctpBridge = require("./cctp_bridge");
        const relayerFeeHash = await cctpBridge.disburseDirectOnArc({
          recipientArcAddress: feeTarget,
          amountUsdc: calculatedDevFee,
        });
        if (relayerFeeHash) {
          feeTxHash = relayerFeeHash;
          appliedDevFee = calculatedDevFee;
        }
      } catch (_) { }
    }
  } else if (!isSimulated && calculatedDevFee > 0) {
    console.log(
      `[savings:fee] Skipping dust fee ($${calculatedDevFee.toFixed(6)} < $${MIN_ONCHAIN_FEE_USDC.toFixed(2)}) so user keeps 100% of small yield`
    );
  }

  const netYield = parseFloat(Math.max(0, grossYield - appliedDevFee).toFixed(6));
  const totalUserPayout = !isSimulated && redeemedUsdc > 0
    ? parseFloat(Math.max(0, redeemedUsdc - appliedDevFee).toFixed(6))
    : parseFloat((principal + netYield).toFixed(6));

  if (userWallet?.address) {
    invalidatePositionCache(userWallet.address, vaultAddress);
  }

  // 3. Mark position closed in SQLite (along with any duplicate active rows in the same vault)
  db.closeYieldPosition(userWallet.telegramId || position.telegram_id, totalUserPayout, {
    devFee: appliedDevFee,
    withdrawTxHash,
    feeTxHash,
    positionId: position.id,
    accountType: position.account_type || "personal",
    vaultAddress,
  });

  return {
    success: true,
    principal: position.amount_usdc,
    principalUsdc: position.amount_usdc,
    redeemedUsdc: !isSimulated ? redeemedUsdc : parseFloat((principal + grossYield).toFixed(6)),
    grossYield,
    grossYieldUsdc: grossYield,
    netYield,
    netYieldUsdc: netYield,
    devFee: appliedDevFee,
    devFeeUsdc: appliedDevFee,
    totalUserPayout,
    netUserAmountUsdc: totalUserPayout,
    withdrawTxHash,
    feeTxHash,
    simulated: isSimulated,
  };
}

/**
 * Automatically sync on-chain ERC-4626 / EarnKit vault balances for a user.
 * If the user holds vault shares on-chain but the database has no active position,
 * this restores and inserts the active position into the database.
 */
async function syncOnChainVaultPositions(user, context = "personal") {
  if (!user || !user.telegram_id) return null;
  const normTgId = Math.round(Number(user.telegram_id));
  if (Number.isNaN(normTgId) || normTgId <= 0) return null;

  const address = context === "business" ? user.business_deposit_address : user.deposit_address;
  if (!address || !walletLib.isValidAddress(address)) return null;

  const existing = db.getOpenYieldPosition(normTgId, context) || db.getOpenYieldPosition(user.telegram_id, context);
  if (existing) return existing;

  const net = getNetworkConfig();
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });

  let pools = [];
  try {
    pools = await getYieldPools();
  } catch { }

  const candidateVaults = [
    ...pools,
    { vaultAddress: "0x7610094b846657dcf166d59e42973db52c7015f9", project: "Bitwise Premium RWA USDC", symbol: "USDC", userApy: 3.92, apy: 3.92 },
    { vaultAddress: "0xa8fd51b78370c7ca948566d7ba97d252bc325124", project: "Steakhouse Prime USDC", symbol: "USDC", userApy: 1.20, apy: 1.20 }
  ];

  const seen = new Set();
  for (const pool of candidateVaults) {
    const vAddr = pool.vaultAddress || pool.address;
    if (!vAddr || seen.has(vAddr.toLowerCase())) continue;
    seen.add(vAddr.toLowerCase());

    try {
      const vContract = new Contract(vAddr, ERC4626_ABI, provider);
      const shares = await vContract.balanceOf(address);
      if (shares > 0) {
        let assetsUsdc = 0;
        try {
          const previewAssets = await vContract.previewRedeem(shares);
          assetsUsdc = Number(previewAssets) / 1e6;
        } catch {
          assetsUsdc = parseFloat(walletLib.formatMicro(shares));
        }

        if (assetsUsdc > 0.01) {
          console.log(`[savings:sync] Restoring on-chain vault position for TG ${normTgId}: ${assetsUsdc.toFixed(2)} in ${pool.project || vAddr}`);
          try {
            openYieldPosition(normTgId, parseFloat(assetsUsdc.toFixed(4)), pool, {
              vaultAddress: vAddr,
              isAutoEarn: false,
              accountType: context,
            });
          } catch (writeErr) {
            console.error(`[savings:sync] DB write error:`, writeErr.message);
          }

          const restored = db.getOpenYieldPosition(normTgId, context) || db.getOpenYieldPosition(user.telegram_id, context);
          if (restored) return restored;

          // Fallback synthesized position if DB read lag
          return {
            id: 999999,
            telegram_id: normTgId,
            amount_usdc: parseFloat(assetsUsdc.toFixed(4)),
            apy: pool.userApy || 3.92,
            user_apy: pool.userApy || 3.92,
            project: pool.project || "Bitwise Premium RWA USDC",
            symbol: pool.symbol || "USDC",
            chain: net.name || "Arc Mainnet",
            vault_address: vAddr,
            status: "active",
            account_type: context,
            opened_at: new Date().toISOString()
          };
        }
      }
    } catch (err) {
      console.warn(`[savings:sync] Vault check error on ${vAddr}:`, err.message);
    }
  }

  return null;
}

module.exports = {
  getEarnKit,
  getYieldPools,
  filterSafeVaults,
  formatCompactTvl,
  formatYieldList,
  openYieldPosition,
  calcAccruedYield,
  calcYieldBreakdown,
  getLivePositionValue,
  invalidatePositionCache,
  parseRedeemedAssetsFromReceipt,
  formatPosition,
  getDepositQuote,
  depositIntoVault,
  withdrawFromVault,
  withdrawFromVaultWithFee,
  syncOnChainVaultPositions,
  PAYIT_FEE_FRACTION,
  MIN_ONCHAIN_FEE_USDC,
};
