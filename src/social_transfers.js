// src/social_transfers.js
// Social Transfers & Viral P2P Gifting on Telegram
// Supports:
//   1. Instant direct transfers between registered Proxim users (@username)
//   2. Viral claimable gift links for unregistered Telegram users
//   3. Auto-refunds on cancellation or 48-hour expiration

const crypto = require("crypto");
const db = require("./db");
const walletLib = require("./wallet");

/**
 * Platform escrow address used to hold funds while a gift link is pending.
 * Priority:
 *   1. Explicit SOCIAL_ESCROW_ADDRESS
 *   2. Derived address of RELAYER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY (so incoming
 *      escrow deposits directly fund the exact wallet that disburses claims/refunds)
 *   3. APP_FEE_RECIPIENT_ADDRESS / PAYIT_DEV_FEE_ADDRESS / default fallback
 */
function getEscrowHolderAddress() {
  if (process.env.SOCIAL_ESCROW_ADDRESS) {
    return process.env.SOCIAL_ESCROW_ADDRESS;
  }
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (relayerKey) {
    try {
      const signer = walletLib.walletFromPrivateKey(relayerKey);
      if (signer?.address) return signer.address;
    } catch (_) {}
  }
  return (
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359"
  );
}

/**
 * Generate a random 32-character hexadecimal claim token.
 */
function generateClaimToken() {
  return "clm_" + crypto.randomBytes(16).toString("hex");
}

/**
 * Extract the DB claim token from a Telegram /start payload.
 * Handles both "claim_clm_abc..." and direct "clm_abc..." safely.
 */
function extractClaimToken(startPayload) {
  if (!startPayload || typeof startPayload !== "string") return null;
  const s = startPayload.trim();
  if (s.startsWith("claim_")) {
    const token = s.slice("claim_".length).trim();
    return token || null;
  }
  if (s.startsWith("clm_")) {
    return s;
  }
  return null;
}

/**
 * Normalize a Telegram username from @handle, handle, or t.me/handle URL.
 * Returns lowercase handle (3-32 chars) or null if invalid.
 */
