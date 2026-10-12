// src/api_keys.js
// Proxim Builder API Keys Core Module
// Enables third-party developers to access 100% of Proxim capabilities
// with granular customizable feature permissions.

const crypto = require("node:crypto");
const db = require("./db");

const AVAILABLE_FEATURES = {
  all: {
    id: "all",
    name: "🌟 Full Access (100% Proxim)",
    description: "Unrestricted access to all Proxim APIs and features.",
  },
  wallets: {
    id: "wallets",
    name: "👛 Multichain Wallets",
    description: "Create customer wallets, get addresses across Arc/Base/Solana/NEAR, check balances.",
  },
  transfers: {
    id: "transfers",
    name: "💸 Instant Transfers",
    description: "Send USDC and tokens directly on Arc Mainnet with instant finality.",
  },
  invoices: {
    id: "invoices",
    name: "🧾 Invoicing & Checkout",
    description: "Create SME/personal invoices, track status, generate payment QR codes.",
  },
  onramp: {
    id: "onramp",
    name: "🇳🇬 Naira Onramp",
    description: "Generate dynamic Nigerian virtual bank accounts for instant fiat funding.",
  },
  offramp: {
    id: "offramp",
    name: "🏦 Naira Offramp",
    description: "Withdraw USDC to Nigerian bank accounts at live exchange rates.",
  },
  crypto_deposits: {
    id: "crypto_deposits",
    name: "🌐 Multi-Chain EVM Deposits",
    description: "Deposit addresses for Ethereum, Base, Arbitrum, Polygon, Avalanche & auto-sweep.",
  },
  near_intents: {
    id: "near_intents",
    name: "🏹 NEAR Intents & Robinhood Chain",
    description: "Cross-chain swaps across NEAR tokens, Solana tokens, and Robinhood Chain (USDG, ETH, etc.).",
  },
  bridge: {
    id: "bridge",
    name: "🌉 CCTP Cross-Chain Bridge",
    description: "Bridge native USDC between Arc and Solana / EVM networks.",
  },
  savings: {
    id: "savings",
    name: "📈 Savings & Yield Vaults",
    description: "Deposit USDC into savings vaults, earn automated yield, and withdraw anytime.",
  },
  receipts: {
    id: "receipts",
    name: "🧾 Proof & Receipts",
    description: "Generate cryptographic payment receipts and downloadable receipt PNG cards.",
  },
};

// In-memory rate limiting tracker (sliding 60-second window)
const _rateLimits = new Map();

function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey).trim()).digest("hex");
}

/**
 * Generate a new API Key for a builder.
 *
 * @param {object} params
 * @param {number|string} [params.telegramId=0]
 * @param {string} params.appName
 * @param {string[]} [params.features=["all"]]
 * @param {number} [params.rateLimitPerMin=120]
 * @param {string} [params.webhookUrl]
 * @returns {object} { keyId, secretKey, appName, allowedFeatures, keyPrefix, createdAt }
 */
function generateApiKey({
  telegramId = 0,
  appName,
  features = ["all"],
  rateLimitPerMin = 120,
  webhookUrl = null,
}) {
  if (!appName || typeof appName !== "string" || !appName.trim()) {
    throw new Error("appName is required to generate an API key");
  }

  const cleanAppName = appName.trim();
  const rawRandom = crypto.randomBytes(24).toString("hex");
  const secretKey = `prx_live_${rawRandom}`;
  const keyId = `key_${rawRandom.slice(0, 12)}`;
  const keyPrefix = secretKey.slice(0, 16) + "...";
  const keyHash = hashApiKey(secretKey);

  let normalizedFeatures = Array.isArray(features) ? features : [features];
  if (normalizedFeatures.length === 0) normalizedFeatures = ["all"];

  // Validate feature names
  for (const f of normalizedFeatures) {
    if (!AVAILABLE_FEATURES[f]) {
      throw new Error(`Unknown feature "${f}". Available features: ${Object.keys(AVAILABLE_FEATURES).join(", ")}`);
    }
  }

  const row = db.createApiKey({
    keyId,
    keyHash,
    keyPrefix,
    telegramId: Number(telegramId) || 0,
    appName: cleanAppName,
    allowedFeatures: normalizedFeatures,
    rateLimitPerMin: Number(rateLimitPerMin) || 120,
    webhookUrl: webhookUrl || null,
  });

  return {
    keyId: row.key_id,
    secretKey, // ONLY returned once upon creation!
    appName: row.app_name,
    allowedFeatures: row.allowed_features,
    rateLimitPerMin: row.rate_limit_per_min,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
  };
}

