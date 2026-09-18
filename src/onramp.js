// src/onramp.js
// Circle Onramp Integration — Direct fiat-to-USDC onboarding to Arc

const { getNetworkConfig } = require("./network");

const DEFAULT_ONRAMP_BASE = process.env.CIRCLE_ONRAMP_URL || "https://onramp.circle.com";

/**
 * Generate a Circle Onramp checkout URL pre-filled with the user's Arc wallet address.
 *
 * @param {string} walletAddress - User's 0x Arc address
 * @param {object} [options]
 * @param {string} [options.fiatCurrency="USD"] - USD, EUR, GBP, etc.
 * @param {number|string} [options.fiatAmount] - Optional suggested amount
 * @param {string} [options.redirectUrl] - Callback URL after checkout
 * @returns {string} Fully configured onramp URL
 */
function buildCircleOnrampUrl(walletAddress, options = {}) {
  const net = getNetworkConfig();
  const base = process.env.CIRCLE_ONRAMP_URL || DEFAULT_ONRAMP_BASE;
  const url = new URL(base);

  url.searchParams.set("destinationAddress", walletAddress);
  url.searchParams.set("destinationAsset", "USDC");
  url.searchParams.set("destinationNetwork", net.isTestnet ? "arc-testnet" : "arc");
  url.searchParams.set("fiatCurrency", options.fiatCurrency || "USD");

  if (options.fiatAmount) {
    url.searchParams.set("fiatAmount", String(options.fiatAmount));
  }
  if (options.redirectUrl) {
    url.searchParams.set("redirectUrl", options.redirectUrl);
  }
  const kitKey = process.env.CIRCLE_KIT_KEY || process.env.KIT_KEY || process.env.ARC_API_KEY;
  if (kitKey) {
    url.searchParams.set("apiKey", kitKey);
  }
  if (process.env.CIRCLE_APP_ID) {
    url.searchParams.set("appId", process.env.CIRCLE_APP_ID);
  }

  return url.toString();
}

/**
 * Return formatted details for the bot's Circle Onramp screen.
 */
function getOnrampDetails(walletAddress) {
  const net = getNetworkConfig();
  const onrampUrl = buildCircleOnrampUrl(walletAddress);

  return {
    networkName: net.name,
    walletAddress,
    onrampUrl,
    supportedMethods: ["Debit / Credit Card (Visa, Mastercard)", "Apple Pay", "Google Pay"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD"],
  };
}

module.exports = {
  buildCircleOnrampUrl,
  getOnrampDetails,
};
