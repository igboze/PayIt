function isGeneralChat(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|no|yes|please|help|what|who|why|when|where|how|can you|i need|i want|tell me|show me|check|review|looks good|noted|fine|cool|sure|thanks a lot)\b/.test(normalized)) {
    return true;
  }
  return false;
}

function isLikelyNewIntent(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  if (/^\//.test(lower)) return true;
  if (/^help|^balance|^history|^invoice|^contacts|^settings|^deposit|^bank|^send|^pay|^cash out|^withdraw/.test(lower)) {
    return true;
  }
  if (/0x[a-fA-F0-9]{40}/.test(lower)) return true;
  if (/\b(send|pay|invoice|cash out|withdraw|schedule|autopay|auto-pay|deposit|balance|history)\b/.test(lower)) return true;
  return false;
}

/**
 * Determines whether the current conversation state should be re‑processed based on the
 * user's latest input.
 */
function shouldReprocessConversationState(stateType, text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  // Numeric amount states
  if (
    stateType === "await_withdraw_amount" ||
    stateType === "await_ccw_amount" ||
    stateType === "await_near_amount" ||
    stateType === "await_solana_amount" ||
    stateType === "await_robinhood_amount" ||
    stateType === "await_starknet_amount" ||
    stateType === "move_funds_amount"
  ) {
    const amount = parseFloat(normalized.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(amount) && amount > 0) return false;
    // If the user typed something that looks like a new intent, re‑process
    return isLikelyNewIntent(normalized) || isGeneralChat(normalized);
  }

  // Address or token identifier states
  if (
    stateType === "await_ccw_address" ||
    stateType === "await_near_custom_token" ||
    stateType === "await_withdraw_narration"
  ) {
    // Detect valid Ethereum or NEAR addresses and do not reprocess
    const isEthereumAddress = /^0x[0-9a-fA-F]{40}$/.test(normalized);
    const isNearAddress = /^[\w.-]+\.near$/i.test(normalized);
    if (isEthereumAddress || isNearAddress) return false;
    // Reprocess for slash commands, generic chat, or other new intents
    if (/^\//.test(normalized) || isGeneralChat(normalized) || isLikelyNewIntent(normalized)) return true;
    return false;
  }

  // Bank withdrawal details
  if (stateType === "await_withdraw_bank") {
    const parts = normalized
      .split(/[·,\-|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const accountNumber = (parts[1] || "").replace(/\D/g, "") || null;
    if (accountNumber && accountNumber.length >= 6) return false;
    return isLikelyNewIntent(normalized) || isGeneralChat(normalized) || parts.length === 0;
  }

  // Default – no re‑processing needed
  return false;
}

module.exports = {
  isGeneralChat,
  isLikelyNewIntent,
  shouldReprocessConversationState,
};
