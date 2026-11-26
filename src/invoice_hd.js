// src/invoice_hd.js
// Production HD Wallet & Dynamic Fiat Virtual Account Invoice Integration
// Combines on-chain unique payment addresses (Arc Mainnet) + dedicated Wema Bank virtual accounts (Paj v2)
// Embeds address QR codes directly onto the invoice card

const walletLib = require("./wallet");
const nearLib = require("./near");
const invoiceDb = require("./invoice_db");
const bizDb = require("./biz_db");
const paj = require("./paj");
const multichain = require("./multichain");
const nuvion = require("./nuvion");
const nuvionOrchestrator = require("./nuvion_orchestrator");
const { generateInvoicePNG, buildClientInvoiceCopyText } = require("./invoice_generator");
const db = require("./db");

function isTier1VerifiedForInvoice(telegramId, accountType = "personal") {
  try {
    if (!nuvion.isUserAllowedNuvion(telegramId)) return false;
    const entity = db.getNuvionEntityByUser(telegramId, accountType);
    return Boolean(entity && String(entity.status).toLowerCase() === "approved");
  } catch (_) {
    return false;
  }
}

async function provisionNuvionBankForInvoice({
  telegramId,
  accountType = "personal",
  bankCurrency = "USD",
  invoiceCurrency = "USD",
  totalNative = null,
  totalUsdc = 0,
  totalNgn = 0,
  fallbackBeneficiary = "Proxim Account",
}) {
  const code = String(bankCurrency || "USD").toUpperCase();
  const invCur = String(invoiceCurrency || "USD").toUpperCase();
  const res = await nuvionOrchestrator.provisionGlobalReceivingAccount(telegramId, accountType, code);
  const d = res?.detail;
  if (!d || (!d.account_number && !d.iban)) {
    return { pending: true, currency: code, detail: d || null };
  }
  const meta = nuvionOrchestrator.CURRENCY_META?.[code] || { railHint: "Bank Transfer" };
  let fiatAmount = null;
  if (code === "NGN") fiatAmount = totalNgn;
  else if (code === invCur && totalNative != null) fiatAmount = Number(totalNative);
  else if (code === "USD") fiatAmount = totalUsdc;

  return {
    pending: false,
    provider: "global_bank",
    currency: code,
    railHint: meta.railHint || "Bank Transfer",
    bankName: d.bank_name || "Global Partner Bank",
    accountNumber: d.account_number || null,
    iban: d.iban || null,
    routingNumber: d.routing_number || null,
    sortCode: d.sort_code || null,
    swiftCode: d.swift_code || null,
    accountName: d.beneficiary_name || res?.entity?.legal_name || fallbackBeneficiary,
    fiatAmount,
    orderId: d.detail_id || null,
    rate: code === "NGN" && totalUsdc > 0 ? Number((totalNgn / totalUsdc).toFixed(2)) : 1,
  };
}

const INVOICE_CRYPTO_CHAINS = {
  sol_usdc: {
    id: "sol_usdc",
    label: "Solana (USDC)",
    shortLabel: "☀️ Solana · USDC",
    chainLabel: "Solana",
    tokenSymbol: "USDC",
    decimals: 6,
    assetId: nearLib.ASSETS.SOL_USDC,
    viaNearIntents: true,
  },
  near_usdc: {
    id: "near_usdc",
    label: "NEAR (USDC)",
    shortLabel: "Ⓝ NEAR · USDC",
    chainLabel: "NEAR Protocol",
    tokenSymbol: "USDC",
    decimals: 6,
    assetId: nearLib.ASSETS.NEAR_USDC,
    viaNearIntents: true,
  },
  near_usdt: {
    id: "near_usdt",
    label: "NEAR (USDT)",
    shortLabel: "Ⓝ NEAR · USDT",
    chainLabel: "NEAR Protocol",
    tokenSymbol: "USDT",
    decimals: 6,
    assetId: nearLib.ASSETS.NEAR_USDT,
    viaNearIntents: true,
  },
  sol_usdt: {
    id: "sol_usdt",
    label: "Solana (USDT)",
    shortLabel: "☀️ Solana · USDT",
    chainLabel: "Solana",
    tokenSymbol: "USDT",
    decimals: 6,
    assetId: nearLib.ASSETS.SOL_USDT,
    viaNearIntents: true,
  },
  hood_usdg: {
    id: "hood_usdg",
    label: "Robinhood Chain (USDG)",
    shortLabel: "🪶 Robinhood · USDG",
    chainLabel: "Robinhood Chain",
    tokenSymbol: "USDG",
    decimals: 6,
    assetId: nearLib.ASSETS.HOOD_USDG,
    viaNearIntents: true,
  },
  arc: {
    id: "arc",
    label: "Arc Mainnet (USDC)",
    shortLabel: "🔵 Arc Mainnet · USDC",
    chainLabel: "Arc Mainnet",
    tokenSymbol: "USDC",
    decimals: 6,
    assetId: null,
    viaNearIntents: false,
  },
};

