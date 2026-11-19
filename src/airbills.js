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

// One-time SOL gas drip so user's default Solana wallet can sign ~100 Airbills txs
const USER_SOL_MIN_LAMPORTS  = 50_000;   // 0.00005 SOL threshold
const USER_SOL_DRIP_LAMPORTS = 500_000;  // 0.0005 SOL (~$0.07)

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

async function apiGet(path, params = undefined) {
  const res = await axios.get(`${getBaseUrl()}${path}`, {
    headers: getHeaders(),
    params,
    timeout: 20000,
  });
  const body = res.data;
  if (body?.status && body.status !== "00") {
    throw new Error(parseAirbillsError(body));
  }
  return body?.data !== undefined ? body.data : body;
}

async function apiPost(path, payload) {
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
}

// ─── Catalog & Validation Endpoints ───────────────────────────────────────────

async function detectNetwork(phoneNumber) {
  const cleanPhone = normalizeNigerianPhone(phoneNumber);
  try {
    const data = await apiGet("/network-checker", { phone: cleanPhone });
    if (data?.networkId) {
      return { networkId: String(data.networkId), network: data.network || getNetworkName(data.networkId) };
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
  const list = await apiGet("/list/elect");
  return Array.isArray(list) ? list : [];
}

async function validateMeter(meterNo, electId) {
  const body = await apiPost("/validate/elect", {
    meterNo: String(meterNo).trim(),
    electId: String(electId).trim(),
  });
  return body?.data || body;
}

async function listDataPlans(networkId = null) {
  const list = await apiGet("/list/internet");
  const all = Array.isArray(list) ? list : [];
  if (!networkId) return all;
  return all.filter(p => String(p.networkId) === String(networkId));
}

async function listBettingPlatforms() {
  const list = await apiGet("/list/bet");
  return Array.isArray(list) ? list : [];
}

async function listCablePackages(provider = null) {
  const list = await apiGet("/list/cable");
  const all = Array.isArray(list) ? list : [];
  if (!provider) return all;
  const target = String(provider).toLowerCase();
  return all.filter(p =>
    String(p.provider || p.prodId || p.description || "").toLowerCase().includes(target)
  );
}

async function listTransportServices() {
  const list = await apiGet("/list/transport");
  return Array.isArray(list) ? list : [];
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
    tx.add(
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: userPubkey,
        lamports: USER_SOL_DRIP_LAMPORTS,
      })
    );
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer.publicKey;
  tx.sign(feePayer);

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
    const rate = await fx.getUsdToNgnRate();
    if (rate && rate > 0) {
      return Number((ngn / rate).toFixed(4));
    }
  } catch (_) {}
  // Conservative fallback if FX API unreachable
  return Number((ngn / 1500).toFixed(4));
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
    // 2. One-time on-demand Solana wallet activation (USDC ATA + tiny SOL gas drip)
    if (onProgress) await onProgress("⚡ Checking your Solana bill wallet...");
    await ensureUserSolanaActivated(userSolanaKeypair.publicKey);

    // 3. Ensure user's own Solana wallet has enough USDC (fast path if already funded, else CCTP from Arc)
    let solUsdc = await getSolanaUsdcBalance(userSolanaKeypair.publicKey);
    // Add 3% buffer when bridging to protect against slight NGN/USD quote movement
    const bridgeTargetUsdc = Number((estUsdc * 1.03 + 0.05).toFixed(4));
    let arcTxHash = null;

    if (solUsdc < bridgeTargetUsdc) {
      const neededUsdc = Number(Math.max(0.5, bridgeTargetUsdc - solUsdc).toFixed(4));
      const arcBalMicro = await walletLib.getNativeBalanceMicro(userArcWallet.address);
      const arcBal = parseFloat(walletLib.formatMicro(arcBalMicro));

      if (arcBal < neededUsdc) {
        throw new Error(
          `Insufficient balance. You need ~$${neededUsdc.toFixed(2)} USDC, but your balance is $${arcBal.toFixed(2)}.`
        );
      }

      if (onProgress) {
        await onProgress(`🌉 Moving ~$${neededUsdc.toFixed(2)} from your wallet to settle this bill (~25s)...`);
      }
      db.updateBillPayment(billRecord.id, { status: "bridging" });

      const bridgeRes = await cctpBridge.bridgeArcToSolana({
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
