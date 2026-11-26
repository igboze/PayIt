// src/airbills.js
// Airbills Business Gateway Integration (https://developer.airbills.org/)
// Supports all 6 Nigerian bill categories settled in USDC on Solana Mainnet:
//   100 — Airtime (MTN, Glo, 9mobile, Airtel)
//   101 — Electricity (Prepaid / Postpaid + live meter validation)
//   102 — Internet Data Bundles
//   103 — Betting Account Top-Up
//   104 — Cable TV (DStv, GOtv, Startimes)
//   105 — Transport (Cowry Card, BRT, etc.)
//
// Zero-Float Architecture:
//   - Uses each user's permanent default Solana wallet (derived from their EVM key)
//   - One-time on-demand Solana wallet activation (creates USDC ATA + drips 0.0005 SOL gas)
//   - Fast path if user already holds USDC on Solana; otherwise CCTP bridges Arc -> user's Solana ATA
//   - Calls Airbills `payWith: "default"`, signs `transactionIx` with user's Solana keypair,
//     and calls `/transact/process` for instant fulfillment.

const axios = require("axios");
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const db = require("./db");
const walletLib = require("./wallet");
const multichain = require("./multichain");
const idempotency = require("./idempotency");
const fraudGuard = require("./fraud_guard");
const cctpBridge = require("./cctp_bridge");
const fx = require("./fx");

const PRODUCTS = {
  AIRTIME:     { code: "100", category: "airtime",     label: "Airtime",       emoji: "📱", minNgn: 50,   maxNgn: 50000 },
  ELECTRICITY: { code: "101", category: "electricity", label: "Electricity",   emoji: "⚡", minNgn: 2000, maxNgn: 500000 },
  DATA:        { code: "102", category: "data",        label: "Internet Data", emoji: "📶", minNgn: 50,   maxNgn: 200000 },
  BETTING:     { code: "103", category: "betting",     label: "Betting",       emoji: "🎰", minNgn: 1000, maxNgn: 100000 },
  CABLE:       { code: "104", category: "cable",       label: "Cable TV",      emoji: "📺", minNgn: 500,  maxNgn: 200000 },
  TRANSPORT:   { code: "105", category: "transport",   label: "Transport",     emoji: "🚌", minNgn: 100,  maxNgn: 100000 },
};

const NETWORKS = [
  { id: "01", name: "MTN",     emoji: "🟡" },
  { id: "02", name: "Glo",     emoji: "🟢" },
  { id: "03", name: "9mobile", emoji: "🌿" },
  { id: "04", name: "Airtel",  emoji: "🔴" },
];

// Solana 0-byte account rent-exemption is 890,880 lamports (~0.000891 SOL).
// Dripping 0.001 SOL (1,000,000 lamports) satisfies rent-exemption + leaves ~20+ tx fees.
const USER_SOL_MIN_LAMPORTS  = 950_000;   // 0.00095 SOL threshold (rent-exempt + gas buffer)
const USER_SOL_DRIP_LAMPORTS = 1_000_000; // 0.001 SOL (~$0.14) one-time top-up

function getBaseUrl() {
  return (process.env.AIRBILLS_BASE_URL || "https://api.airbills.org/api/vendor/gateway").replace(/\/$/, "");
}

function getSecretKey() {
  return process.env.AIRBILLS_SECRET_KEY || process.env.AIRBILLS_API_KEY || "";
}

function isConfigured() {
  return Boolean(getSecretKey());
}

function getHeaders() {
  const key = getSecretKey();
  if (!key) {
    throw new Error("Airbills API is not configured yet (missing AIRBILLS_SECRET_KEY).");
  }
  return {
    "Content-Type": "application/json",
    secretkey: key,
  };
}

function getSolanaConnection() {
  // Same connection (with failover) as the rest of the app, so a refused RPC key
  // can't block bill payments.
  if (typeof multichain.getSolanaConnection === "function") return multichain.getSolanaConnection();
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

function parseAirbillsError(resData, fallback = "Airbills request failed") {
  const status = String(resData?.status || "");
  const msg = resData?.message || resData?.error || fallback;
  if (status === "03") return "Airbills authentication failed (invalid secretkey).";
  if (status === "04") return `Invalid bill details: ${msg}`;
  return msg;
}

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _catalogCache = new Map();

async function apiGet(path, params = undefined, { cacheKey = null } = {}) {
  if (cacheKey) {
    const cached = _catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
      return cached.data;
    }
  }
  try {
    const res = await axios.get(`${getBaseUrl()}${path}`, {
      headers: getHeaders(),
      params,
      timeout: 30000,
    });
    const body = res.data;
    if (body?.status && body.status !== "00") {
      throw new Error(parseAirbillsError(body));
    }
    const result = body?.data !== undefined ? body.data : body;
    if (cacheKey) {
      _catalogCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    }
    return result;
  } catch (err) {
    if (err.response?.data) {
      throw new Error(parseAirbillsError(err.response.data, err.message));
    }
    throw err;
  }
}