/**
 * Verify an API key and validate permission for a specific feature.
 *
 * @param {string} rawKey - The Bearer token or X-API-Key string
 * @param {string} [requiredFeature=null] - The required feature (e.g. "wallets", "invoices", "near_intents")
 * @returns {{ valid: boolean, key?: object, code?: number, error?: string }}
 */
function verifyApiKey(rawKey, requiredFeature = null) {
  if (!rawKey || typeof rawKey !== "string") {
    return { valid: false, code: 401, error: "Missing API Key. Include 'Authorization: Bearer prx_live_...' or 'X-API-Key: prx_live_...'" };
  }

  const key = rawKey.trim().replace(/^Bearer\s+/i, "").trim();
  if (!key.startsWith("prx_live_") && !key.startsWith("prx_test_")) {
    return { valid: false, code: 401, error: "Invalid API key format. Proxim API keys start with 'prx_live_'" };
  }

  const keyHash = hashApiKey(key);
  const record = db.getApiKeyByHash(keyHash);

  if (!record || !record.is_active) {
    return { valid: false, code: 401, error: "API key is invalid or has been revoked" };
  }

  // Feature permission check:
  // If allowed_features includes "all", builder has 100% full access.
  // Otherwise, must match the specific requiredFeature.
  if (requiredFeature && requiredFeature !== "all") {
    const hasPermission =
      record.allowed_features.includes("all") ||
      record.allowed_features.includes(requiredFeature);

    if (!hasPermission) {
      return {
        valid: false,
        code: 403,
        error: `Feature '${requiredFeature}' is not enabled for this API key. Current enabled features: [${record.allowed_features.join(", ")}]. You can customize your allowed features in the Proxim Developer Portal.`,
        key: record,
      };
    }
  }

  // Rate limiting check
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = record.rate_limit_per_min || 120;
  const history = _rateLimits.get(record.key_id) || [];
  const recentHistory = history.filter((ts) => now - ts < windowMs);

  if (recentHistory.length >= limit) {
    return {
      valid: false,
      code: 429,
      error: `Rate limit of ${limit} requests per minute exceeded. Please wait before retrying.`,
      key: record,
    };
  }

  recentHistory.push(now);
  _rateLimits.set(record.key_id, recentHistory);

  // Record last used timestamp
  db.recordApiKeyUsage(record.key_id);

  return { valid: true, key: record };
}

/**
 * List all API keys for a developer.
 */
function listApiKeys(telegramId) {
  return db.getApiKeysByTelegramId(telegramId);
}

/**
 * Update allowed features on an existing API key.
 */
function updateApiKeyFeatures(keyId, features, telegramId = null) {
  const existing = db.getApiKeyById(keyId);
  if (!existing) throw new Error("API key not found");
  if (telegramId !== null && existing.telegram_id !== Number(telegramId)) {
    throw new Error("Unauthorized to modify this API key");
  }

  let normalizedFeatures = Array.isArray(features) ? features : [features];
  if (normalizedFeatures.length === 0) normalizedFeatures = ["all"];

  for (const f of normalizedFeatures) {
    if (!AVAILABLE_FEATURES[f]) {
      throw new Error(`Unknown feature "${f}".`);
    }
  }

  return db.updateApiKey(keyId, { allowed_features: normalizedFeatures });
}

/**
 * Revoke an API key.
 */
function revokeApiKey(keyId, telegramId = null) {
  return db.revokeApiKey(keyId, telegramId);
}

module.exports = {
  AVAILABLE_FEATURES,
  hashApiKey,
  generateApiKey,
  verifyApiKey,
  listApiKeys,
  updateApiKeyFeatures,
  revokeApiKey,
};
