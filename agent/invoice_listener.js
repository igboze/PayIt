// agent/invoice_listener.js
// Background payment listener for invoice validation
// 
// Monitors incoming transactions to invoice payment addresses
// Auto-confirms payment when exact amount received
// Sends notification to user

const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const invoiceHd = require("../src/invoice_hd");
const invoiceDb = require("../src/invoice_db");
const bizDb = require("../src/biz_db");
const walletLib = require("../src/wallet");

const DEFAULT_FEE_RECIPIENT_ADDRESS = "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359";

let listenerActive = false;
let pollTimer = null;
let pollInFlight = false;

// Cache of known payment addresses to monitor
let watchedAddresses = new Map();

function getConfiguredSettlementContractAddress() {
  const configuredRaw = process.env.INVOICE_SETTLEMENT_CONTRACT_ADDRESS || process.env.INVOICE_SETTLEMENT_ADDRESS || "";
  if (configuredRaw) {
    const validated = walletLib.getValidatedAddress(configuredRaw);
    if (!validated) {
      throw new Error(`Invalid invoice settlement contract address configured in INVOICE_SETTLEMENT_CONTRACT_ADDRESS: ${configuredRaw}`);
    }
    return validated;
  }

  if (process.env.INVOICE_SETTLEMENT_USE_DEPLOYMENT_FALLBACK !== "true") {
    return null;
  }

  const deploymentPath = path.join(__dirname, "..", "deployments", "invoice-settlement-address.txt");
  if (!fs.existsSync(deploymentPath)) {
    return null;
  }

  const deploymentAddress = fs.readFileSync(deploymentPath, "utf8").trim();
  return walletLib.getValidatedAddress(deploymentAddress);
}

/**
 * Start monitoring for invoice payments
 * Re-queries database for active invoices periodically
 * 
 * @param {Telegraf} bot - Telegram bot instance
 * @param {Function} arcProvider - ethers.js provider
 * @param {number} pollIntervalMs - How often to check (default: 10 seconds)
 */
async function startInvoiceListener(bot, arcProvider, pollIntervalMs = 10000) {
  if (listenerActive) {
    console.log("[invoice_listener] Already active");
    return;
  }

  const settlementContractAddress = getConfiguredSettlementContractAddress();
  console.log(`[invoice_listener] Starting... (poll interval: ${pollIntervalMs}ms)`);
  if (settlementContractAddress) {
    console.log(`[invoice_listener] Settlement contract: ${settlementContractAddress}`);
  } else {
    console.log("[invoice_listener] Settlement contract: not configured");
  }
  listenerActive = true;
  pollInFlight = false;

  // Rebuild watched addresses on startup
  rebuildWatchList();

  scheduleNextPoll(bot, arcProvider, pollIntervalMs);
}

function scheduleNextPoll(bot, arcProvider, pollIntervalMs) {
  if (!listenerActive) return;

  if (pollTimer) {
    clearTimeout(pollTimer);
  }

  pollTimer = setTimeout(async () => {
    if (!listenerActive || pollInFlight) {
      scheduleNextPoll(bot, arcProvider, pollIntervalMs);
      return;
    }

    pollInFlight = true;
    try {
      await pollInvoices(bot, arcProvider);
    } catch (err) {
      console.error("[invoice_listener] Polling error:", err.message);
    } finally {
      pollInFlight = false;
      if (listenerActive) {
        scheduleNextPoll(bot, arcProvider, pollIntervalMs);
      }
    }
  }, pollIntervalMs);
}