async function apiPost(path, payload) {
  try {
    const res = await axios.post(`${getBaseUrl()}${path}`, payload, {
      headers: getHeaders(),
      timeout: 30000,
    });
    const body = res.data;
    // "00" = success, "06" = already processed (idempotent success on /transact/process)
    if (body?.status && body.status !== "00" && body.status !== "06") {
      throw new Error(parseAirbillsError(body));
    }
    return body;
  } catch (err) {
    if (err.response?.data) {
      throw new Error(parseAirbillsError(err.response.data, err.message));
    }
    throw err;
  }
}

// ─── Catalog & Validation Endpoints ───────────────────────────────────────────

let _cachedUsdcNgnRate = { rate: null, fetchedAt: 0 };

async function getAirbillsTokens() {
  const data = await apiGet("/tokens");
  return Array.isArray(data) ? data : [];
}

async function getAirbillsUsdcRate() {
  const now = Date.now();
  if (_cachedUsdcNgnRate.rate && now - _cachedUsdcNgnRate.fetchedAt < 5 * 60 * 1000) {
    return _cachedUsdcNgnRate.rate;
  }
  try {
    const tokens = await getAirbillsTokens();
    const usdc = tokens.find(t => String(t.token || "").toUpperCase() === "USDC");
    const ngnRate = Number(usdc?.ngn);
    if (ngnRate && ngnRate > 0) {
      _cachedUsdcNgnRate = { rate: ngnRate, fetchedAt: now };
      return ngnRate;
    }
  } catch (_) {}
  return null;
}

async function detectNetwork(phoneNumber) {
  const cleanPhone = normalizeNigerianPhone(phoneNumber);
  try {
    const data = await apiGet("/network-checker", { phone: cleanPhone });
    const netId = data?.network_id || data?.networkId;
    if (netId) {
      return { networkId: String(netId), network: data.network || getNetworkName(netId) };
    }
  } catch (_) {}
  return null;
}

function getNetworkName(networkId) {
  return NETWORKS.find(n => n.id === String(networkId))?.name || String(networkId);
}

function normalizeNigerianPhone(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) {
    digits = "0" + digits.slice(3);
  }
  return digits;
}

function isValidNigerianPhone(input) {
  const clean = normalizeNigerianPhone(input);
  return /^0[789][01]\d{8}$/.test(clean);
}

async function listElectricityProviders() {
  const data = await apiGet("/list/elect", undefined, { cacheKey: "list_elect" });
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.ELECTRIC_COMPANY)
      ? data.ELECTRIC_COMPANY
      : [];
  return raw.map(item => ({
    electId: String(item.electId || item.id || ""),
    name: item.electName || item.name || String(item.electId),
    prodId: item.prodId ? String(item.prodId) : null,
  }));
}

async function validateMeter(meterNo, electId) {
  const body = await apiPost("/validate/elect", {
    meterNo: String(meterNo).trim(),
    electId: String(electId).trim(),
  });
  return body?.data || body;
}

async function listDataPlans(networkId = null) {
  const data = await apiGet("/list/internet", undefined, { cacheKey: "list_internet" });
  let raw = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (data?.dataPlan && typeof data.dataPlan === "object") {
    raw = Object.values(data.dataPlan).flat();
  }
  const normalized = raw.map(p => ({
    prodId: String(p.prodId || p.prodCode || ""),
    prodAmount: Number(p.prodAmount || p.amount || 0),
    description: p.prodName || p.description || String(p.prodId),
    networkId: String(p.networkId || p.network_id || ""),
    network: p.network || getNetworkName(p.networkId || p.network_id),
  })).filter(p => p.prodId && p.prodAmount > 0);

  // Guard against an Airbills backend quirk where duplicate prodIds across networks
  // (e.g. prodId "500" on MTN=₦306 vs Glo=₦237 vs 9mobile=₦254) resolve to the first
  // network's price and fail with "the amount not correct". Exclude colliding plans.
  const firstPriceByProdId = new Map();
  const safePlans = [];
  for (const plan of normalized) {
    if (!firstPriceByProdId.has(plan.prodId)) {
      firstPriceByProdId.set(plan.prodId, plan.prodAmount);
      safePlans.push(plan);
    } else if (firstPriceByProdId.get(plan.prodId) === plan.prodAmount) {
      safePlans.push(plan);
    }
  }

  if (!networkId) return safePlans;
  return safePlans.filter(p => String(p.networkId) === String(networkId));
}