async function provisionPajNairaAccount({
  fiatAmount,
  totalUsdc,
  recipientArcAddress,
  decryptedPrivateKey,
  invoiceNumber,
  accountLabel,
  rate,
}) {
  const invoiceFeeBps = Number(process.env.INVOICE_PROCESSING_FEE_BPS ?? 50);
  const invoiceFeeUsdc = Number((Number(totalUsdc) * (invoiceFeeBps / 10000)).toFixed(4));

  let order = null;
  if (paj.isArcOnrampEnabled() && recipientArcAddress) {
    try {
      order = await paj.createOnrampOrder({
        fiatAmount,
        currency: "NGN",
        recipient: recipientArcAddress,
        mint: paj.RAILS.arc.mint,
        chain: paj.RAILS.arc.chain,
        userExternalId: invoiceNumber,
        description: `Payment for Invoice #${invoiceNumber}`,
        businessUSDCFee: invoiceFeeUsdc,
      });
    } catch (arcErr) {
      console.warn("[invoice_hd] Dynamic Arc fiat onramp fallback to Solana:", arcErr.message);
    }
  }

  if (!order) {
    const solAddr = multichain.deriveSolanaFromEvmKey(decryptedPrivateKey).solanaAddress;
    order = await paj.createOnrampOrder({
      fiatAmount,
      currency: "NGN",
      recipient: solAddr,
      chain: paj.RAILS.solana.chain,
      mint: paj.RAILS.solana.mint,
      userExternalId: invoiceNumber,
      description: `Payment for Invoice #${invoiceNumber}`,
      businessUSDCFee: invoiceFeeUsdc,
    });
  }

  if (order && order.accountNumber) {
    return {
      accountNumber: order.accountNumber,
      bankName: order.bank || "Wema Bank PLC",
      accountName: order.accountName || accountLabel,
      fiatAmount: order.fiatAmount || fiatAmount,
      orderId: order.id,
      rate,
    };
  }
  return null;
}

