// src/savings.js
// Yield pool discovery via DeFiLlama public API + in-DB simulation
// No real funds move — this is a testnet demo of yield tracking UX

const axios = require("axios");
const db    = require("./db");

const PAYIT_FEE_FRACTION = 0.10; // PayIT keeps 10% of APY
const DEMO_SPEED = parseFloat(process.env.SAVINGS_DEMO_SPEED || "1");

// Allowlist: only audited, established lending protocols
const ALLOWED_PROJECTS = ["aave-v3", "aave-v2", "compound-v3", "compound-v2", "spark", "spark-savings", "morpho-blue", "sky"];
const STABLECOIN_SYMBOLS = ["USDC", "USDT", "DAI", "SUSDE", "USDE", "SUSDS", "SDAI", "USDS"];

async function getYieldPools() {
  const res = await axios.get("https://yields.llama.fi/pools", { timeout: 8000 });
  const pools = res.data.data
    .filter(p =>
      ALLOWED_PROJECTS.some(proj => p.project?.toLowerCase().includes(proj)) &&
      STABLECOIN_SYMBOLS.some(sym => p.symbol?.toUpperCase().includes(sym)) &&
      typeof p.apy === "number" && p.apy > 0 && p.apy < 30
    )
    .sort((a, b) => b.apy - a.apy)
    .slice(0, 5)
    .map(p => ({
      symbol:   p.symbol,
      project:  p.project,
      chain:    p.chain,
      rawApy:   p.apy,
      userApy:  parseFloat((p.apy * (1 - PAYIT_FEE_FRACTION)).toFixed(2)),
      payitApy: parseFloat((p.apy * PAYIT_FEE_FRACTION).toFixed(2)),
    }));
  if (!pools.length) throw new Error("No qualifying pools found.");
  return pools;
}

function formatYieldList(pools) {
  const lines = pools.map((p, i) =>
    `${i + 1}. ${p.symbol} · ${p.project} · ${p.chain}\n` +
    `   Your APY: ${p.userApy}%  (PayIT fee: ${p.payitApy}%)`
  ).join("\n\n");
  return `📈 Live Yield Pools\n──────────────────────────\n${lines}\n\n⚠️ Testnet demo — no real funds move.`;
}

function openYieldPosition(telegramId, amountUsdc, pool) {
  db.openYieldPosition(telegramId, amountUsdc, pool);
}

function calcAccruedYield(position) {
  const openedAt  = new Date(position.opened_at).getTime();
  const elapsedMs = (Date.now() - openedAt) * DEMO_SPEED;
  const elapsedYears = elapsedMs / (1000 * 60 * 60 * 24 * 365);
  return position.amount_usdc * (position.apy / 100) * elapsedYears;
}

function formatPosition(position) {
  const accrued = calcAccruedYield(position);
  return (
    `📊 Your Yield Position\n──────────────────────────\n` +
    `Principal: $${position.amount_usdc.toFixed(2)} USDC\n` +
    `Pool: ${position.symbol} · ${position.project} · ${position.chain}\n` +
    `APY: ${position.apy}%\n` +
    `Opened: ${position.opened_at}\n` +
    `Accrued yield: +$${accrued.toFixed(4)} USDC\n` +
    `Current total: $${(position.amount_usdc + accrued).toFixed(4)} USDC\n\n` +
    `⚠️ Testnet demo — simulated interest only.`
  );
}

module.exports = { getYieldPools, formatYieldList, openYieldPosition, calcAccruedYield, formatPosition };
