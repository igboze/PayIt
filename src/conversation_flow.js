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

function shouldReprocessConversationState(stateType, text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  if (stateType === "await_withdraw_amount") {
    const amount = parseFloat(normalized.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(amount) && amount > 0) return false;
    return isLikelyNewIntent(normalized) || isGeneralChat(normalized);
  }

  if (stateType === "await_withdraw_bank") {
    const parts = normalized.split(/[·,\-|]/).map((s) => s.trim()).filter(Boolean);
    const accountNumber = (parts[1] || "").replace(/\D/g, "") || null;
    if (accountNumber && accountNumber.length >= 6) return false;
    return isLikelyNewIntent(normalized) || isGeneralChat(normalized) || parts.length === 0;
  }

  return false;
}

module.exports = {
  isGeneralChat,
  isLikelyNewIntent,
  shouldReprocessConversationState,
};