async function provisionInvoiceCryptoIntent({
  telegramId,
  accountType = "personal",
  cryptoChain = "arc",
  cryptoAssetId = null,
  cryptoSymbol = null,
  cryptoBlockchain = null,
  totalUsdc,
  mainWalletAddress,
  decryptedPrivateKey,
  fallbackArcAddress,
}) {
  const exactAmount = Number(Number(totalUsdc || 0).toFixed(2));
  const rawChainKey = String(cryptoChain || "arc").trim().toLowerCase();

  // Support ANY live NEAR Intents token/chain (e.g. Base ETH/USDC, Arbitrum USDC, Polygon USDT, BTC, TON, SOL, NEAR, etc.)
  if (cryptoAssetId || (rawChainKey && rawChainKey !== "arc" && !INVOICE_CRYPTO_CHAINS[rawChainKey])) {
    try {
      const normalizedChain = typeof nearLib.normalizeIntentChainKey === "function"
        ? nearLib.normalizeIntentChainKey(cryptoBlockchain || rawChainKey)
        : (cryptoBlockchain || rawChainKey);
      let token = null;
      if (typeof nearLib.resolveIntentToken === "function") {
        token = await nearLib.resolveIntentToken({
          chain: normalizedChain,
          symbol: cryptoSymbol || undefined,
          assetId: cryptoAssetId || undefined,
        });
      }
      if (token && typeof nearLib.createUniversalCryptoDeposit === "function") {
        const meta = typeof nearLib.getChainMeta === "function"
          ? nearLib.getChainMeta(token.blockchain || normalizedChain)
          : { isEvm: false, name: token.blockchain || normalizedChain };
        // Compute token amount for non-stablecoins using live token price if available
        const tokenPriceUsd = Number(token.priceUsd || 0);
        const isStable = /^(USDC|USDT|USDG|DAI|USDC\.E|USDT0)$/i.test(String(token.symbol || ""));
        const tokenAmount = !isStable && tokenPriceUsd > 0
          ? Number((exactAmount / tokenPriceUsd).toFixed(Math.min(Number(token.decimals || 6), 6)))
          : exactAmount;
        let refundTo = mainWalletAddress;
        let refundType = "ORIGIN_CHAIN";
        if (!meta.isEvm) {
          if ((token.blockchain === "sol" || normalizedChain === "sol") && decryptedPrivateKey) {
            refundTo = multichain.deriveSolanaFromEvmKey(decryptedPrivateKey).solanaAddress;
          } else if ((token.blockchain === "near" || normalizedChain === "near") && decryptedPrivateKey) {
            refundTo = nearLib.deriveNearAddress(decryptedPrivateKey).nearAddress;
          } else if (decryptedPrivateKey) {
            refundTo = nearLib.deriveNearAddress(decryptedPrivateKey).nearAddress;
            refundType = "INTENTS";
          }
        }
        const dep = await nearLib.createUniversalCryptoDeposit({
          telegramId,
          accountType,
          originAsset: token.assetId,
          originSymbol: token.symbol,
          originDecimals: token.decimals,
          amount: tokenAmount,
          recipientAddress: mainWalletAddress,
          refundTo,
          refundType,
        });
        if (dep && dep.deposit_address) {
          return {
            chainId: `${token.blockchain || normalizedChain}_${String(token.symbol || "").toLowerCase()}`,
            chainLabel: meta.name || String(token.blockchain || normalizedChain).toUpperCase(),
            tokenSymbol: token.symbol,
            assetId: token.assetId,
            exactAmount: tokenAmount,
            exactAmountUsd: exactAmount,
            depositAddress: dep.deposit_address,
            depositMemo: dep.deposit_memo || null,
            viaNearIntents: true,
            intentId: dep.id || null,
            deadline: dep.deadline || null,
          };
        }
      }
    } catch (err) {
      console.warn(`[invoice_hd] Universal NEAR Intents (${cryptoAssetId || rawChainKey}) quote failed:`, err.message);
    }
  }

  const cfg = INVOICE_CRYPTO_CHAINS[rawChainKey] || INVOICE_CRYPTO_CHAINS.arc;

  if (!cfg.viaNearIntents) {
    return {
      chainId: "arc",
      chainLabel: "Arc Mainnet",
      tokenSymbol: "USDC",
      exactAmount,
      depositAddress: fallbackArcAddress,
      depositMemo: null,
      viaNearIntents: false,
      intentId: null,
      deadline: null,
    };
  }

  try {
    let dep = null;
    if (cfg.id === "near_usdc" || cfg.id === "near_usdt") {
      const refundTo = nearLib.deriveNearAddress(decryptedPrivateKey).nearAddress;
      dep = await nearLib.createNearDeposit({
        telegramId,
        accountType,
        originAsset: cfg.assetId,
        originSymbol: cfg.tokenSymbol,
        originDecimals: cfg.decimals,
        amount: exactAmount,
        recipientAddress: mainWalletAddress,
        refundTo,
      });
    } else if (cfg.id === "sol_usdc" || cfg.id === "sol_usdt") {
      const refundTo = multichain.deriveSolanaFromEvmKey(decryptedPrivateKey).solanaAddress;
      dep = await nearLib.createSolanaDeposit({
        telegramId,
        accountType,
        originAsset: cfg.assetId,
        originSymbol: cfg.tokenSymbol,
        originDecimals: cfg.decimals,
        amount: exactAmount,
        recipientAddress: mainWalletAddress,
        refundTo,
      });
    } else if (cfg.id === "hood_usdg") {
      dep = await nearLib.createRobinhoodDeposit({
        telegramId,
        accountType,
        originAsset: cfg.assetId,
        originSymbol: cfg.tokenSymbol,
        originDecimals: cfg.decimals,
        amount: exactAmount,
        recipientAddress: mainWalletAddress,
        refundTo: mainWalletAddress,
      });
    }

    if (dep && dep.deposit_address) {
      return {
        chainId: cfg.id,
        chainLabel: cfg.chainLabel,
        tokenSymbol: cfg.tokenSymbol,
        exactAmount,
        depositAddress: dep.deposit_address,
        depositMemo: dep.deposit_memo || null,
        viaNearIntents: true,
        intentId: dep.id || null,
        deadline: dep.deadline || null,
      };
    }
  } catch (err) {
    console.warn(`[invoice_hd] NEAR Intents (${cfg.id}) quote failed, falling back to Arc HD address:`, err.message);
  }

  return {
    chainId: "arc",
    chainLabel: "Arc Mainnet",
    tokenSymbol: "USDC",
    exactAmount,
    depositAddress: fallbackArcAddress,
    depositMemo: null,
    viaNearIntents: false,
    intentId: null,
    deadline: null,
    fallbackFrom: cfg.label,
  };
}