async function pollInvoices(bot, arcProvider) {
  const unpaidInvoices = invoiceDb.getUnpaidPersonalInvoices();
  const unpaidBizInvoices = bizDb.getUnpaidBizInvoices();

  // Update watch list for personal invoices
  for (const inv of unpaidInvoices) {
    if (!watchedAddresses.has(inv.payment_address)) {
      watchedAddresses.set(inv.payment_address, {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        telegramId: inv.telegram_id,
        expectedAmountMicro: inv.expected_amount_micro,
        type: "personal",
        address: inv.payment_address,
        lastChecked: 0,
      });
    }
  }

  // Update watch list for business invoices
  for (const inv of unpaidBizInvoices) {
    const address = inv.payment_address || inv.wallet_address;
    if (!address) continue;
    if (!watchedAddresses.has(address)) {
      watchedAddresses.set(address, {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        telegramId: inv.telegram_id,
        expectedAmountMicro: inv.expected_amount_micro || walletLib.parseToMicro(String(inv.total_usdc)).toString(),
        type: "business",
        address,
        lastChecked: 0,
      });
    }
  }

  // Check each watched address for recent transactions
  for (const [address, metadata] of watchedAddresses) {
    try {
      const txs = await getRecentTransactionsTo(arcProvider, address);

      let confirmed = false;
      for (const tx of txs) {
        // Skip if already recorded
        if (metadata.lastChecked >= tx.blockNumber) continue;

        // Validate payment based on invoice type
        let result = null;
        if (metadata.type === "personal") {
          result = await invoiceHd.validateAndConfirmPayment(address, tx.hash);
        } else if (metadata.type === "business") {
          result = await validateBizInvoicePayment(address, tx.hash);
        }

        if (result) {
          confirmed = true;
          try {
            result.settlementTxHash = await settleInvoiceFunds(result.invoiceId, metadata.type);
          } catch (err) {
            console.error(`[invoice_listener] Settlement failed for invoice ${result.invoiceId}:`, err.message);
          }
          await notifyInvoicePaid(bot, result, metadata, "tx");
          // Remove from watch list (invoice is paid)
          watchedAddresses.delete(address);
        }

        metadata.lastChecked = tx.blockNumber;
      }

      if (!confirmed) {
        const expected = BigInt(metadata.expectedAmountMicro);
        const balance = await arcProvider.getBalance(address);
        if (balance >= expected && expected > 0n) {
          let result = null;
          if (metadata.type === "personal") {
            result = await confirmPersonalPaymentByBalance(address, metadata);
          } else {
            result = await confirmBusinessPaymentByBalance(address, metadata);
          }

          if (result) {
            try {
              result.settlementTxHash = await settleInvoiceFunds(result.invoiceId, metadata.type);
            } catch (err) {
              console.error(`[invoice_listener] Settlement failed for invoice ${result.invoiceId}:`, err.message);
            }
            await notifyInvoicePaid(bot, result, metadata, "balance");
            watchedAddresses.delete(address);
          }
        }
      }
    } catch (err) {
      console.error(`[invoice_listener] Error checking ${address}:`, err.message);
    }
  }
}

/**
 * Stop listening for invoice payments
 */
function stopInvoiceListener() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  listenerActive = false;
  pollInFlight = false;
  watchedAddresses.clear();
  console.log("[invoice_listener] Stopped");
}

/**
 * Rebuild watch list from current unpaid invoices
 */
function rebuildWatchList() {
  watchedAddresses.clear();
  try {
    const unpaidInvoices = invoiceDb.getUnpaidPersonalInvoices();
    const unpaidBizInvoices = bizDb.getUnpaidBizInvoices();

    for (const inv of unpaidInvoices) {
      if (inv.payment_address) {
        watchedAddresses.set(inv.payment_address, {
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          telegramId: inv.telegram_id,
          expectedAmountMicro: inv.expected_amount_micro,
          type: "personal",
          lastChecked: 0
        });
      }
    }

    for (const inv of unpaidBizInvoices) {
      const address = inv.payment_address || inv.wallet_address;
      if (address) {
        watchedAddresses.set(address, {
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          telegramId: inv.telegram_id,
          expectedAmountMicro: inv.expected_amount_micro || walletLib.parseToMicro(String(inv.total_usdc)).toString(),
          type: "business",
          lastChecked: 0
        });
      }
    }

    console.log(`[invoice_listener] Loaded ${watchedAddresses.size} unpaid invoices to watch`);
  } catch (err) {
    console.error("[invoice_listener] Failed to rebuild watch list:", err.message);
  }
}

/**
 * Get recent transactions to an address
 * Uses basic polling (can be improved with event filters on live providers)
 */
async function getRecentTransactionsTo(provider, toAddress) {
  try {
    const currentBlock = await provider.getBlockNumber();
    const blocksToCheck = 20; // scan the most recent blocks
    const fromBlock = Math.max(0, currentBlock - blocksToCheck);
    const txs = [];

    for (let blockNumber = fromBlock; blockNumber <= currentBlock; blockNumber += 1) {
      const block = await provider.getBlockWithTransactions(blockNumber);
      if (!block || !Array.isArray(block.transactions)) continue;
      for (const tx of block.transactions) {
        if (tx.to && tx.to.toLowerCase() === toAddress.toLowerCase()) {
          txs.push(tx);
        }
      }
    }

    return txs;
  } catch (err) {
    console.error("[invoice_listener] getRecentTransactionsTo error:", err.message);
    return [];
  }
}