async function listBettingPlatforms() {
  const data = await apiGet("/list/bet", undefined, { cacheKey: "list_bet" });
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.bettingCompany)
      ? data.bettingCompany
      : [];
  return raw.map(p => ({
    prodId: String(p.prodId || p.id || ""),
    name: p.prodName || p.name || String(p.prodId),
  }));
}

async function listCablePackages(provider = null) {
  const data = await apiGet("/list/cable", undefined, { cacheKey: "list_cable" });
  let raw = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (data?.CableTv && typeof data.CableTv === "object") {
    raw = Object.values(data.CableTv).flat();
  }
  const normalized = raw.map(p => ({
    prodId: String(p.prodId || p.id || ""),
    prodAmount: Number(p.prodAmount || p.amount || 0),
    description: p.prodName || p.description || String(p.prodId),
    provider: p.TvId || p.provider || "Cable TV",
  })).filter(p => p.prodId && p.prodAmount > 0);

  if (!provider) return normalized;
  const target = String(provider).toLowerCase();
  const filtered = normalized.filter(p =>
    String(p.provider || "").toLowerCase().includes(target) ||
    String(p.description || "").toLowerCase().includes(target) ||
    String(p.prodId || "").toLowerCase().includes(target)
  );
  return filtered;
}

async function listTransportServices() {
  const data = await apiGet("/list/transport", undefined, { cacheKey: "list_transport" });
  const raw = Array.isArray(data) ? data : [];
  return raw.map(s => ({
    prodId: String(s.prodId || s.code || s.id || ""),
    prodAmount: Number(s.prodAmount || s.amount || 0),
    name: s.name || s.description || String(s.prodId),
    description: s.description || s.name || String(s.prodId),
  }));
}

// ─── Airbills Two-Step Transaction Calls ──────────────────────────────────────

async function createTransaction({ productCode, data, payWith = "default", callbackUrl = null }) {
  const payload = {
    productCode: String(productCode),
    payWith,
    data,
  };
  if (callbackUrl) payload.callbackUrl = callbackUrl;
  const body = await apiPost("/transact", payload);
  const txData = body?.data;
  if (!txData?.id) {
    throw new Error("Airbills did not return a transaction ID.");
  }
  return txData;
}

async function processTransaction({ productCode, id }) {
  const body = await apiPost("/transact/process", {
    productCode: String(productCode),
    id: String(id),
  });
  return body;
}

// ─── One-Time On-Demand Solana Wallet Activation ──────────────────────────────

/**
 * Ensures the user's permanent default Solana wallet has:
 *   1. An initialized USDC Associated Token Account (ATA) — one-time ~0.00204 SOL rent
 *   2. At least 0.00005 SOL for tx signing fees (drips 0.0005 SOL once = ~100 bills)
 *
 * Uses a single atomic Solana transaction funded by SOLANA_FEE_PAYER_KEY.
 * On all subsequent bills or Arc -> Solana transfers, both already exist and this
 * returns immediately with zero cost.
 */