/**
 * Legacy HD invoice creation helper.
 */
function createHDInvoice(telegramId, decryptedPrivateKey, invoiceData) {
  const {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc,
    dueDate,
    notes,
    walletAddress,
    pngPath,
  } = invoiceData;

  const derivationIndex = invoiceDb.getNextDerivationIndex(telegramId);
  const derived = walletLib.deriveInvoiceAddress(decryptedPrivateKey, derivationIndex);
  const paymentAddress = derived.address;
  let nearAddress = null;
  try { nearAddress = nearLib.deriveNearAddress(derived.childPrivateKey).nearAddress; } catch (_) { }
  const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
    derived.childPrivateKey,
    process.env.INVOICE_FORWARDING_SECRET
  );

  const expectedAmountMicro = walletLib.parseToMicro(String(totalUsdc));

  const invoiceId = invoiceDb.createInvoiceWithHDAddress(telegramId, {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc,
    dueDate,
    notes,
    walletAddress,
    pngPath,
    paymentAddress,
    derivationIndex,
    expectedAmountMicro: expectedAmountMicro.toString(),
    invoicePrivateKeyEncrypted,
  });

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    clientName,
  };
}

/**
 * Create a complete Personal Invoice:
 * 1. Derives a dedicated on-chain address on Arc Mainnet for this transaction alone.
 * 2. Generates a dedicated single-order Naira virtual account via Paj v2 for this transaction alone.
 * 3. Renders the PNG invoice card with embedded QR code and dual payment methods.
 * 4. Records both in SQLite for automated settlement to the user's main wallet.
 */