/**
 * Manually check a specific transaction for invoice payments
 * Useful for user-initiated "check payment" command
 */
async function checkTransactionForInvoice(txHash, provider) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;

    // Validate against any invoice with matching recipient
    const result = await invoiceHd.validateAndConfirmPayment(receipt.to, txHash);
    if (result) return result;

    const bizResult = await validateBizInvoicePayment(receipt.to, txHash);
    return bizResult;
  } catch (err) {
    console.error("[invoice_listener] checkTransactionForInvoice error:", err.message);
    return null;
  }
}

async function notifyInvoicePaid(bot, result, metadata, method) {
  const address = result.paymentAddress || metadata.address || "(unknown)";
  const invoiceType = metadata.type === "business" ? "Business Invoice" : "Invoice";
  const amount = result.totalUsdc || "unknown";
  const clientName = result.clientName || "Customer";
  const txLine = result.txHash ? `Tx: \`${result.txHash.slice(0, 16)}...\`\n` : "";
  const settlementLine = result.settlementTxHash
    ? `Settlement Tx: \`${result.settlementTxHash.slice(0, 16)}...\`\n`
    : "";
  const methodLine = method === "balance"
    ? "_Auto-confirmed by invoice address balance check._"
    : "_Auto-confirmed by transaction scan._";

  const unpaidPersonal = invoiceDb.getUserInvoices(result.telegramId, 20)
    .filter(inv => inv.status === "unpaid" && inv.id !== result.invoiceId)
    .slice(0, 5);
  const unpaidBiz = bizDb.getBizInvoices(result.telegramId, 20)
    .filter(inv => inv.status === "unpaid" && inv.id !== result.invoiceId)
    .slice(0, 5);

  const unpaidLines = [];
  if (unpaidPersonal.length) {
    unpaidLines.push("#UNPAID PERSONAL");
    unpaidLines.push(...unpaidPersonal.map(inv => `• ${inv.invoice_number} · $${inv.total_usdc} · ${inv.client_name}${inv.due_date ? ` · Due ${inv.due_date}` : ""}`));
  }
  if (unpaidBiz.length) {
    unpaidLines.push("#UNPAID BUSINESS");
    unpaidLines.push(...unpaidBiz.map(inv => `• ${inv.invoice_number} · $${inv.total_usdc} · ${inv.client_name}${inv.due_date ? ` · Due ${inv.due_date}` : ""}`));
  }
  if (!unpaidLines.length) {
    unpaidLines.push("#UNPAID None");
  }

  const unpaidSection = `\n\n${unpaidLines.join("\n")}`;

  try {
    await bot.telegram.sendMessage(
      result.telegramId || metadata.telegramId,
      `#PAID ✅ *Payment Confirmed!*\n\n` +
      `${invoiceType}: #${result.invoiceNumber}\n` +
      `Client: ${clientName}\n` +
      `Amount: ${amount} USDC\n` +
      `Address: \`${address}\`\n` +
      txLine +
      settlementLine +
      `${methodLine}` +
      unpaidSection,
      { parse_mode: "Markdown" }
    );
  } catch (notifyErr) {
    console.error(`[invoice_listener] Failed to notify user:`, notifyErr.message);
  }
}

async function validateBizInvoicePayment(address, txHash) {
  const invoice = bizDb.getBizInvoiceByWalletAddress(address);
  if (!invoice) {
    return null;
  }
  if (invoice.status === "paid") {
    return null;
  }

  const expectedAmountMicro = invoice.expected_amount_micro
    ? BigInt(invoice.expected_amount_micro)
    : walletLib.parseToMicro(String(invoice.total_usdc));

  const isValid = await walletLib.validateInvoicePayment(
    invoice.id,
    expectedAmountMicro,
    txHash,
    address
  );

  if (isValid) {
    bizDb.markBizInvoicePaidWithTxHash(invoice.id, txHash);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      clientName: invoice.client_name,
      totalUsdc: invoice.total_usdc,
      paymentAddress: address,
      txHash,
      invoice,
    };
  }
  return null;
}

