// src/statement.js
// Unified Account Statement & Counterparty Enrichment Engine (Mobile App + Telegram Bot)
// Ensures every fiat & crypto deposit and withdrawal displays clear direction (CREDIT/DEBIT),
// asset category (Fiat/Crypto/Card/Bills/Savings/etc.), fiat + USD amounts, and sender/recipient
// bank/wallet details for clean tracking and inventory accounting.

const CREDIT_TX_TYPES = new Set([
  "deposit",
  "deposit_naira",
  "deposit_fiat",
  "deposit_crypto",
  "deposit_crosschain",
  "crypto_deposit",
  "near_deposit",
  "evm_sweep",
  "onramp",
  "paj_onramp",
  "p2p_receive",
  "p2p_refund",
  "invoice_payment",
  "yield_withdraw",
  "auto_earn_liquidate",
  "stock_sell",
  "card_refund",
  "card_unload",
]);

const TX_HUMAN_LABELS = {
  deposit: "Deposit",
  deposit_naira: "Naira Bank Deposit",
  deposit_fiat: "International Bank Deposit",
  deposit_crypto: "Crypto Deposit",
  deposit_crosschain: "Cross-Chain Crypto Deposit",
  crypto_deposit: "Crypto Deposit",
  near_deposit: "Crypto Deposit",
  evm_sweep: "Crypto Deposit",
  onramp: "Naira Deposit",
  paj_onramp: "Naira Deposit",
  p2p_receive: "Proxim Transfer Received",
  p2p_refund: "Gift Link Refund",
  invoice_payment: "Invoice Payment Received",
  yield_withdraw: "Savings Withdrawal",
  auto_earn_liquidate: "Auto-Save Returned to Balance",
  offramp: "Naira Bank Withdrawal",
  offramp_request: "Naira Bank Withdrawal",
  withdraw_naira: "Naira Bank Withdrawal",
  payout: "Bank Payout",
  payout_global: "International Bank Withdrawal",
  global_payout: "International Bank Withdrawal",
  card_load: "Virtual USD Card Funding",
  card_spend: "Virtual USD Card Spend",
  card_refund: "Virtual USD Card Refund",
  card_unload: "Virtual USD Card Unload",
  send_usdc: "Crypto Withdrawal (USDC)",
  send_eurc: "Crypto Withdrawal (EURC)",
  transfer: "Crypto Transfer Sent",
  crosschain_withdraw: "Cross-Chain Crypto Withdrawal",
  intent_withdraw: "Cross-Chain Crypto Withdrawal",
  move_funds: "Internal Chain Move",
  p2p_send: "Proxim Transfer Sent",
  p2p_escrow: "Gift Link Sent",
  scheduled_transfer: "Scheduled Transfer",
  yield_deposit: "Dollar Savings Deposit",
  savings_deposit: "Dollar Savings Deposit",
  auto_earn_deposit: "Auto-Save Deposit",
  swap: "FX Currency Swap",
  swap_usdc_eurc: "FX Swap (USD -> EUR)",
  swap_eurc_usdc: "FX Swap (EUR -> USD)",
  stock_buy: "US Stock Purchase",
  stock_sell: "US Stock Sale",
  monthly_maintenance_fee: "Monthly Account & Alert Fee",
  global_account_maintenance_fee: "Global Account Maintenance Fee",
};

const CRYPTO_CODES = new Set(["USDC", "USDT", "EURC", "USC", "USDG", "ETH", "SOL", "BTC", "NEAR", "MATIC", "AVAX", "BNB", "TRX", "TON", "XRP"]);

function isCreditType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (CREDIT_TX_TYPES.has(t)) return true;
  if (/auto_earn_deposit|savings_deposit|yield_deposit/.test(t)) return false;
  return /^(deposit|onramp|credit|receive)/.test(t) || /_receive$|_refund$|_credit$/.test(t);
}