async function createCompleteInvoice({ telegramId, decryptedPrivateKey, user, invoiceData, businessName: bizNameArg }) {
  const {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc: rawTotalUsdc,
    totalNgn: rawTotalNgn = null,
    invoiceCurrency: rawCurrency = "USD",
    paymentChannel = "both", // "ngn_bank" | "nuvion_bank" | "crypto_intent" | "both" | "both_nuvion"
    nuvionBankCurrency = "USD",
    cryptoChain = "arc",     // "arc" | "near_usdc" | "sol_usdc" | or any NEAR Intent chain/token
    cryptoAssetId = null,
    cryptoSymbol = null,
    cryptoBlockchain = null,
    dueDate,
    notes,
    issueDate = new Date().toISOString().split("T")[0],
    businessName,
  } = invoiceData;

  const invoiceCurrency = String(rawCurrency || "USD").toUpperCase();
  const wantPajFiat = paymentChannel === "ngn_bank" || paymentChannel === "both";
  const wantNuvionBank = paymentChannel === "nuvion_bank" || paymentChannel === "both_nuvion";
  const wantCrypto = paymentChannel === "crypto_intent" || paymentChannel === "both" || paymentChannel === "both_nuvion";

  // Resolve FX rate when NGN currency or NGN bank transfer is needed
  let rate = 1388.75;
  if (invoiceCurrency === "NGN" || wantPajFiat || (wantNuvionBank && String(nuvionBankCurrency).toUpperCase() === "NGN")) {
    try {
      const rates = await paj.getRates("NGN");
      rate = rates?.onRampRate?.rate || 1388.75;
    } catch (err) {
      console.warn("[invoice_hd] Paj rate fetch notice:", err.message);
    }
  }

  const itemsSum = (items || []).reduce(
    (s, i) => s + (Number(i.quantity || 1) || 1) * (Number(i.unitPrice || 0) || 0),
    0
  );
  const totalNative = Number((rawTotalNgn != null && invoiceCurrency === "NGN" ? Number(rawTotalNgn) : (rawTotalUsdc != null ? Number(rawTotalUsdc) : itemsSum)).toFixed(2));
  const totalNgn = invoiceCurrency === "NGN"
    ? Math.round(rawTotalNgn != null ? Number(rawTotalNgn) : itemsSum)
    : Math.round(Number(rawTotalUsdc || itemsSum) * rate);
  const totalUsdc = invoiceCurrency === "NGN"
    ? Number((totalNgn / rate).toFixed(2))
    : Number(Number(rawTotalUsdc != null ? rawTotalUsdc : itemsSum).toFixed(2));

  // 1. Dedicated on-chain address (always derived for DB tracking & Arc settlement)
  const derivationIndex = invoiceDb.getNextDerivationIndex(telegramId);
  const derived = walletLib.deriveInvoiceAddress(decryptedPrivateKey, derivationIndex);
  const paymentAddress = derived.address;
  let nearAddress = null;
  try { nearAddress = nearLib.deriveNearAddress(derived.childPrivateKey).nearAddress; } catch (_) { }
  const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
    derived.childPrivateKey,
    process.env.INVOICE_FORWARDING_SECRET
  );
  const expectedAmountMicro = walletLib.parseToMicro(String(totalUsdc));
  const mainWalletAddress = user.deposit_address;
  const senderDisplayName = businessName || bizNameArg || user.username || `User ${telegramId}`;

  // 2. Bank Transfer Provisioning (Tier-1 Global Bank via Nuvion OR Tier-0 Paj v2 NGN)
  let fiatDetails = null;
  let fiatPendingCurrency = null;
  if (wantNuvionBank) {
    try {
      const bankRes = await provisionNuvionBankForInvoice({
        telegramId,
        accountType: "personal",
        bankCurrency: nuvionBankCurrency,
        invoiceCurrency,
        totalNative,
        totalUsdc,
        totalNgn,
        fallbackBeneficiary: senderDisplayName,
      });
      if (bankRes && !bankRes.pending) {
        fiatDetails = bankRes;
      } else {
        fiatPendingCurrency = String(nuvionBankCurrency || "USD").toUpperCase();
        // If NGN global bank is still pending activation, fall back to Paj instant NGN account
        if (fiatPendingCurrency === "NGN") {
          fiatDetails = await provisionPajNairaAccount({
            fiatAmount: totalNgn,
            totalUsdc,
            recipientArcAddress: mainWalletAddress,
            decryptedPrivateKey,
            invoiceNumber,
            accountLabel: `Proxim / ${clientName}`,
            rate,
          });
          if (fiatDetails) fiatPendingCurrency = null;
        }
      }
    } catch (err) {
      console.warn("[invoice_hd] Global bank account provisioning notice:", err.message);
      fiatPendingCurrency = String(nuvionBankCurrency || "USD").toUpperCase();
    }
  } else if (wantPajFiat) {
    try {
      fiatDetails = await provisionPajNairaAccount({
        fiatAmount: totalNgn,
        totalUsdc,
        recipientArcAddress: mainWalletAddress,
        decryptedPrivateKey,
        invoiceNumber,
        accountLabel: `Proxim / ${clientName}`,
        rate,
      });
    } catch (err) {
      console.warn("[invoice_hd] Dynamic fiat account creation notice:", err.message);
    }
  }

  // 3. Crypto / NEAR Intents exact-amount checkout (if Crypto channel selected)
  let cryptoPaymentDetails = null;
  if (wantCrypto) {
    cryptoPaymentDetails = await provisionInvoiceCryptoIntent({
      telegramId,
      accountType: "personal",
      cryptoChain,
      cryptoAssetId,
      cryptoSymbol,
      cryptoBlockchain,
      totalUsdc,
      mainWalletAddress,
      decryptedPrivateKey,
      fallbackArcAddress: paymentAddress,
    });
  }

  // 4. Render PNG card with only the selected payment channel(s)
  const pngPath = await generateInvoicePNG({
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    dueDate,
    notes,
    businessName: senderDisplayName,
    logoDataUri: require("./biz_profile").getLogoDataUri(telegramId),
    walletAddress: wantCrypto ? (cryptoPaymentDetails?.depositAddress || paymentAddress) : null,
    cryptoPaymentDetails,
    nearAddress: wantCrypto ? nearAddress : null,
    issueDate,
    currency: invoiceCurrency,
    fiatDetails,
  });

  // 5. Save to DB with main wallet address as settlement destination
  const invoiceId = invoiceDb.createInvoiceWithHDAddress(telegramId, {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc,
    dueDate,
    notes,
    walletAddress: mainWalletAddress,
    pngPath,
    paymentAddress,
    derivationIndex,
    expectedAmountMicro: expectedAmountMicro.toString(),
    invoicePrivateKeyEncrypted,
  });

  if (nearAddress) { try { invoiceDb.db.prepare("UPDATE invoices SET near_address = ? WHERE id = ?").run(nearAddress, invoiceId); } catch (_) { } }
  if (fiatDetails && (fiatDetails.accountNumber || fiatDetails.iban)) {
    invoiceDb.updateInvoiceFiatDetails(invoiceId, {
      fiatAccountNumber: fiatDetails.accountNumber || fiatDetails.iban,
      fiatBankName: fiatDetails.bankName,
      fiatAccountName: fiatDetails.accountName,
      fiatAmount: fiatDetails.fiatAmount || totalUsdc,
      fiatOrderId: fiatDetails.orderId,
      fiatRate: fiatDetails.rate || 1,
    });
  }

  const clientCopyText = buildClientInvoiceCopyText({
    invoiceNumber,
    businessName: senderDisplayName,
    clientName,
    currency: invoiceCurrency,
    totalUsdc,
    totalNgn,
    dueDate,
    fiatDetails,
    cryptoPaymentDetails,
    walletAddress: wantCrypto ? (cryptoPaymentDetails?.depositAddress || paymentAddress) : null,
  });

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    totalNgn,
    invoiceCurrency,
    paymentChannel,
    nuvionBankCurrency: wantNuvionBank ? nuvionBankCurrency : null,
    fiatPendingCurrency,
    cryptoChain,
    clientName,
    fiatDetails,
    cryptoPaymentDetails,
    pngPath,
    mainWalletAddress,
    nearAddress,
    clientCopyText,
  };
}

