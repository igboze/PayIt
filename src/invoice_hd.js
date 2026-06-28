// src/invoice_hd.js
// HD Wallet invoice integration
// Combines invoice creation with HD wallet address derivation
// Simplifies bot.js invoice command handling

const walletLib = require("./wallet");
const invoiceDb = require("./invoice_db");
const { parseToMicro } = require("./wallet");

/**
 * Create an invoice with a unique, HD-derived payment address
 * 
 * @param {number} telegramId - User's Telegram ID
 * @param {string} decryptedPrivateKey - User's decrypted master private key
 * @param {object} invoiceData - Invoice details
 * @returns {object} - Created invoice with payment address
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
    pngPath
  } = invoiceData;

  // Get next derivation index for this user
  const derivationIndex = invoiceDb.getNextDerivationIndex(telegramId);

  // Derive unique address for this invoice
  const { address: paymentAddress } = walletLib.deriveInvoiceAddress(
    decryptedPrivateKey,
    derivationIndex
  );

  // Convert amount to Arc's 18-decimal format (BigInt)
  const expectedAmountMicro = parseToMicro(String(totalUsdc));

  // Create invoice in database with HD address
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
    paymentAddress,        // Unique per invoice
    derivationIndex,       // Sequence for recovery
    expectedAmountMicro: expectedAmountMicro.toString() // Store as string
  });

  return {
    invoiceId,
    invoiceNumber,
    paymentAddress,
    expectedAmountMicro,
    derivationIndex,
    totalUsdc,
    clientName
  };
}

/**
 * Check if a payment to an invoice address is valid
 * Used by payment listener to auto-confirm receivals
 * 
 * @param {string} paymentAddress - Address that received payment
 * @param {string} txHash - Transaction hash
 * @returns {Promise<object|null>} - Invoice details if valid, null otherwise
 */
async function validateAndConfirmPayment(paymentAddress, txHash) {
  // Look up invoice by payment address
  const invoice = invoiceDb.getInvoiceByPaymentAddress(paymentAddress);
  
  if (!invoice) {
    console.log(`[invoice_hd] No invoice found for address ${paymentAddress}`);
    return null;
  }

  // Skip if already paid
  if (invoice.status === "paid") {
    console.log(`[invoice_hd] Invoice ${invoice.invoice_number} already marked paid`);
    return null;
  }

  // Validate payment on-chain
  const expectedAmountMicro = BigInt(invoice.expected_amount_micro);
  const isValid = await walletLib.validateInvoicePayment(
    invoice.id,
    expectedAmountMicro,
    txHash,
    paymentAddress
  );

  if (isValid) {
    // Mark paid with transaction hash
    invoiceDb.markInvoicePaidWithTxHash(invoice.id, txHash);
    console.log(`[invoice_hd] ✅ Invoice ${invoice.invoice_number} marked PAID via ${txHash}`);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      clientName: invoice.client_name,
      totalUsdc: invoice.total_usdc,
      txHash
    };
  } else {
    console.log(`[invoice_hd] ⚠️  Payment to ${paymentAddress} does not match invoice amount`);
    return null;
  }
}

/**
 * Get invoice details formatted for display
 */
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
    txHash: invoice.paid_tx_hash
  };
}

/**
 * Generate invoice QR code data
 * Encodes payment address and expected amount
 * Compatible with Arc wallet scanners
 */
function generateInvoiceQRData(paymentAddress, expectedAmountMicro) {
  const amount = expectedAmountMicro / BigInt(10 ** 18); // Convert to USDC
  return `ethereum:${paymentAddress}?value=${amount}`;
}

module.exports = {
  createHDInvoice,
  validateAndConfirmPayment,
  getInvoiceDisplay,
  generateInvoiceQRData
};
