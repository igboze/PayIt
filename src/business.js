// src/business.js
// SME Financial Hub — Invoicing, expense management, and financial summaries.

const db = require("./db");
const bizDb = require("./biz_db");
const invoiceDb = require("./invoice_db");
const walletLib = require("./wallet");
const fx = require("./fx");

/**
 * Generate a comprehensive Cash Flow summary for a business user.
 *
 * @param {number} telegramId
 * @param {string} [businessDepositAddress]
 * @returns {Promise<object>}
 */
async function generateCashFlowBriefing(telegramId, businessDepositAddress) {
  const now = new Date();
  const address = businessDepositAddress || (db.getUser(telegramId)?.business_deposit_address);

  // Get business invoices and transactions
  const invoices = bizDb.getUserBizInvoices ? bizDb.getUserBizInvoices(telegramId) : [];
  const paidInvoices = invoices.filter((i) => i.status === "paid");
  const unpaidInvoices = invoices.filter((i) => i.status === "unpaid");
  const overdueInvoices = unpaidInvoices.filter((i) => i.due_date && new Date(i.due_date) < now);

  const revenue = paidInvoices.reduce((sum, i) => sum + (Number(i.total_usdc) || 0), 0);
  const outstanding = unpaidInvoices.reduce((sum, i) => sum + (Number(i.total_usdc) || 0), 0);

  // Business wallet balance
  let balanceUsdc = 0;
  if (address && walletLib.isValidAddress(address)) {
    try {
      const balanceMicro = await walletLib.getNativeBalanceMicro(address);
      balanceUsdc = parseFloat(walletLib.formatMicro(balanceMicro));
    } catch {}
  }

  // Get financial summary from db
  const finSummary = db.getFinancialSummary(telegramId);
  const liveNgnRate = await fx.getUsdToNgnRate();

  return {
    balanceUsdc,
    revenue,
    outstanding,
    paidCount: paidInvoices.length,
    unpaidCount: unpaidInvoices.length,
    overdueCount: overdueInvoices.length,
    paidThisMonthUsdc: finSummary?.paidThisMonth || 0,
    paidAllTimeUsdc: finSummary?.paidAllTime || 0,
    liveNgnRate,
  };
}

/**
 * Format Cash Flow briefing message for Telegram.
 */
function formatCashFlowBriefing(data) {
  const rate = data.liveNgnRate || 1620;
  const balanceNgn = Math.round(data.balanceUsdc * rate);
  const revenueNgn = Math.round(data.revenue * rate);
  const outstandingNgn = Math.round(data.outstanding * rate);

  return (
    `📈 <b>Good morning! Here is your Business Daily Snapshot:</b>\n` +
    `──────────────────────────\n` +
    `💼 <b>Treasury Balance:</b> $${data.balanceUsdc.toFixed(2)} USDC (≈ ₦${balanceNgn.toLocaleString()})\n` +
    `📥 <b>Total Invoiced Revenue:</b> $${data.revenue.toFixed(2)} USDC (≈ ₦${revenueNgn.toLocaleString()})\n` +
    `⏳ <b>Outstanding Invoices:</b> $${data.outstanding.toFixed(2)} USDC (≈ ₦${outstandingNgn.toLocaleString()}) [${data.unpaidCount} unpaid]\n` +
    `📊 <b>Settled This Month:</b> $${(data.paidThisMonthUsdc || 0).toFixed(2)} USDC\n\n` +
    `${data.overdueCount > 0 ? `⚠️ <b>${data.overdueCount} overdue invoice(s)</b> — remember to send reminders!` : "✅ <b>All invoices in good standing!</b>"}`
  );
}

module.exports = {
  generateCashFlowBriefing,
  formatCashFlowBriefing,
};