/**
 * Create a complete Business Invoice:
 * 1. Derives a dedicated on-chain address on Arc Mainnet for this transaction alone from the Business key.
 * 2. Generates a dedicated single-order Naira virtual account via Paj v2 for this transaction alone.
 * 3. Renders the PNG invoice card with embedded QR code, business logo, and dual payment methods.
 * 4. Records both in SQLite for automated settlement to the SME's main business wallet.
 */
async function createCompleteBizInvoice({ telegramId, decryptedBizKey, user, invoiceData, profile }) {
  const {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc: rawTotalUsdc,
    totalNgn: rawTotalNgn = null,
    invoiceCurrency: rawCurrency = "USD",
    paymentChannel = "both", // "ngn_bank" | "nuvion_bank" | "crypto_intent" | "both" | "both_nuvion"
    nuvionBankCurrency = "USD",
    cryptoChain = "arc",
    cryptoAssetId = null,
    cryptoSymbol = null,
    cryptoBlockchain = null,
    dueDate,
    notes,
    issueDate = new Date().toISOString().split("T")[0],
  } = invoiceData;

  const invoiceCurrency = String(rawCurrency || "USD").toUpperCase();
  const wantPajFiat = paymentChannel === "ngn_bank" || paymentChannel === "both";
  const wantNuvionBank = paymentChannel === "nuvion_bank" || paymentChannel === "both_nuvion";
  const wantCrypto = paymentChannel === "crypto_intent" || paymentChannel === "both" || paymentChannel === "both_nuvion";

  let rate = 1388.75;
  if (invoiceCurrency === "NGN" || wantPajFiat || (wantNuvionBank && String(nuvionBankCurrency).toUpperCase() === "NGN")) {
    try {
      const rates = await paj.getRates("NGN");
      rate = rates?.onRampRate?.rate || 1388.75;
    } catch (err) {
      console.warn("[biz_invoice_hd] Paj rate fetch notice:", err.message);
    }
  }

  const itemsSum = (items || []).reduce(
    (s, i) => s + (Number(i.quantity || 1) || 1) * (Number(i.unitPrice || 0) || 0),
    0
  );
  const totalNative = Number((rawTotalNgn != null && invoiceCurrency === "NGN" ? Number(rawTotalNgn) : (rawTotalUsdc != null ? Number(rawTotalUsdc) : itemsSum)).toFixed(2));
  const totalNgn = invoiceCurrency === "NGN"
    ? Math.round(rawTotalNgn != null ? Number(rawTotalNgn) : itemsSum)
    : Math.round(Number(rawTotalUsdc || itemsSum) * rate);
  const totalUsdc = invoiceCurrency === "NGN"
    ? Number((totalNgn / rate).toFixed(2))
    : Number(Number(rawTotalUsdc != null ? rawTotalUsdc : itemsSum).toFixed(2));

  // 1. Dedicated on-chain address from business key
  const derivationIndex = bizDb.getNextBizDerivationIndex(telegramId);
  const derived = walletLib.deriveInvoiceAddress(decryptedBizKey, derivationIndex);
  const paymentAddress = derived.address;
  let nearAddress = null;
  try { nearAddress = nearLib.deriveNearAddress(derived.childPrivateKey).nearAddress; } catch (_) { }
  const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
    derived.childPrivateKey,
    process.env.INVOICE_FORWARDING_SECRET
  );
  const expectedAmountMicro = walletLib.parseToMicro(String(totalUsdc));
  const mainWalletAddress = user.business_deposit_address || user.deposit_address;
  const bizDisplayName = profile?.business_name || user.username || `User ${telegramId}`;

  // 2. Bank Transfer Provisioning (Tier-1 Global Bank via Nuvion OR Tier-0 Paj v2 NGN)
  let fiatDetails = null;
  let fiatPendingCurrency = null;
  if (wantNuvionBank) {
    try {
      const bankRes = await provisionNuvionBankForInvoice({
        telegramId,
        accountType: "business",
        bankCurrency: nuvionBankCurrency,
        invoiceCurrency,
        totalNative,
        totalUsdc,
        totalNgn,
        fallbackBeneficiary: bizDisplayName,
      });
      if (bankRes && !bankRes.pending) {
        fiatDetails = bankRes;
      } else {
        fiatPendingCurrency = String(nuvionBankCurrency || "USD").toUpperCase();
        if (fiatPendingCurrency === "NGN") {
          fiatDetails = await provisionPajNairaAccount({
            fiatAmount: totalNgn,
            totalUsdc,
            recipientArcAddress: mainWalletAddress,
            decryptedPrivateKey: decryptedBizKey,
            invoiceNumber,
            accountLabel: `${profile?.business_name || "Proxim"} / ${clientName}`,
            rate,
          });
          if (fiatDetails) fiatPendingCurrency = null;
        }
      }
    } catch (err) {
      console.warn("[biz_invoice_hd] Global bank account provisioning notice:", err.message);
      fiatPendingCurrency = String(nuvionBankCurrency || "USD").toUpperCase();
    }
  } else if (wantPajFiat) {
    try {
      fiatDetails = await provisionPajNairaAccount({
        fiatAmount: totalNgn,
        totalUsdc,
        recipientArcAddress: mainWalletAddress,
        decryptedPrivateKey: decryptedBizKey,
        invoiceNumber,
        accountLabel: `${profile?.business_name || "Proxim"} / ${clientName}`,
        rate,
      });
    } catch (err) {
      console.warn("[biz_invoice_hd] Dynamic fiat account creation notice:", err.message);
    }
  }

  // 3. Crypto / NEAR Intents exact-amount checkout (if Crypto channel selected)
  let cryptoPaymentDetails = null;
  if (wantCrypto) {
    cryptoPaymentDetails = await provisionInvoiceCryptoIntent({
      telegramId,
      accountType: "business",
      cryptoChain,
      cryptoAssetId,
      cryptoSymbol,
      cryptoBlockchain,
      totalUsdc,
      mainWalletAddress,
      decryptedPrivateKey: decryptedBizKey,
      fallbackArcAddress: paymentAddress,
    });
  }

  // 4. Render PNG card with embedded QR code, business logo, and selected payment channel(s)
  const pngPath = await generateInvoicePNG({
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    dueDate,
    notes,
    businessName: bizDisplayName,
    businessEmail: profile?.business_email || null,
    businessPhone: profile?.phone || null,
    businessAddress: profile?.address || null,
    logoDataUri: profile ? require("./biz_profile").getLogoDataUri(telegramId) : null,
    walletAddress: wantCrypto ? (cryptoPaymentDetails?.depositAddress || paymentAddress) : null,
    cryptoPaymentDetails,
    nearAddress: wantCrypto ? nearAddress : null,
    issueDate,
    currency: invoiceCurrency,
    fiatDetails,
  });

  // 5. Save to DB with business wallet address as settlement destination
  const invoiceId = bizDb.createBizInvoiceWithHDAddress(telegramId, {
    invoiceNumber,
    clientName,
    clientEmail: clientEmail || null,
    items,
    totalUsdc,
    dueDate: dueDate || null,
    notes: notes || null,
    walletAddress: mainWalletAddress,
    paymentAddress,
    invoicePrivateKeyEncrypted,
    pngPath,
    derivationIndex,
    expectedAmountMicro: expectedAmountMicro.toString(),
  });

  if (nearAddress) { try { bizDb.db.prepare("UPDATE biz_invoices SET near_address = ? WHERE id = ?").run(nearAddress, invoiceId); } catch (_) { } }
  if (fiatDetails && (fiatDetails.accountNumber || fiatDetails.iban)) {
    bizDb.updateBizInvoiceFiatDetails(invoiceId, {
      fiatAccountNumber: fiatDetails.accountNumber || fiatDetails.iban,
      fiatBankName: fiatDetails.bankName,
      fiatAccountName: fiatDetails.accountName,
      fiatAmount: fiatDetails.fiatAmount || totalUsdc,
      fiatOrderId: fiatDetails.orderId,
      fiatRate: fiatDetails.rate || 1,
    });
  }

  const clientCopyText = buildClientInvoiceCopyText({
    invoiceNumber,
    businessName: bizDisplayName,
    clientName,
    currency: invoiceCurrency,
    totalUsdc,
    totalNgn,
    dueDate,
    fiatDetails,
    cryptoPaymentDetails,
    walletAddress: wantCrypto ? (cryptoPaymentDetails?.depositAddress || paymentAddress) : null,
  });

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    totalNgn,
    invoiceCurrency,
    paymentChannel,
    nuvionBankCurrency: wantNuvionBank ? nuvionBankCurrency : null,
    fiatPendingCurrency,
    cryptoChain,
    clientName,
    fiatDetails,
    cryptoPaymentDetails,
    pngPath,
    mainWalletAddress,
    nearAddress,
    clientCopyText,
  };
}