async function confirmPersonalPaymentByBalance(address, metadata) {
  const invoice = invoiceDb.getInvoiceByPaymentAddress(address);
  if (!invoice || invoice.status === "paid") return null;
  invoiceDb.markInvoicePaidWithTxHash(invoice.id, null);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    clientName: invoice.client_name,
    totalUsdc: invoice.total_usdc,
    paymentAddress: address,
    txHash: null,
    invoice,
  };
}

async function confirmBusinessPaymentByBalance(address, metadata) {
  const invoice = bizDb.getBizInvoiceByWalletAddress(address);
  if (!invoice || invoice.status === "paid") return null;
  bizDb.markBizInvoicePaid(invoice.id);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    clientName: invoice.client_name,
    totalUsdc: invoice.total_usdc,
    paymentAddress: address,
    txHash: null,
    invoice,
  };
}

function getSettlementDestination(invoice) {
  return invoice?.wallet_address || invoice?.payment_address || null;
}

async function settleInvoiceFunds(invoiceId, type) {
  let invoice = null;
  if (type === "personal") {
    invoice = invoiceDb.getInvoice(invoiceId);
  } else if (type === "business") {
    invoice = bizDb.getBizInvoice(invoiceId);
  }

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found for settlement`);
  }

  const encryptedKey = invoice.invoice_private_key_encrypted;
  if (!encryptedKey) {
    // No child key stored; payment likely landed on a primary wallet address.
    return null;
  }

  const secret = process.env.INVOICE_FORWARDING_SECRET || "payit-invoice-fallback-secret";
  const childPrivateKey = walletLib.decryptSensitiveValue(encryptedKey, secret);
  const signer = walletLib.walletFromPrivateKey(childPrivateKey);
  const destination = getSettlementDestination(invoice);
  const provider = signer.provider || walletLib.getProvider?.();
  const balance = provider ? await provider.getBalance(signer.address) : 0n;
  if (balance === 0n) {
    return null;
  }

  const settlementContractAddress = getConfiguredSettlementContractAddress();

  const feeRecipientRaw = process.env.APP_FEE_RECIPIENT_ADDRESS || process.env.FEE_RECIPIENT_ADDRESS || DEFAULT_FEE_RECIPIENT_ADDRESS;
  const feeRecipient = walletLib.getValidatedAddress(feeRecipientRaw);
  if (!settlementContractAddress && !feeRecipient) {
    throw new Error(`Invalid fee recipient address configured in APP_FEE_RECIPIENT_ADDRESS or FEE_RECIPIENT_ADDRESS: ${feeRecipientRaw}`);
  }

  const feeBps = BigInt(process.env.INVOICE_SETTLEMENT_FEE_BPS || "100");
  const minFee = walletLib.parseToMicro(process.env.INVOICE_SETTLEMENT_MIN_FEE_USDC || "0.25");
  const maxFee = walletLib.parseToMicro(process.env.INVOICE_SETTLEMENT_MAX_FEE_USDC || "2");

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice) {
    throw new Error("Unable to determine gas price for settlement transaction.");
  }

  if (settlementContractAddress) {
    const contractAbi = [
      "function settleInvoice(uint256 invoiceId, address recipient, uint16 feeBps, uint256 minFee, uint256 maxFee, uint256 total) returns (bool)"
    ];
    const settlementContract = new ethers.Contract(settlementContractAddress, contractAbi, signer);

    const feeBpsNumber = Number(feeBps);
    if (feeBpsNumber > 65535) {
      throw new Error("INVOICE_SETTLEMENT_FEE_BPS must be <= 65535 for contract settlement.");
    }

    const totalAmount = balance;
    if (totalAmount <= 0n) {
      throw new Error("Insufficient invoice balance to settle with the contract.");
    }

    const gasLimit = await settlementContract.estimateGas.settleInvoice(
      invoiceId,
      destination,
      feeBpsNumber,
      minFee,
      maxFee,
      totalAmount
    );

    const txOptions = { gasLimit };
    if (feeData.maxFeePerGas) {
      txOptions.maxFeePerGas = feeData.maxFeePerGas;
      if (feeData.maxPriorityFeePerGas) {
        txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      }
    } else {
      txOptions.gasPrice = feeData.gasPrice;
    }

    const tx = await settlementContract.settleInvoice(
      invoiceId,
      destination,
      feeBpsNumber,
      minFee,
      maxFee,
      totalAmount,
      txOptions
    );
    const receipt = await tx.wait();
    const settlementTxHash = receipt.hash;

    if (type === "personal") {
      invoiceDb.updateInvoiceSettlementTxHash(invoiceId, settlementTxHash);
    } else {
      bizDb.updateBizInvoiceSettlementTxHash(invoiceId, settlementTxHash);
    }

    return settlementTxHash;
  }

  if (!feeRecipient || feeBps <= 0n) {
    const gasLimit = await signer.estimateGas({ to: destination, value: 0n });
    const fee = gasLimit * gasPrice;
    const amountToSend = balance > fee ? balance - fee : 0n;
    if (amountToSend <= 0n) {
      throw new Error("Insufficient invoice balance to cover settlement fee.");
    }

    const txOptions = { to: destination, value: amountToSend, gasLimit };
    if (feeData.maxFeePerGas) {
      txOptions.maxFeePerGas = feeData.maxFeePerGas;
      if (feeData.maxPriorityFeePerGas) {
        txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      }
    } else {
      txOptions.gasPrice = feeData.gasPrice;
    }

    const tx = await signer.sendTransaction(txOptions);
    const receipt = await tx.wait();
    const settlementTxHash = receipt.hash;

    if (type === "personal") {
      invoiceDb.updateInvoiceSettlementTxHash(invoiceId, settlementTxHash);
    } else {
      bizDb.updateBizInvoiceSettlementTxHash(invoiceId, settlementTxHash);
    }

    return settlementTxHash;
  }

  // Legacy fee forwarding path: send fee then remainder to destination.
  const feeTxGasLimit = await signer.estimateGas({ to: feeRecipient, value: 0n });
  const destTxGasLimit = await signer.estimateGas({ to: destination, value: 0n });
  const feeTxCost = feeTxGasLimit * gasPrice;
  const destTxCost = destTxGasLimit * gasPrice;
  const availableForValue = balance > feeTxCost + destTxCost ? balance - feeTxCost - destTxCost : 0n;

  if (availableForValue <= 0n) {
    throw new Error("Insufficient invoice balance to cover settlement gas and fees.");
  }

  let feeAmount = (availableForValue * feeBps) / 10000n;
  if (feeAmount < minFee) feeAmount = minFee;
  if (feeAmount > maxFee) feeAmount = maxFee;
  if (feeAmount >= availableForValue) {
    feeAmount = availableForValue / 10n;
  }

  const destinationAmount = availableForValue - feeAmount;
  if (destinationAmount <= 0n) {
    throw new Error("Insufficient invoice balance after fee calculation.");
  }

  const feeTxOptions = { to: feeRecipient, value: feeAmount, gasLimit: feeTxGasLimit };
  const destTxOptions = { to: destination, value: destinationAmount, gasLimit: destTxGasLimit };

  if (feeData.maxFeePerGas) {
    feeTxOptions.maxFeePerGas = feeData.maxFeePerGas;
    destTxOptions.maxFeePerGas = feeData.maxFeePerGas;
    if (feeData.maxPriorityFeePerGas) {
      feeTxOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      destTxOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    }
  } else {
    feeTxOptions.gasPrice = feeData.gasPrice;
    destTxOptions.gasPrice = feeData.gasPrice;
  }

  const feeTx = await signer.sendTransaction(feeTxOptions);
  await feeTx.wait();
  const tx = await signer.sendTransaction(destTxOptions);
  const receipt = await tx.wait();
  const settlementTxHash = receipt.hash;

  if (type === "personal") {
    invoiceDb.updateInvoiceSettlementTxHash(invoiceId, settlementTxHash);
  } else {
    bizDb.updateBizInvoiceSettlementTxHash(invoiceId, settlementTxHash);
  }

  return settlementTxHash;
}

module.exports = {
  startInvoiceListener,
  stopInvoiceListener,
  rebuildWatchList,
  checkTransactionForInvoice,
  settleInvoiceFunds,
  getSettlementDestination,
  getWatchedAddresses: () => Array.from(watchedAddresses.keys())
};