function getHumanTxLabel(type) {
  const t = String(type || "transaction").trim().toLowerCase();
  if (TX_HUMAN_LABELS[t]) return TX_HUMAN_LABELS[t];
  if (t.startsWith("bill_")) {
    return `Bill Payment (${t.slice(5).toUpperCase()})`;
  }
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function classifyCategory(tx) {
  const t = String(tx.type || "").trim().toLowerCase();
  const srcCur = tx.source_currency ? String(tx.source_currency).toUpperCase() : null;
  const ch = tx.deposit_channel ? String(tx.deposit_channel).toLowerCase() : null;

  if (t.startsWith("bill_")) return "Fiat (Bills)";
  if (/^card_/.test(t)) return "Fiat (Card)";
  if (t === "monthly_maintenance_fee" || t === "global_account_maintenance_fee") return "Account Fee";
  if (/stock_/.test(t)) return "Investments";
  if (/yield_|savings_|auto_earn/.test(t)) return "Savings";
  if (/^swap/.test(t)) return "FX Swap";
  if (/deposit_naira|deposit_fiat|onramp|offramp|withdraw_naira|payout|global_payout/.test(t)) {
    return "Fiat";
  }
  if (ch === "naira" || ch === "international") return "Fiat";
  if (srcCur && !CRYPTO_CODES.has(srcCur)) return "Fiat";
  if (/deposit_crypto|deposit_crosschain|crypto_deposit|near_deposit|evm_sweep|crosschain_withdraw|intent_withdraw|send_usdc|send_eurc|transfer|move_funds/.test(t)) {
    return "Crypto";
  }
  if (/p2p_/.test(t)) return "P2P";
  return tx.chain === "local_fiat" ? "Fiat" : "Crypto";
}

function formatAmountFromRaw(rawAmt, decimals = 18) {
  const str = String(rawAmt ?? "0").trim();
  if (!str) return "0";
  if (!/^-?\d+$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) ? String(n) : "0";
  }
  const dec = Math.max(0, Math.min(36, Number(decimals ?? 18)));
  const neg = str.startsWith("-");
  const digits = neg ? str.slice(1) : str;
  const padded = digits.padStart(dec + 1, "0");
  const whole = padded.slice(0, padded.length - dec);
  const frac = padded.slice(padded.length - dec).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

function parseUsdAmount(tx) {
  const str = formatAmountFromRaw(tx.amount_micro ?? tx.amount ?? "0", tx.decimals ?? 18);
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

function cleanStr(val, max = 140) {
  if (val === undefined || val === null) return null;
  const s = String(val).replace(/\s+/g, " ").trim();
  if (!s || s === "null" || s === "undefined" || s === "[object Object]") return null;
  return s.slice(0, max);
}

function firstNonEmpty(values, max = 140) {
  for (const v of values) {
    const c = cleanStr(v, max);
    if (c) return c;
  }
  return null;
}

const NIBSS_BANK_NAMES = {
  "000001": "Sterling Bank",
  "000002": "Keystone Bank",
  "000003": "FCMB",
  "000004": "UBA",
  "000005": "Access Bank (Diamond)",
  "000006": "Jaiz Bank",
  "000007": "Fidelity Bank",
  "000008": "Polaris Bank",
  "000009": "Citi Bank",
  "000010": "Ecobank",
  "000011": "Unity Bank",
  "000012": "Stanbic IBTC Bank",
  "000013": "GTBank",
  "000014": "Access Bank",
  "000015": "Zenith Bank",
  "000016": "First Bank",
  "000017": "Wema Bank",
  "000018": "Union Bank",
  "000019": "Enterprise Bank",
  "000020": "Heritage Bank",
  "000021": "Standard Chartered",
  "000022": "SunTrust Bank",
  "000023": "Providus Bank",
  "000024": "Rand Merchant Bank",
  "000025": "Titan Trust Bank",
  "000026": "Taj Bank",
  "000027": "Globus Bank",
  "000029": "Lotus Bank",
  "000030": "Parallex Bank",
  "000031": "PremiumTrust Bank",
  "000034": "Signature Bank",
  "000036": "Optimus Bank",
  "090110": "VFD MFB",
  "090175": "Rubies MFB",
  "090177": "Carbon",
  "090267": "Kuda Bank",
  "090286": "SafeHaven MFB",
  "090325": "Sparkle",
  "090405": "Moniepoint MFB",
  "090409": "FCMB Easy Account",
  "090551": "FairMoney MFB",
  "090701": "Dot MFB",
  "100002": "Paga",
  "100004": "OPay",
  "100022": "GoMoney",
  "100033": "PalmPay",
  "100039": "Paystack-Titan",
  "110007": "Carbon",
};

function decodeNibssBankFromReference(ref) {
  const s = cleanStr(ref, 64);
  if (!s) return null;
  // Standard Nigerian NIP Session ID is 30 digits: first 6 digits = originating bank NIBSS code
  const m = s.match(/^(\d{6})\d{14,30}$/);
  if (!m) return null;
  return NIBSS_BANK_NAMES[m[1]] || null;
}

function extractSenderNameFromNarration(narration) {
  const raw = cleanStr(narration, 120);
  if (!raw) return null;
  // Ignore generic system / invoice / fee narrations
  if (/^(ngn|usd|gbp|eur|cad|aed|ghs|kes|tzs)\s+deposit/i.test(raw)) return null;
  if (/^(proxim|fx\s+spread|outstanding|monthly|deposit|transfer|payment|payout|bill|card|swap|auto[- ]?save|held\s+in|inv-[a-z0-9]+)/i.test(raw)) return null;
  // Common Nigerian NIP narration formats: "NIP/ADAORA EZE/...", "TRF FROM CHINEDU OKAFOR", or plain sender full name ("Igboze Iboh Igboze")
  const nipSlash = raw.match(/^NIP\/([^/]{3,60})/i);
  if (nipSlash && nipSlash[1]) return cleanStr(nipSlash[1], 80);
  const fromMatch = raw.match(/^(?:TRF\s+FROM|TRANSFER\s+FROM|FROM|BY)\s+([A-Za-z][A-Za-z0-9 .,'&-]{2,60})$/i);
  if (fromMatch && fromMatch[1]) return cleanStr(fromMatch[1], 80);
  // Plain sender full name (2-5 alphabetic/company words, no digits/URLs/codes)
  if (/^[A-Za-z][A-Za-z .,'&-]{2,60}$/.test(raw) && raw.split(/\s+/).length >= 2 && raw.split(/\s+/).length <= 6) {
    return raw;
  }
  return null;
}

/**
 * Extract structured sender / originator bank details from any Nuvion or Paj inbound
 * transfer payload (handles top-level fields, nested sender/originator/source/debtor/
 * payer/counterparty/meta/supplementary_data objects across NIP, ACH, FPS, SEPA, Wire, MoMo,
 * PLUS live Nigerian NIBSS NIP Session ID bank decoding and sender-name narration fallback).
 */
function extractInboundSenderDetails(payload) {
  if (!payload || typeof payload !== "object") {
    return { name: null, bank: null, account: null };
  }
  const meta = (payload.meta && typeof payload.meta === "object") ? payload.meta : {};
  const supp = (payload.supplementary_data && typeof payload.supplementary_data === "object") ? payload.supplementary_data : {};
  const details = (payload.details && typeof payload.details === "object") ? payload.details : {};
  const metadata = (payload.metadata && typeof payload.metadata === "object") ? payload.metadata : {};

  const nestedObjects = [
    payload.sender,
    payload.originator,
    payload.source,
    payload.source_account,
    payload.debtor,
    payload.payer,
    payload.remitter,
    payload.counterparty,
    payload.payment_detail,
    meta.sender,
    meta.originator,
    meta.source,
    meta.source_account,
    meta.debtor,
    meta.payer,
    supp.sender,
    supp.originator,
    details.sender,
    details.originator,
    metadata.sender,
    metadata.originator,
  ].filter((o) => o && typeof o === "object");

  const fullNameFromObj = (o) => {
    if (!o || typeof o !== "object") return null;
    const direct = firstNonEmpty([
      o.account_holder_name,
      o.account_name,
      o.accountName,
      o.full_name,
      o.fullName,
      o.legal_name,
      o.legalName,
      o.name,
      o.sender_name,
      o.senderName,
      o.originator_name,
      o.originatorName,
      o.nickname,
    ]);
    if (direct) return direct;
    const combined = [o.first_name || o.firstName, o.last_name || o.lastName].filter(Boolean).join(" ").trim();
    return combined || null;
  };

  const name = firstNonEmpty([
    payload.sender_name,
    payload.senderName,
    payload.sender_account_name,
    payload.senderAccountName,
    payload.originator_name,
    payload.originatorName,
    payload.originator_account_name,
    payload.source_account_name,
    payload.sourceAccountName,
    payload.payer_name,
    payload.payerName,
    payload.debtor_name,
    payload.debtorName,
    payload.remitter_name,
    payload.remitterName,
    meta.sender_name,
    meta.senderName,
    meta.sender_account_name,
    meta.originator_name,
    meta.originatorName,
    meta.source_account_name,
    meta.payer_name,
    meta.debtor_name,
    meta.remitter_name,
    meta.account_holder_name,
    meta.account_name,
    supp.sender_name,
    supp.originator_name,
    details.sender_name,
    details.originator_name,
    metadata.senderName,
    metadata.sender_name,
    metadata.senderAccountName,
    metadata.payerName,
    ...nestedObjects.map(fullNameFromObj),
  ]);

  const bank = firstNonEmpty([
    payload.sender_bank_name,
    payload.senderBankName,
    payload.sender_bank,
    payload.senderBank,
    payload.originator_bank_name,
    payload.originatorBankName,
    payload.originator_bank,
    payload.originatorBank,
    payload.source_bank_name,
    payload.sourceBankName,
    payload.debtor_bank_name,
    payload.payer_bank_name,
    payload.remitter_bank,
    meta.sender_bank_name,
    meta.senderBankName,
    meta.sender_bank,
    meta.originator_bank,
    meta.originator_bank_name,
    meta.source_bank_name,
    meta.bank_name,
    meta.bankName,
    meta.institution_name,
    supp.sender_bank_name,
    supp.bank_name,
    details.bank_name,
    metadata.senderBankName,
    metadata.senderBank,
    metadata.sender_bank,
    ...nestedObjects.map((o) => firstNonEmpty([
      o.bank_name,
      o.bankName,
      o.institution_name,
      o.institutionName,
      o.financial_institution,
      o.bank?.name,
      typeof o.bank === "string" ? o.bank : null,
      o.issuer?.name,
    ])),
  ]);

  const account = firstNonEmpty([
    payload.sender_account_number,
    payload.senderAccountNumber,
    payload.sender_account,
    payload.senderAccount,
    payload.originator_account_number,
    payload.originatorAccountNumber,
    payload.originator_account,
    payload.source_account_number,
    payload.sourceAccountNumber,
    payload.debtor_account_number,
    payload.debtor_iban,
    payload.sender_iban,
    payload.from_address,
    payload.fromAddress,
    meta.sender_account_number,
    meta.senderAccountNumber,
    meta.sender_account,
    meta.originator_account_number,
    meta.originator_account,
    meta.source_account_number,
    meta.account_number,
    meta.accountNumber,
    meta.iban,
    meta.nuban,
    meta.sender_iban,
    meta.wallet_address,
    supp.sender_account_number,
    supp.account_number,
    supp.iban,
    details.account_number,
    details.iban,
    metadata.senderAccountNumber,
    metadata.sender_account_number,
    ...nestedObjects.map((o) => firstNonEmpty([
      o.account_number,
      o.accountNumber,
      o.iban,
      o.nuban,
      o.wallet_address,
      o.walletAddress,
      o.phone_number,
      o.routing_number,
    ])),
  ]);

  let finalBank = bank;
  if (!finalBank) {
    finalBank = firstNonEmpty([
      decodeNibssBankFromReference(payload.unique_reference),
      decodeNibssBankFromReference(meta.provider_reference),
      decodeNibssBankFromReference(payload.provider_reference),
      decodeNibssBankFromReference(payload.reference),
      decodeNibssBankFromReference(payload.session_id),
      decodeNibssBankFromReference(payload.sessionId),
    ]);
  }

  let finalName = name;
  if (!finalName && payload.narration) {
    finalName = extractSenderNameFromNarration(payload.narration);
  }

  return { name: finalName, bank: finalBank, account };
}

/**
 * Format counterparty bank + account detail cleanly for receipts, alerts & UI.
 */
function formatCounterpartyDetail({ bank, account } = {}) {
  const b = cleanStr(bank, 60);
  const a = cleanStr(account, 64);
  if (b && a) return `${b} · ${a}`;
  return b || a || null;
}

/**
 * Retroactively enrich any transaction row with counterparty & fiat details from
 * transactions columns, paj_offramp_orders, paj_onramp_orders, and nuvion_jobs.
 */
function enrichTransactionRow(db, telegramId, tx) {
  const typeLower = String(tx.type || "").toLowerCase();
  const isCredit = isCreditType(typeLower);

  let counterpartyName = cleanStr(tx.counterparty_name);
  let counterpartyBank = cleanStr(tx.counterparty_bank);
  let counterpartyAccount = cleanStr(tx.counterparty_account);
  const rawSrcCur = tx.source_currency ? String(tx.source_currency).toUpperCase() : null;
  let fiatCurrency = rawSrcCur && !CRYPTO_CODES.has(rawSrcCur) ? rawSrcCur : null;
  let fiatAmount = fiatCurrency && tx.source_amount != null && Number(tx.source_amount) > 0 ? Number(tx.source_amount) : null;
  let payoutStatus = null;
  let payoutUpdatedAt = null;
  let offrampOrderId = null;

  const txHash = tx.tx_hash ? String(tx.tx_hash).trim() : null;
  const rawDb = db?.db || null;

  // 1. Paj Offramp Orders enrichment (outbound NGN withdrawals)
  if (!isCredit && /offramp|payout|withdraw/i.test(typeLower) && txHash && rawDb) {
    try {
      const o = rawDb.prepare(
        "SELECT * FROM paj_offramp_orders WHERE telegram_id = ? AND (order_id = ? OR tx_hash = ?) ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), txHash, txHash);
      if (o) {
        if (o.order_id) offrampOrderId = String(o.order_id);
        if (!counterpartyName) counterpartyName = cleanStr(o.account_name);
        if (!counterpartyBank) counterpartyBank = cleanStr(o.bank_name);
        if (!counterpartyAccount) counterpartyAccount = cleanStr(o.account_number);
        if (!fiatCurrency) fiatCurrency = "NGN";
        if (!fiatAmount && Number(o.fiat_amount) > 0) fiatAmount = Number(o.fiat_amount);
        const s = String(o.status || "").toLowerCase();
        payoutStatus = /complete|success|paid|settled/.test(s) ? "paid" : /fail|reject|refund|cancel|expire/.test(s) ? "failed" : "processing";
        payoutUpdatedAt = o.completed_at || o.updated_at || null;
      }
    } catch (_) { }
  }

  // 2. Paj Onramp Orders enrichment (inbound NGN deposits)
  if (isCredit && /deposit_naira|onramp/i.test(typeLower) && txHash && rawDb) {
    try {
      const onr = rawDb.prepare(
        "SELECT * FROM paj_onramp_orders WHERE telegram_id = ? AND (tx_hash = ? OR order_id = ?) ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), txHash, txHash);
      if (onr) {
        if (!fiatCurrency) fiatCurrency = "NGN";
        if (!fiatAmount && Number(onr.fiat_amount) > 0) fiatAmount = Number(onr.fiat_amount);
        if (!counterpartyBank) counterpartyBank = cleanStr(onr.sender_bank || onr.bank_name);
        if (!counterpartyName) counterpartyName = cleanStr(onr.sender_name);
        if (!counterpartyAccount) counterpartyAccount = cleanStr(onr.sender_account);
      }
    } catch (_) { }
  }

  // 3. Nuvion Jobs enrichment (both inbound fiat deposits AND outbound local/international payouts)
  if (txHash && rawDb && (!counterpartyName || !counterpartyBank || !counterpartyAccount || !fiatAmount)) {
    try {
      const nj = rawDb.prepare(
        "SELECT job_type, currency, amount_minor, state, payload_json, updated_at FROM nuvion_jobs WHERE telegram_id = ? AND (nuvion_transfer_id = ? OR unique_reference = ? OR source_tx_hash = ?) ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), txHash, txHash, txHash);
      if (nj) {
        let p = {};
        try { p = nj.payload_json ? JSON.parse(nj.payload_json) : {}; } catch (_) { }
        const cur = nj.currency ? String(nj.currency).toUpperCase() : null;
        if (!fiatCurrency && cur && !CRYPTO_CODES.has(cur)) fiatCurrency = cur;
        if (!fiatAmount && cur && !CRYPTO_CODES.has(cur)) {
          const major = Number(p.targetAmountMajor || p.grossMajor || 0) || (nj.amount_minor != null ? Number(nj.amount_minor) / 100 : 0);
          if (Number.isFinite(major) && major > 0) fiatAmount = Number(major.toFixed(2));
        }
        if (nj.job_type === "outbound_fiat_payout") {
          if (!counterpartyName) counterpartyName = cleanStr(p.recipientName);
          if (!counterpartyBank) counterpartyBank = cleanStr(p.recipientBankName || p.railLabel);
          if (!counterpartyAccount) counterpartyAccount = cleanStr(p.recipientAccountNumber);
          if (!payoutStatus) {
            const st = String(nj.state || "").toLowerCase();
            payoutStatus = st === "completed" ? "paid" : /fail|refund|cancel/.test(st) ? "failed" : "processing";
            payoutUpdatedAt = nj.updated_at || null;
          }
        } else {
          if (!counterpartyName) counterpartyName = cleanStr(p.senderName);
          if (!counterpartyBank) counterpartyBank = cleanStr(p.senderBank);
          if (!counterpartyAccount) counterpartyAccount = cleanStr(p.senderAccount);
        }
      }
    } catch (_) { }
  }

  // 4. Cross-chain withdrawal destination lookup
  if (!isCredit && /crosschain_withdraw|intent_withdraw/i.test(typeLower) && txHash && rawDb && !counterpartyAccount) {
    try {
      const cw = rawDb.prepare(
        "SELECT destination_chain, destination_address FROM crosschain_pending_withdrawals WHERE telegram_id = ? AND arc_tx_hash = ? ORDER BY id DESC LIMIT 1"
      ).get(Number(telegramId), txHash);
      if (cw) {
        if (!counterpartyBank) counterpartyBank = cleanStr(cw.destination_chain ? String(cw.destination_chain).toUpperCase() : null);
        if (!counterpartyAccount) counterpartyAccount = cleanStr(cw.destination_address);
      }
    } catch (_) { }
  }

  // 5. Fallback for fiat currency if still empty on NGN-only types
  if (!fiatCurrency && /deposit_naira|onramp|withdraw_naira/i.test(typeLower)) {
    fiatCurrency = "NGN";
  }

  const usdAmount = parseUsdAmount(tx);
  const signedUsdAmount = isCredit ? usdAmount : -usdAmount;
  const category = classifyCategory({ ...tx, source_currency: fiatCurrency || tx.source_currency });

  return {
    ...tx,
    direction: isCredit ? "CREDIT" : "DEBIT",
    isCredit,
    category,
    typeLabel: getHumanTxLabel(tx.type),
    fiatCurrency,
    fiatAmount,
    usdAmount,
    signedUsdAmount,
    counterpartyName,
    counterpartyBank,
    counterpartyAccount,
    counterpartyDetail: formatCounterpartyDetail({ bank: counterpartyBank, account: counterpartyAccount }),
    payoutStatus,
    payoutUpdatedAt,
    offrampOrderId,
  };
}

function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  // Keep pure negative numbers numeric so Excel/Sheets SUM() works on signed_usd_amount;
  // formula-escape any non-numeric cell starting with =, +, -, @, tab, or CR.
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build a complete, deduplicated account statement (Fiat + Crypto, Deposits + Withdrawals)
 * with clear direction, category, fiat & USD amounts, and counterparty details.
 */
function buildAccountStatement({ db, telegramId, accountType = null, limit = 500, fromMs = null, toMs = null }) {
  const fetchLimit = Math.min(Math.max(Number(limit || 500), 1), 2000);
  let rows = db.getTransactions(telegramId, fetchLimit, accountType) || [];

  if (fromMs !== null || toMs !== null) {
    rows = rows.filter((t) => {
      const ts = t.created_at
        ? Date.parse(t.created_at.includes("T") ? t.created_at : `${t.created_at.replace(" ", "T")}Z`)
        : NaN;
      if (Number.isNaN(ts)) return false;
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts > toMs) return false;
      return true;
    });
  }

  const enriched = rows.map((t) => enrichTransactionRow(db, telegramId, t));

  // Deduplicate paired Paj rows sharing the same offrampOrderId
  const seenOrderIds = new Set();
  const deduped = [];
  for (const row of enriched) {
    if (row.offrampOrderId) {
      const k = `${row.account_type}:${row.type}:${row.offrampOrderId}`;
      if (seenOrderIds.has(k)) continue;
      seenOrderIds.add(k);
    }
    deduped.push(row);
  }

  // Compute inventory summary totals
  const summary = {
    totalTransactions: deduped.length,
    totalDepositsCount: 0,
    totalWithdrawalsCount: 0,
    fiatDepositsCount: 0,
    fiatWithdrawalsCount: 0,
    cryptoDepositsCount: 0,
    cryptoWithdrawalsCount: 0,
    totalInflowUsd: 0,
    totalOutflowUsd: 0,
  };
  for (const r of deduped) {
    const failed = /fail|reject|cancel|error/.test(String(r.status || "").toLowerCase());
    if (failed) continue;
    const isFiat = r.category.startsWith("Fiat");
    if (r.isCredit) {
      summary.totalDepositsCount++;
      summary.totalInflowUsd += r.usdAmount;
      if (isFiat) summary.fiatDepositsCount++;
      else summary.cryptoDepositsCount++;
    } else {
      summary.totalWithdrawalsCount++;
      summary.totalOutflowUsd += r.usdAmount;
      if (isFiat) summary.fiatWithdrawalsCount++;
      else summary.cryptoWithdrawalsCount++;
    }
  }
  summary.totalInflowUsd = Number(summary.totalInflowUsd.toFixed(2));
  summary.totalOutflowUsd = Number(summary.totalOutflowUsd.toFixed(2));
  summary.netFlowUsd = Number((summary.totalInflowUsd - summary.totalOutflowUsd).toFixed(2));

  // Keep original 11 column names first for backward compatibility, followed by full accounting columns
  const header = [
    "id",
    "created_at",
    "account_type",
    "type",
    "status",
    "amount",
    "amount_raw",
    "decimals",
    "chain",
    "tx_hash",
    "narration",
    "direction",
    "category",
    "type_label",
    "fiat_currency",
    "fiat_amount",
    "signed_usd_amount",
    "counterparty_name",
    "counterparty_bank",
    "counterparty_account",
  ];

  const lines = [header.join(",")];
  for (const r of deduped) {
    const rawAmt = r.amount_micro ?? r.amount ?? "";
    const decimals = r.decimals ?? 18;
    const signedStr = r.isCredit
      ? Number(r.usdAmount.toFixed(6)).toString()
      : (-Number(r.usdAmount.toFixed(6))).toString();
    lines.push(
      [
        r.id,
        r.created_at || "",
        r.account_type || "personal",
        r.type || "",
        r.status || "",
        formatAmountFromRaw(rawAmt, decimals),
        rawAmt,
        decimals,
        r.chain || "arc",
        r.tx_hash || "",
        r.narration || "",
        r.direction,
        r.category,
        r.typeLabel,
        r.fiatCurrency || "",
        r.fiatAmount != null ? r.fiatAmount : "",
        signedStr,
        r.counterpartyName || "",
        r.counterpartyBank || "",
        r.counterpartyAccount || "",
      ]
        .map(csvCell)
        .join(",")
    );
  }

  return {
    rows: deduped,
    summary,
    csv: `${lines.join("\r\n")}\r\n`,
  };
}

module.exports = {
  CREDIT_TX_TYPES,
  TX_HUMAN_LABELS,
  isCreditType,
  getHumanTxLabel,
  classifyCategory,
  formatAmountFromRaw,
  parseUsdAmount,
  extractInboundSenderDetails,
  formatCounterpartyDetail,
  enrichTransactionRow,
  buildAccountStatement,
};