/**
 * Check if a payment to an invoice address is valid.
 */
async function validateAndConfirmPayment(paymentAddress, txHash) {
  const invoice = invoiceDb.getInvoiceByPaymentAddress(paymentAddress);
  if (!invoice) {
    console.log(`[invoice_hd] No invoice found for address ${paymentAddress}`);
    return null;
  }

  if (invoice.status === "paid") {
    console.log(`[invoice_hd] Invoice ${invoice.invoice_number} already marked paid`);
    return null;
  }

  const expectedAmountMicro = BigInt(invoice.expected_amount_micro);
  const isValid = await walletLib.validateInvoicePayment(
    invoice.id,
    expectedAmountMicro,
    txHash,
    paymentAddress
  );

  if (isValid) {
    invoiceDb.markInvoicePaidWithTxHash(invoice.id, txHash);
    try {
      db.recordTransaction(
        invoice.owner_telegram_id || invoice.telegram_id || 0,
        "invoice_payment",
        expectedAmountMicro,
        "confirmed",
        txHash,
        "personal"
      );
    } catch (recErr) {
      console.warn("[invoice_hd] Failed to record invoice transaction:", recErr.message);
    }
    console.log(`[invoice_hd] ✅ Invoice ${invoice.invoice_number} marked PAID via ${txHash}`);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      clientName: invoice.client_name,
      totalUsdc: invoice.total_usdc,
      paymentAddress,
      txHash,
    };
  } else {
    console.log(`[invoice_hd] ⚠️ Payment to ${paymentAddress} does not match invoice amount`);
    return null;
  }
}

function getInvoiceDisplay(invoiceId) {
  const invoice = invoiceDb.getInvoice(invoiceId);
  if (!invoice) return null;

  return {
    id: invoice.id,
    number: invoice.invoice_number,
    client: invoice.client_name,
    amount: invoice.total_usdc,
    paymentAddress: invoice.payment_address,
    status: invoice.status,
    createdAt: invoice.created_at,
    paidAt: invoice.paid_at,
    txHash: invoice.paid_tx_hash,
  };
}

function generateInvoiceQRData(paymentAddress, expectedAmountMicro) {
  const amount = Number(expectedAmountMicro) / 10 ** 18;
  return `ethereum:${paymentAddress}?value=${amount}`;
}

module.exports = {
  INVOICE_CRYPTO_CHAINS,
  isTier1VerifiedForInvoice,
  provisionNuvionBankForInvoice,
  provisionInvoiceCryptoIntent,
  createHDInvoice,
  createCompleteInvoice,
  createCompleteBizInvoice,
  validateAndConfirmPayment,
  getInvoiceDisplay,
  generateInvoiceQRData,
};