async function ensureUserSolanaActivated(userSolanaPubkey, options = {}) {
  const conn = options.connection || getSolanaConnection();
  const userPubkey = typeof userSolanaPubkey === "string"
    ? new PublicKey(userSolanaPubkey)
    : userSolanaPubkey;

  const userUsdcAta = multichain.getAssociatedTokenAddress(userPubkey, multichain.SOLANA_USDC_MINT);

  const [ataInfo, solLamports] = await Promise.all([
    conn.getAccountInfo(userUsdcAta),
    conn.getBalance(userPubkey),
  ]);

  const needsAta = !ataInfo;
  const needsSol = solLamports < USER_SOL_MIN_LAMPORTS;

  if (!needsAta && !needsSol) {
    return {
      activated: false,
      alreadyReady: true,
      ataAddress: userUsdcAta.toBase58(),
      solBalance: solLamports / 1e9,
    };
  }

  const bs58Key = options.feePayerKey || process.env.SOLANA_FEE_PAYER_KEY;
  if (!bs58Key) {
    throw new Error("Solana wallet activation requires SOLANA_FEE_PAYER_KEY to be configured.");
  }

  const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;
  const feePayer = Keypair.fromSecretKey(bs58Decode(bs58Key));

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
  );

  if (needsAta) {
    tx.add(
      multichain.createAssociatedTokenAccountInstruction(
        feePayer.publicKey,
        userUsdcAta,
        userPubkey,
        multichain.SOLANA_USDC_MINT
      )
    );
  }

  if (needsSol) {
    const dripLamports = Math.max(100_000, USER_SOL_DRIP_LAMPORTS - solLamports);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: userPubkey,
        lamports: dripLamports,
      })
    );
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer.publicKey;
  tx.sign(feePayer);

  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return {
      activated: true,
      alreadyReady: false,
      createdAta: needsAta,
      drippedSol: needsSol,
      txSignature: sig,
      ataAddress: userUsdcAta.toBase58(),
    };
  } catch (sendErr) {
    const logs = typeof sendErr.getLogs === "function" ? await sendErr.getLogs(conn).catch(() => null) : sendErr.transactionLogs;
    console.error("[airbills:activate] Solana activation failed:", sendErr.message, logs || "");
    throw new Error(`Could not activate your Solana bill wallet: ${sendErr.message}`);
  }
}

/**
 * Read user's live USDC balance on Solana (in human USDC float).
 */
async function getSolanaUsdcBalance(userSolanaPubkey, connection = null) {
  const conn = connection || getSolanaConnection();
  const userPubkey = typeof userSolanaPubkey === "string"
    ? new PublicKey(userSolanaPubkey)
    : userSolanaPubkey;
  const ata = multichain.getAssociatedTokenAddress(userPubkey, multichain.SOLANA_USDC_MINT);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return parseFloat(bal?.value?.uiAmountString || "0");
  } catch (_) {
    return 0;
  }
}

/**
 * Wait until user's Solana USDC balance reaches targetAmount (after CCTP mint).
 */