function normalizeTelegramHandle(input) {
  if (!input || typeof input !== "string") return null;
  let clean = input.trim();
  // Strip t.me / telegram.me URL prefixes
  clean = clean.replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "");
  clean = clean.replace(/^(?:t\.me|telegram\.me)\//i, "");
  // Strip query string, fragment, trailing slash
  clean = clean.split(/[/?#]/)[0];
  // Strip leading @ signs
  clean = clean.replace(/^@+/, "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(clean)) return null;
  return clean;
}

/**
 * Parse natural language or slash command for P2P sending.
 * Examples:
 *   "/send @chidi 25"          -> { username: "chidi", amount: 25 }
 *   "/pay @chidi $10"          -> { username: "chidi", amount: 10 }
 *   "/send $25 to @chidi"      -> { username: "chidi", amount: 25 }
 *   "send $10 to @alice"       -> { username: "alice", amount: 10 }
 *   "send 10 usdc to @alice"   -> { username: "alice", amount: 10 }
 *   "pay @bob 5"               -> { username: "bob", amount: 5 }
 *   "tip @bob $5"              -> { username: "bob", amount: 5 }
 *   "/send @chidi"             -> { username: "chidi", amount: null }
 *   "send to @alice"           -> { username: "alice", amount: null }
 */
function parseTransferInstruction(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();

  // Pattern 1: /send or /pay followed by @username [optional amount]
  const slashUserFirst = s.match(
    /^\/(?:send|pay)\s+@?([a-zA-Z0-9_]{3,32})(?:\s+\$?([0-9]+(?:\.[0-9]{1,6})?)(?:\s*(?:usdc|usd|dollars?))?)?$/i
  );
  if (slashUserFirst) {
    return {
      username: slashUserFirst[1].toLowerCase(),
      amount: slashUserFirst[2] ? parseFloat(slashUserFirst[2]) : null,
    };
  }

  // Pattern 2: /send or /pay followed by amount (to) @username
  const slashAmtFirst = s.match(
    /^\/(?:send|pay)\s+\$?([0-9]+(?:\.[0-9]{1,6})?)(?:\s*(?:usdc|usd|dollars?))?\s+(?:to\s+)?@([a-zA-Z0-9_]{3,32})$/i
  );
  if (slashAmtFirst) {
    return {
      username: slashAmtFirst[2].toLowerCase(),
      amount: parseFloat(slashAmtFirst[1]),
    };
  }

  // Pattern 3: (send|pay|transfer|tip|gift) [$]amount [usdc|usd|dollars] (to) @username
  const naturalMatch1 = s.match(
    /^(?:send|pay|transfer|tip|gift)\s+\$?([0-9]+(?:\.[0-9]{1,6})?)(?:\s*(?:usdc|usd|dollars?))?\s+(?:to\s+)?@([a-zA-Z0-9_]{3,32})$/i
  );
  if (naturalMatch1) {
    return {
      username: naturalMatch1[2].toLowerCase(),
      amount: parseFloat(naturalMatch1[1]),
    };
  }

  // Pattern 4: (send|pay|transfer|tip|gift) (to )?@username [$]amount [usdc|usd|dollars]
  const naturalMatch2 = s.match(
    /^(?:send|pay|transfer|tip|gift)\s+(?:to\s+)?@([a-zA-Z0-9_]{3,32})\s+\$?([0-9]+(?:\.[0-9]{1,6})?)(?:\s*(?:usdc|usd|dollars?))?$/i
  );
  if (naturalMatch2) {
    return {
      username: naturalMatch2[1].toLowerCase(),
      amount: parseFloat(naturalMatch2[2]),
    };
  }

  // Pattern 5: (send|pay|transfer|tip|gift) (to )?@username (no amount yet)
  const naturalNoAmt = s.match(
    /^(?:send|pay|transfer|tip|gift)\s+(?:money\s+)?(?:to\s+)?@([a-zA-Z0-9_]{3,32})$/i
  );
  if (naturalNoAmt) {
    return {
      username: naturalNoAmt[1].toLowerCase(),
      amount: null,
    };
  }

  return null;
}

/**
 * Build claim URL and Telegram native share URL for a gift escrow.
 * Note: Telegram's t.me/share/url automatically includes the `url` parameter,
 * so `text` does NOT repeat the URL.
 */
function buildGiftShareLinks({ targetUsername, amountUsdc, claimToken }) {
  const botUsername = process.env.BOT_USERNAME || "payeetbot";
  const claimUrl = `https://t.me/${botUsername}?start=claim_${claimToken}`;
  const shareText = `Hey @${targetUsername}! I just sent you $${Number(amountUsdc).toFixed(2)} on Proxim 🎁 Tap the link to claim it instantly!`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(claimUrl)}&text=${encodeURIComponent(shareText)}`;
  return { claimUrl, shareUrl, shareText };
}

/**
 * Validate and prepare transfer target (registered user vs unregistered viral gift).
 */
function prepareSocialTransfer({ senderUser, targetUsername, amountUsdc = null }) {
  const cleanTarget = normalizeTelegramHandle(targetUsername);
  if (!cleanTarget) {
    throw new Error("Please enter a valid Telegram username (e.g. @chidi).");
  }

  const senderUsername = String(senderUser?.username || "").toLowerCase();
  if (senderUsername && cleanTarget === senderUsername) {
    throw new Error("You cannot send money to yourself.");
  }

  const targetUser = db.findUserByUsername(cleanTarget);
  if (targetUser) {
    if (String(targetUser.telegram_id) === String(senderUser.telegram_id)) {
      throw new Error("You cannot send money to yourself.");
    }
    const targetAddress =
      targetUser.active_context === "business" && targetUser.business_deposit_address
        ? targetUser.business_deposit_address
        : targetUser.deposit_address;

    return {
      isRegistered: true,
      targetUsername: cleanTarget,
      targetUser,
      targetAddress,
      amountUsdc: amountUsdc !== null ? Number(amountUsdc) : null,
    };
  }

  return {
    isRegistered: false,
    targetUsername: cleanTarget,
    targetUser: null,
    targetAddress: null,
    amountUsdc: amountUsdc !== null ? Number(amountUsdc) : null,
  };
}

/**
 * Create a claimable gift escrow for an unregistered Telegram user.
 */
function createGiftEscrow({
  senderId,
  senderAccountType = "personal",
  targetUsername,
  amountUsdc,
  expiresHours = 48,
}) {
  const cleanTarget = normalizeTelegramHandle(targetUsername) || String(targetUsername).replace(/^@+/, "").toLowerCase();
  const token = generateClaimToken();
  const row = db.createSocialEscrow({
    senderId,
    senderAccountType,
    platform: "telegram",
    targetHandle: cleanTarget,
    amountUsdc,
    claimToken: token,
    expiresHours,
  });

  const { claimUrl, shareUrl, shareText } = buildGiftShareLinks({
    targetUsername: cleanTarget,
    amountUsdc,
    claimToken: token,
  });

  return {
    escrow: row,
    claimToken: token,
    claimUrl,
    shareUrl,
    shareText,
  };
}

/**
 * Verify that the claimant's Telegram username matches the gift's intended recipient.
 * Throws a user-friendly error if mismatched or missing.
 */
function verifyEscrowRecipient(escrow, claimantUsername) {
  const targetHandle = normalizeTelegramHandle(escrow?.target_handle);
  if (!targetHandle) return true; // open gift (if ever supported)

  const cleanClaimant = normalizeTelegramHandle(claimantUsername);
  if (!cleanClaimant) {
    throw new Error(
      `This gift is exclusively for @${targetHandle}. Your Telegram account doesn't have a matching username set.`
    );
  }
  if (cleanClaimant !== targetHandle) {
    throw new Error(
      `This gift is exclusively for @${targetHandle} and cannot be claimed by @${cleanClaimant}.`
    );
  }
  return true;
}

