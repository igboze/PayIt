// src/social_transfers.js
// Social Transfers & Viral P2P Gifting on Telegram
// Supports:
//   1. Instant direct transfers between registered Proxim users (@username)
//   2. Viral claimable escrow gift links for unregistered Telegram users
//   3. Auto-refunds on cancellation or 48-hour expiration

const crypto = require("crypto");
const db = require("./db");
const walletLib = require("./wallet");

/**
 * Platform escrow / treasury address used to hold funds while an escrow gift is pending.
 * Falls back to PAYIT_DEV_FEE_ADDRESS, APP_FEE_RECIPIENT_ADDRESS, or system default.
 */
function getEscrowHolderAddress() {
  return (
    process.env.SOCIAL_ESCROW_ADDRESS ||
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
 * Parse natural language or slash command for P2P sending.
 * Examples:
 *   "/send @chidi 25" -> { username: "chidi", amount: 25 }
 *   "send $10 to @alice" -> { username: "alice", amount: 10 }
 *   "pay @bob 5" -> { username: "bob", amount: 5 }
 *   "/send @chidi" -> { username: "chidi", amount: null }
 */
function parseTransferInstruction(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();

  // Pattern 1: /send @username [amount]
  const slashMatch = s.match(/^\/send\s+@?([a-zA-Z0-9_]{3,32})(?:\s+\$?([0-9]+(?:\.[0-9]{1,6})?))?$/i);
  if (slashMatch) {
    return {
      username: slashMatch[1].toLowerCase(),
      amount: slashMatch[2] ? parseFloat(slashMatch[2]) : null,
    };
  }

  // Pattern 2: (send|pay|transfer) [$]amount to @username
  const naturalMatch1 = s.match(/^(?:send|pay|transfer)\s+\$?([0-9]+(?:\.[0-9]{1,6})?)\s+(?:to\s+)?@([a-zA-Z0-9_]{3,32})$/i);
  if (naturalMatch1) {
    return {
      username: naturalMatch1[2].toLowerCase(),
      amount: parseFloat(naturalMatch1[1]),
    };
  }

  // Pattern 3: (send|pay|transfer) (to )?@username [$]amount
  const naturalMatch2 = s.match(/^(?:send|pay|transfer)\s+(?:to\s+)?@([a-zA-Z0-9_]{3,32})\s+\$?([0-9]+(?:\.[0-9]{1,6})?)$/i);
  if (naturalMatch2) {
    return {
      username: naturalMatch2[1].toLowerCase(),
      amount: parseFloat(naturalMatch2[2]),
    };
  }

  return null;
}

/**
 * Validate and prepare transfer target (registered user vs unregistered viral gift).
 */
function prepareSocialTransfer({ senderUser, targetUsername, amountUsdc = null }) {
  if (!targetUsername) throw new Error("A valid Telegram username is required.");
  const cleanTarget = String(targetUsername).replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(cleanTarget)) {
    throw new Error("Invalid Telegram username format. Use 3-32 alphanumeric characters.");
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
    const targetAddress = targetUser.active_context === "business" && targetUser.business_deposit_address
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
  const token = generateClaimToken();
  const row = db.createSocialEscrow({
    senderId,
    senderAccountType,
    platform: "telegram",
    targetHandle: targetUsername,
    amountUsdc,
    claimToken: token,
    expiresHours,
  });

  const botUsername = process.env.BOT_USERNAME || "payeetbot";
  const claimUrl = `https://t.me/${botUsername}?start=claim_${token}`;
  const shareText = `Hey @${targetUsername}, I just sent you $${Number(amountUsdc).toFixed(2)} USD on Proxim! Tap here to claim it: ${claimUrl}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(claimUrl)}&text=${encodeURIComponent(shareText)}`;

  return {
    escrow: row,
    claimToken: token,
    claimUrl,
    shareUrl,
    shareText,
  };
}

/**
 * Release escrowed funds to claimant's address and mark claimed in DB.
 */
async function releaseEscrowToRecipient({ claimToken, claimantTelegramId, recipientAddress }) {
  const escrow = db.getSocialEscrowByToken(claimToken);
  if (!escrow || escrow.status !== "pending") {
    throw new Error("This gift link is invalid or has already been claimed.");
  }
  if (String(escrow.sender_id) === String(claimantTelegramId)) {
    throw new Error("You cannot claim your own gift link.");
  }

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
      `Social gift from user ${escrow.sender_id}`
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
  if (escrow.status !== "pending") throw new Error(`Gift is already ${escrow.status}.`);

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
      `Refund for cancelled social gift to @${escrow.target_handle}`
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
  parseTransferInstruction,
  prepareSocialTransfer,
  createGiftEscrow,
  releaseEscrowToRecipient,
  refundEscrowToSender,
};