async function waitForSolanaUsdcBalance(userSolanaPubkey, targetAmount, { maxAttempts = 24, intervalMs = 5000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const bal = await getSolanaUsdcBalance(userSolanaPubkey);
    if (bal >= targetAmount - 0.005) {
      return bal;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return await getSolanaUsdcBalance(userSolanaPubkey);
}

/**
 * Estimate USDC cost for an NGN bill amount using live FX rate.
 */
async function estimateBillUsdc(amountNgn) {
  const ngn = Number(amountNgn);
  if (!ngn || ngn <= 0) return 0;
  try {
    const airbillsRate = await getAirbillsUsdcRate();
    if (airbillsRate && airbillsRate > 0) {
      return Number((ngn / airbillsRate).toFixed(4));
    }
  } catch (_) {}
  try {
    const rate = await fx.getUsdToNgnRate();
    if (rate && rate > 0) {
      return Number((ngn / rate).toFixed(4));
    }
  } catch (_) {}
  // Conservative fallback if FX API unreachable
  return Number((ngn / 1350).toFixed(4));
}

/**
 * Extract prepaid electricity meter token / pin from Airbills process response.
 */
function extractMeterToken(processRes) {
  const d = processRes?.data || processRes || {};
  return (
    d.token ||
    d.meterToken ||
    d.purchased_code ||
    d.purchasedCode ||
    d.pin ||
    d.code ||
    null
  );
}

/**
 * Sign & submit Airbills `transactionIx` (base64) using the user's Solana keypair.
 */
async function signAndSubmitAirbillsTx(transactionIxBase64, userSolanaKeypair, connection = null) {
  const conn = connection || getSolanaConnection();
  const tx = Transaction.from(Buffer.from(transactionIxBase64, "base64"));
  tx.partialSign(userSolanaKeypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Full Zero-Float Bill Payment Execution ───────────────────────────────────

/**
 * Execute an Airbills bill payment end-to-end using the user's own wallet (zero USDC float).
 *
 * @param {object} params
 * @param {object} params.user          - Proxim DB user row
 * @param {string} params.pin           - Verified 4-digit PIN
 * @param {string} [params.context]     - "personal" | "business"
 * @param {string} params.productCode   - "100".."105"
 * @param {string} params.category      - "airtime"|"electricity"|"data"|"betting"|"cable"|"transport"
 * @param {string} [params.providerName]- Human-readable provider label
 * @param {string} params.recipient     - Phone / meterNo / smartCardNo / customerId
 * @param {number} params.amountNgn     - Amount in Naira
 * @param {object} params.billData      - Product-specific fields for Airbills `data` object
 * @param {function} [params.onProgress]- Optional async status callback(msg)
 */
async function executeBillPayment({
  user,
  pin,
  context = "personal",
  productCode,
  category,
  providerName = null,
  recipient,
  amountNgn,
  billData,
  onProgress = null,
}) {
  if (!isConfigured()) {
    throw new Error("Bill payments are temporarily unavailable (Airbills key not configured).");
  }

  // 1. Unlock user's Arc wallet & derive their permanent default Solana wallet
  const rawPrivateKey =
    context === "business" && user.business_deposit_address
      ? db.decryptBusinessPrivateKey(pin, user)
      : db.decryptPrivateKey(pin, user);
  const userArcWallet = walletLib.walletFromPrivateKey(rawPrivateKey);
  const solanaDerived = multichain.deriveSolanaFromEvmKey(rawPrivateKey);
  const userSolanaKeypair = solanaDerived.keypair;
  const userSolanaAddress = userSolanaKeypair.publicKey.toBase58();

  const estUsdc = await estimateBillUsdc(amountNgn);

  // 1b. Anti-Fraud Velocity, Circuit Breaker & Per-User Concurrency Lock (Findings 2 & 5)
  await fraudGuard.assertOutboundAllowed({
    telegramId: user.telegram_id,
    accountType: context,
    action: `bill_${category}`,
    amountUsd: estUsdc,
    reference: `${productCode}:${recipient}`,
    record: false,
  });

  const billLockKey = `airbills_pay_lock:${user.telegram_id}`;
  const billLock = idempotency.tryAcquireOperationLock(billLockKey, {
    scope: "airbills_bill_payment",
    telegramId: user.telegram_id,
    accountType: context,
    amount: estUsdc,
    lockTtlSeconds: 90,
    allowReacquireAfterCompleted: true,
  });
  if (!billLock.acquired) {
    throw new Error("A bill payment is already in progress on your account. Please wait for it to finish.");
  }

  const billRecord = db.createBillPayment({
    telegramId: user.telegram_id,
    accountType: context,
    productCode,
    category,
    providerName,
    recipient,
    amountNgn,
    amountUsdc: estUsdc,
    status: "pending",
  });

  try {
    // 2. CRITICAL (Finding 2): Verify user has sufficient USDC balance on Solana or Arc BEFORE
    // calling ensureUserSolanaActivated() so $0.00 balance sybil bots can NEVER drain SOL rent or gas drips!
    let solUsdc = await getSolanaUsdcBalance(userSolanaKeypair.publicKey);
    // Add 3% buffer when bridging to protect against slight NGN/USD quote movement
    const bridgeTargetUsdc = Number((estUsdc * 1.03 + 0.05).toFixed(4));
    let arcTxHash = null;
    let neededUsdc = 0;

    if (solUsdc < bridgeTargetUsdc) {
      neededUsdc = Number(Math.max(0.5, bridgeTargetUsdc - solUsdc).toFixed(4));
      const arcBalMicro = await walletLib.getNativeBalanceMicro(userArcWallet.address);
      const arcBal = parseFloat(walletLib.formatMicro(arcBalMicro));

      if (arcBal < neededUsdc) {
        throw new Error(
          `Insufficient balance. You need ~$${neededUsdc.toFixed(2)} USDC, but your balance is $${arcBal.toFixed(2)}.`
        );
      }
    }

    // Record velocity only after confirming the user actually holds the funds
    fraudGuard.recordOutboundVelocity({
      telegramId: user.telegram_id,
      accountType: context,
      action: `bill_${category}`,
      amountUsd: estUsdc,
      reference: `${productCode}:${recipient}`,
    });

    // 3. One-time on-demand Solana wallet activation (USDC ATA + tiny SOL gas drip) — ONLY for funded users!
    if (onProgress) await onProgress("⚡ Checking your Solana bill wallet...");
    await ensureUserSolanaActivated(userSolanaKeypair.publicKey);

    if (solUsdc < bridgeTargetUsdc) {
      if (onProgress) {
        await onProgress(`🌉 Moving ~$${neededUsdc.toFixed(2)} from your wallet to settle this bill (~25s)...`);
      }
      db.updateBillPayment(billRecord.id, { status: "bridging" });

      const bridgeRes = await cctpBridge.executeArcToSolanaCctpBurn({
        userWallet: userArcWallet,
        amountUsdc: neededUsdc,
        recipientSolanaAddress: userSolanaAddress,
        autoCompleteOnSolana: true,
        telegramId: user.telegram_id,
      });

      if (!bridgeRes?.success) {
        throw new Error(bridgeRes?.error || "Could not bridge USDC from Arc to your Solana wallet.");
      }
      arcTxHash = bridgeRes.arcTxHash || bridgeRes.txHash || null;
      db.updateBillPayment(billRecord.id, { arc_tx_hash: arcTxHash });

      // Wait until CCTP mint confirms into user's Solana USDC ATA
      solUsdc = await waitForSolanaUsdcBalance(userSolanaKeypair.publicKey, estUsdc, {
        maxAttempts: 24,
        intervalMs: 5000,
      });
      if (solUsdc < estUsdc * 0.98) {
        throw new Error(
          "Your USDC is still arriving on Solana. Your funds are safe in your Solana wallet — please retry in a moment."
        );
      }
    }

    // 4. Create Airbills transaction in Default Mode (fresh blockhash AFTER funds are on Solana)
    if (onProgress) await onProgress("🧾 Authorizing bill payment with Airbills...");
    db.updateBillPayment(billRecord.id, { status: "processing" });

    const txData = await createTransaction({
      productCode,
      payWith: "default",
      data: {
        ...billData,
        pubKey: userSolanaAddress,
        token: "USDC",
        amount: Number(amountNgn),
      },
    });

    const exactUsdc = Number(txData.amountInToken || estUsdc);
    db.updateBillPayment(billRecord.id, {
      airbills_tx_id: txData.id,
      amount_usdc: exactUsdc,
    });

    if (!txData.transactionIx) {
      throw new Error("Airbills did not return a signable Solana transaction.");
    }

    // 5. Sign & submit Solana transaction with user's own Solana keypair
    const solanaTxSig = await signAndSubmitAirbillsTx(txData.transactionIx, userSolanaKeypair);
    db.updateBillPayment(billRecord.id, { solana_tx_sig: solanaTxSig });

    // 6. Trigger Airbills fulfillment (/transact/process)
    if (onProgress) await onProgress("📡 Delivering your bill...");
    const processRes = await processTransaction({
      productCode,
      id: txData.id,
    });

    const meterToken = productCode === PRODUCTS.ELECTRICITY.code ? extractMeterToken(processRes) : null;

    const updated = db.updateBillPayment(billRecord.id, {
      status: "successful",
      meter_token: meterToken,
    });

    // Record in main transactions history
    try {
      db.recordTransaction(
        user.telegram_id,
        `bill_${category}`,
        walletLib.parseToMicro(exactUsdc.toFixed(6)),
        "confirmed",
        solanaTxSig,
        context,
        18,
        "solana",
        `${providerName || category} bill ₦${Number(amountNgn).toLocaleString()} for ${recipient}`
      );
    } catch (_) {}

    idempotency.completeOperationIdempotency(billLockKey, { txHash: solanaTxSig });

    return {
      success: true,
      bill: updated,
      airbillsTxId: txData.id,
      amountUsdc: exactUsdc,
      amountNgn: Number(amountNgn),
      solanaTxSig,
      arcTxHash,
      meterToken,
      processResponse: processRes,
    };
  } catch (err) {
    idempotency.failOperationIdempotency(billLockKey, err.message);
    db.updateBillPayment(billRecord.id, {
      status: "failed",
      error_message: err.message,
    });
    throw err;
  }
}

module.exports = {
  PRODUCTS,
  NETWORKS,
  USER_SOL_MIN_LAMPORTS,
  USER_SOL_DRIP_LAMPORTS,
  getBaseUrl,
  isConfigured,
  normalizeNigerianPhone,
  isValidNigerianPhone,
  getNetworkName,
  getAirbillsTokens,
  getAirbillsUsdcRate,
  detectNetwork,
  listElectricityProviders,
  validateMeter,
  listDataPlans,
  listBettingPlatforms,
  listCablePackages,
  listTransportServices,
  createTransaction,
  processTransaction,
  ensureUserSolanaActivated,
  getSolanaUsdcBalance,
  estimateBillUsdc,
  extractMeterToken,
  signAndSubmitAirbillsTx,
  executeBillPayment,
};