/**
 * Release escrowed funds to claimant's address and mark claimed in DB.
 */
async function releaseEscrowToRecipient({ claimToken, claimantTelegramId, claimantUsername = null, recipientAddress }) {
  try { db.expireStaleSocialEscrows(); } catch (_) {}

  const escrow = db.getSocialEscrowByToken(claimToken);
  if (!escrow || escrow.status !== "pending") {
    throw new Error("This gift link is invalid, expired, or has already been claimed.");
  }
  if (String(escrow.sender_id) === String(claimantTelegramId)) {
    throw new Error("You cannot claim your own gift link.");
  }

  // Enforce strict recipient-only claiming by Telegram username
  const resolvedClaimantUsername = claimantUsername || db.getUser(claimantTelegramId)?.username || null;
  verifyEscrowRecipient(escrow, resolvedClaimantUsername);

  const claimRes = db.claimSocialEscrow(claimToken, claimantTelegramId);
  if (!claimRes.success) {
    throw new Error(`Unable to claim gift (${claimRes.reason}).`);
  }

  let txHash = null;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (relayerKey && recipientAddress) {
    try {
      const relayerSigner = walletLib.walletFromPrivateKey(relayerKey);
      const amountMicro = walletLib.parseToMicro(String(escrow.amount_usdc));
      const res = await walletLib.sendSponsoredOrDirectTransaction(relayerSigner, recipientAddress, amountMicro);
      txHash = res?.txHash || null;
    } catch (err) {
      console.warn("[social_transfers:release] on-chain disbursal note:", err.message);
    }
  }

  try {
    db.recordTransaction(
      claimantTelegramId,
      "p2p_receive",
      walletLib.parseToMicro(String(escrow.amount_usdc)),
      "confirmed",
      txHash || `GIFT-${claimToken.slice(0, 10)}`,
      "personal",
      18,
      "arc",
      `Gift from user ${escrow.sender_id}`
    );
  } catch (_) {}

  return {
    success: true,
    txHash,
    escrow: claimRes.escrow,
  };
}

/**
 * Cancel pending escrow and return funds to sender's address.
 */
async function refundEscrowToSender({ claimToken, senderId, senderAddress }) {
  const escrow = db.getSocialEscrowByToken(claimToken);
  if (!escrow) throw new Error("Gift not found.");
  if (Number(escrow.sender_id) !== Number(senderId)) throw new Error("Unauthorized to cancel this gift.");
  if (escrow.status !== "pending") throw new Error(`This gift is already ${escrow.status}.`);

  const cancelRes = db.cancelSocialEscrow(claimToken, senderId);
  if (!cancelRes.success) throw new Error(`Unable to cancel gift (${cancelRes.reason}).`);

  let txHash = null;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (relayerKey && senderAddress) {
    try {
      const relayerSigner = walletLib.walletFromPrivateKey(relayerKey);
      const amountMicro = walletLib.parseToMicro(String(escrow.amount_usdc));
      const res = await walletLib.sendSponsoredOrDirectTransaction(relayerSigner, senderAddress, amountMicro);
      txHash = res?.txHash || null;
    } catch (err) {
      console.warn("[social_transfers:refund] on-chain disbursal note:", err.message);
    }
  }

  try {
    db.recordTransaction(
      senderId,
      "p2p_refund",
      walletLib.parseToMicro(String(escrow.amount_usdc)),
      "confirmed",
      txHash || `REFUND-${claimToken.slice(0, 10)}`,
      escrow.sender_account_type || "personal",
      18,
      "arc",
      `Refund for cancelled gift to @${escrow.target_handle}`
    );
  } catch (_) {}

  return {
    success: true,
    txHash,
    escrow: cancelRes.escrow,
  };
}

module.exports = {
  getEscrowHolderAddress,
  generateClaimToken,
  extractClaimToken,
  normalizeTelegramHandle,
  buildGiftShareLinks,
  parseTransferInstruction,
  prepareSocialTransfer,
  createGiftEscrow,
  verifyEscrowRecipient,
  releaseEscrowToRecipient,
  refundEscrowToSender,
};
