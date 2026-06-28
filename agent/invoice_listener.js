// agent/invoice_listener.js
// Background payment listener for invoice validation
// 
// Monitors incoming transactions to invoice payment addresses
// Auto-confirms payment when exact amount received
// Sends notification to user

const invoiceHd = require("../src/invoice_hd");
const invoiceDb = require("../src/invoice_db");

let listenerActive = false;
let checkInterval = null;

// Cache of known payment addresses to monitor
let watchedAddresses = new Map();

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

  console.log(`[invoice_listener] Starting... (poll interval: ${pollIntervalMs}ms)`);
  listenerActive = true;

  // Rebuild watched addresses on startup
  rebuildWatchList();

  // Periodic check for new invoices and payments
  checkInterval = setInterval(async () => {
    try {
      // Refresh list of unpaid invoices to monitor
      const unpaidInvoices = invoiceDb.db
        .prepare("SELECT * FROM invoices WHERE status = 'unpaid' AND payment_address IS NOT NULL")
        .all();

      // Update watch list
      for (const inv of unpaidInvoices) {
        if (!watchedAddresses.has(inv.payment_address)) {
          watchedAddresses.set(inv.payment_address, {
            invoiceId: inv.id,
            invoiceNumber: inv.invoice_number,
            telegramId: inv.telegram_id,
            expectedAmountMicro: inv.expected_amount_micro,
            lastChecked: 0
          });
        }
      }

      // Check each watched address for recent transactions
      for (const [address, metadata] of watchedAddresses) {
        try {
          const txs = await getRecentTransactionsTo(arcProvider, address);
          
          for (const tx of txs) {
            // Skip if already recorded
            if (metadata.lastChecked >= tx.blockNumber) continue;

            // Validate payment
            const result = await invoiceHd.validateAndConfirmPayment(address, tx.hash);
            
            if (result) {
              // Notify user
              try {
                await bot.telegram.sendMessage(
                  result.telegramId || metadata.telegramId,
                  `✅ *Payment Confirmed!*\n\n` +
                  `Invoice: #${result.invoiceNumber}\n` +
                  `From: ${result.clientName}\n` +
                  `Amount: ${result.totalUsdc} USDC\n` +
                  `Tx: \`${result.txHash.slice(0, 16)}...\``,
                  { parse_mode: "Markdown" }
                );
              } catch (notifyErr) {
                console.error(`[invoice_listener] Failed to notify user:`, notifyErr.message);
              }

              // Remove from watch list (invoice is paid)
              watchedAddresses.delete(address);
            }

            metadata.lastChecked = tx.blockNumber;
          }
        } catch (err) {
          console.error(`[invoice_listener] Error checking ${address}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[invoice_listener] Polling error:", err.message);
    }
  }, pollIntervalMs);
}

/**
 * Stop listening for invoice payments
 */
function stopInvoiceListener() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  listenerActive = false;
  watchedAddresses.clear();
  console.log("[invoice_listener] Stopped");
}

/**
 * Rebuild watch list from current unpaid invoices
 */
function rebuildWatchList() {
  watchedAddresses.clear();
  try {
    const unpaidInvoices = invoiceDb.db
      .prepare("SELECT * FROM invoices WHERE status = 'unpaid' AND payment_address IS NOT NULL")
      .all();

    for (const inv of unpaidInvoices) {
      watchedAddresses.set(inv.payment_address, {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        telegramId: inv.telegram_id,
        expectedAmountMicro: inv.expected_amount_micro,
        lastChecked: 0
      });
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
    return result;
  } catch (err) {
    console.error("[invoice_listener] checkTransactionForInvoice error:", err.message);
    return null;
  }
}

module.exports = {
  startInvoiceListener,
  stopInvoiceListener,
  rebuildWatchList,
  checkTransactionForInvoice,
  getWatchedAddresses: () => Array.from(watchedAddresses.keys())
};
