// src/invoice_hd.js
// Production HD Wallet & Dynamic Fiat Virtual Account Invoice Integration
// Combines on-chain unique payment addresses (Arc Mainnet) + dedicated Wema Bank virtual accounts (Paj v2)
// Embeds address QR codes directly onto the invoice card

const walletLib = require("./wallet");
const invoiceDb = require("./invoice_db");
const bizDb = require("./biz_db");
const paj = require("./paj");
const multichain = require("./multichain");
const { generateInvoicePNG } = require("./invoice_generator");
const db = require("./db");

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
async function createCompleteInvoice({ telegramId, decryptedPrivateKey, user, invoiceData }) {
  const {
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    totalUsdc,
    dueDate,
    notes,
    issueDate = new Date().toISOString().split("T")[0],
    businessName,
  } = invoiceData;

  // 1. Dedicated on-chain address
  const derivationIndex = invoiceDb.getNextDerivationIndex(telegramId);
  const derived = walletLib.deriveInvoiceAddress(decryptedPrivateKey, derivationIndex);
  const paymentAddress = derived.address;
  const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
    derived.childPrivateKey,
    process.env.INVOICE_FORWARDING_SECRET
  );
  const expectedAmountMicro = walletLib.parseToMicro(String(totalUsdc));

  // 2. Dedicated dynamic fiat virtual account via Paj v2
  let fiatDetails = null;
  try {
    const rates = await paj.getRates("NGN");
    const rate = rates?.onRampRate?.rate || 1388.75;
    const fiatAmount = Math.round(Number(totalUsdc) * rate);

    const solAddr =
      user.solana_deposit_address ||
      multichain.deriveSolanaFromEvmKey(decryptedPrivateKey).solanaAddress;

    const order = await paj.createOnrampOrder({
      fiatAmount,
      currency: "NGN",
      recipient: solAddr,
      chain: "SOLANA",
      userExternalId: invoiceNumber,
      description: `Payment for Invoice #${invoiceNumber}`,
      businessUSDCFee: 0,
    });

    if (order && order.accountNumber) {
      fiatDetails = {
        accountNumber: order.accountNumber,
        bankName: order.bank || "Wema Bank PLC",
        accountName: order.accountName || `PayIT / ${clientName}`,
        fiatAmount: order.fiatAmount || fiatAmount,
        orderId: order.id,
        rate,
      };
    }
  } catch (err) {
    console.warn("[invoice_hd] Dynamic fiat account creation notice:", err.message);
  }

  // 3. Render PNG card with embedded QR code and dual payment methods
  const pngPath = await generateInvoicePNG({
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    dueDate,
    notes,
    businessName: businessName || user.username || `User ${telegramId}`,
    walletAddress: paymentAddress,
    issueDate,
    currency: "USDC",
    fiatDetails,
  });

  // 4. Save to DB with main wallet address as settlement destination
  const mainWalletAddress = user.deposit_address;
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

  if (fiatDetails) {
    invoiceDb.updateInvoiceFiatDetails(invoiceId, {
      fiatAccountNumber: fiatDetails.accountNumber,
      fiatBankName: fiatDetails.bankName,
      fiatAccountName: fiatDetails.accountName,
      fiatAmount: fiatDetails.fiatAmount,
      fiatOrderId: fiatDetails.orderId,
      fiatRate: fiatDetails.rate,
    });
  }

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    clientName,
    fiatDetails,
    pngPath,
    mainWalletAddress,
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
    totalUsdc,
    dueDate,
    notes,
    issueDate = new Date().toISOString().split("T")[0],
  } = invoiceData;

  // 1. Dedicated on-chain address from business key
  const derivationIndex = bizDb.getNextBizDerivationIndex(telegramId);
  const derived = walletLib.deriveInvoiceAddress(decryptedBizKey, derivationIndex);
  const paymentAddress = derived.address;
  const invoicePrivateKeyEncrypted = walletLib.encryptSensitiveValue(
    derived.childPrivateKey,
    process.env.INVOICE_FORWARDING_SECRET
  );
  const expectedAmountMicro = walletLib.parseToMicro(String(totalUsdc));

  // 2. Dedicated dynamic fiat virtual account via Paj v2
  let fiatDetails = null;
  try {
    const rates = await paj.getRates("NGN");
    const rate = rates?.onRampRate?.rate || 1388.75;
    const fiatAmount = Math.round(Number(totalUsdc) * rate);

    const solAddr =
      user.solana_deposit_address ||
      multichain.deriveSolanaFromEvmKey(decryptedBizKey).solanaAddress;

    const order = await paj.createOnrampOrder({
      fiatAmount,
      currency: "NGN",
      recipient: solAddr,
      chain: "SOLANA",
      userExternalId: invoiceNumber,
      description: `Payment for Invoice #${invoiceNumber}`,
      businessUSDCFee: 0,
    });

    if (order && order.accountNumber) {
      fiatDetails = {
        accountNumber: order.accountNumber,
        bankName: order.bank || "Wema Bank PLC",
        accountName: order.accountName || `${profile?.business_name || "PayIT"} / ${clientName}`,
        fiatAmount: order.fiatAmount || fiatAmount,
        orderId: order.id,
        rate,
      };
    }
  } catch (err) {
    console.warn("[biz_invoice_hd] Dynamic fiat account creation notice:", err.message);
  }

  // 3. Render PNG card with embedded QR code, logo, and dual payment options
  const pngPath = await generateInvoicePNG({
    invoiceNumber,
    clientName,
    clientEmail,
    items,
    dueDate,
    notes,
    businessName: profile?.business_name || user.username || `User ${telegramId}`,
    businessEmail: profile?.business_email || null,
    businessPhone: profile?.phone || null,
    businessAddress: profile?.address || null,
    logoDataUri: profile ? require("./biz_profile").getLogoDataUri(telegramId) : null,
    walletAddress: paymentAddress,
    issueDate,
    currency: "USDC",
    fiatDetails,
  });

  // 4. Save to DB with business wallet address as settlement destination
  const mainWalletAddress = user.business_deposit_address || user.deposit_address;
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

  if (fiatDetails) {
    bizDb.updateBizInvoiceFiatDetails(invoiceId, {
      fiatAccountNumber: fiatDetails.accountNumber,
      fiatBankName: fiatDetails.bankName,
      fiatAccountName: fiatDetails.accountName,
      fiatAmount: fiatDetails.fiatAmount,
      fiatOrderId: fiatDetails.orderId,
      fiatRate: fiatDetails.rate,
    });
  }

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    clientName,
    fiatDetails,
    pngPath,
    mainWalletAddress,
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
  createHDInvoice,
  createCompleteInvoice,
  createCompleteBizInvoice,
  validateAndConfirmPayment,
  getInvoiceDisplay,
  generateInvoiceQRData,
};
