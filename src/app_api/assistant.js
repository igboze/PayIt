// src/app_api/assistant.js
// Hardened, system-aware Proxim AI Assistant for the mobile app.
//
// Security boundaries (defense-in-depth):
//   1. Input firewall: blocks prompt-injection, database/schema/env/secret probing, private-key
//      extraction, and any attempt to inspect or debit another user's account BEFORE calling any LLM.
//   2. Strictly scoped diagnostic context: reads ONLY the authenticated user's own non-secret
//      metadata (balances, recent tx statuses, KYC/KYB status, limits) — NEVER encrypted keys,
//      PIN hashes, BVN/NIN/SSN, passkeys, or another user's rows.
//   3. Allowlisted action proposals only: the AI can NEVER move funds directly. It may only return
//      a sanitized `suggestedAction` from a strict allowlist, force-bound to the authenticated user's
//      active `accountType`, which still requires WebAuthn Passkey + 4-digit PIN + fraud_guard.
//   4. Output DLP scrubber: strips any accidental 64-hex keys, API tokens, SQL/schema terms, or
//      internal partner names before any response leaves the server.

const ALLOWED_AI_ACTION_TYPES = new Set([
  "transfer.user",
  "transfer.wallet",
  "payout.ngn",
  "savings.deposit",
  "savings.withdraw",
  "swap.execute",
  "schedule.create",
]);

const FORBIDDEN_SECRET_PATTERNS = [
  /\b(private\s*key|secret\s*key|seed\s*phrase|recovery\s*phrase|mnemonic|encrypted_key|system_encrypted_key|biz_encrypted_key|pin\s*hash|password\s*hash)\b/i,
  /\b(sqlite_master|pragma\s+table_info|show\s+tables|describe\s+table|database\s+schema|db\s+schema|dump\s+(the\s+)?(db|database|table|users)|sql\s+query|select\s+\*?\s+from|drop\s+table|union\s+select)\b/i,
  /\b(app_passkeys|paj_offramp_orders|paj_onramp_orders|nuvion_entities|nuvion_kyc_drafts|pin_security|operation_idempotency|app_devices)\b/i,
  /\b(env\s*var|environment\s+variable|process\.env|api\s*key|openai_api_key|groq_api_key|gemini_api_key|nuvion_api_key|smtp_pass|deployer_private_key|invoice_forwarding_secret|paj_api_key|jwt_secret)\b/i,
  /\b(system\s+prompt|ignore\s+(all\s+)?(previous|prior|above)\s+instructions|reveal\s+your\s+instructions|print\s+your\s+prompt|jailbreak|developer\s+mode)\b/i,
];

const CROSS_ACCOUNT_PATTERNS = [
  /\b(from|out\s+of|debit|charge|drain|move\s+funds\s+from|transfer\s+from|withdraw\s+from|send\s+from)\s+(@[a-z0-9_]{3,32}|another\s+user|someone\s+else|other\s+user|user\s+#?\d+)\b/i,
  /\b(check|show|get|view|what\s+is|tell\s+me)\s+(@[a-z0-9_]{3,32}|another\s+user|someone\s+else|user\s+#?\d+)'?s?\s+(balance|wallet|transactions|history|kyc|email|phone|account|private\s+key|pin)\b/i,
  /\b(list\s+all\s+users|all\s+users\s+in\s+(the\s+)?(db|database|system)|other\s+users'?s?\s+(balances|accounts|wallets|data))\b/i,
];

const PRIVATE_KEY_HELP_INTENT = /\b(how\s+(do|can)\s+i|where\s+(do|can)\s+i|want\s+to)\s+(back\s*up|backup|export|view|see)\s+(my\s+)?(recovery\s+key|private\s+key|wallet\s+key)\b/i;

function checkSecurityBoundary(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  // Helpful self-service navigation when user asks HOW to back up their own recovery key
  if (PRIVATE_KEY_HELP_INTENT.test(text) && !/\b(give\s+me|print|dump|show\s+me\s+right\s+now|paste)\b/i.test(text)) {
    return {
      blocked: true,
      code: "self_service_key_backup",
      reply:
        "For your security, the AI assistant can never access or display private keys. To back up your own recovery key safely, open Profile → Security → Backup Recovery Key — you'll be asked to confirm with both your Passkey and 4-digit PIN.",
    };
  }

  for (const rx of CROSS_ACCOUNT_PATTERNS) {
    if (rx.test(text)) {
      return {
        blocked: true,
        code: "cross_account_denied",
        reply:
          "I can only view information and prepare actions for your own signed-in Proxim account. I cannot access other users' balances, details, or initiate transfers from any account other than yours.",
      };
    }
  }

  for (const rx of FORBIDDEN_SECRET_PATTERNS) {
    if (rx.test(text)) {
      return {
        blocked: true,
        code: "sensitive_info_denied",
        reply:
          "For security and privacy reasons, I cannot disclose internal database structures, server configuration, API credentials, system instructions, or wallet private keys. If you need help using Proxim or troubleshooting a transaction on your own account, I'm happy to help!",
      };
    }
  }

  return null;
}

/**
 * Deterministic DLP output scrubber — last line of defense before any text reaches the user.
 */
function scrubAssistantOutput(text) {
  let out = String(text || "").trim();
  if (!out) return "I'm here to help with your Proxim account. What would you like to check or do?";

  // Redact any accidental 64-hex private key
  out = out.replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED_KEY]");
  // Redact common API key prefixes
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|re_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_SECRET]");
  // Redact internal SQLite table/column identifiers if ever hallucinated
  out = out.replace(
    /\b(sqlite_master|app_passkeys|paj_offramp_orders|paj_onramp_orders|nuvion_entities|nuvion_kyc_drafts|system_encrypted_key|biz_encrypted_key|encrypted_key|pin_security)\b/gi,
    "[internal]"
  );
  // Never expose internal banking vendor name to end users
  out = out.replace(/\bnuvion\b/gi, "our Global Banking Partner");
  return out;
}

/**
 * Strictly sanitize any AI-proposed action so it can ONLY operate on the authenticated user's
 * active account, only use allowlisted action types, and never bypass Passkey + PIN approval.
 */
function sanitizeSuggestedAction(suggestedAction, { auth, accountType }) {
  if (!suggestedAction || typeof suggestedAction !== "object") return null;
  const type = String(suggestedAction.type || "").trim();
  if (!ALLOWED_AI_ACTION_TYPES.has(type)) return null;

  const raw = suggestedAction.payload && typeof suggestedAction.payload === "object" ? suggestedAction.payload : {};
  // Strip any injected identity / source-account overrides
  const clean = { ...raw };
  delete clean.telegramId;
  delete clean.userId;
  delete clean.fromUser;
  delete clean.fromAccount;
  delete clean.fromAddress;
  delete clean.sourceUserId;
  delete clean.pin;
  delete clean.privateKey;

  // Hard-lock accountType to the authenticated user's verified active workspace
  clean.accountType = accountType === "business" && auth.user?.business_deposit_address ? "business" : "personal";

  // Bounds & self-transfer safety checks
  if (clean.amountUsdc !== undefined) {
    const n = Number(clean.amountUsdc);
    if (!Number.isFinite(n) || n < 0.01 || n > 100_000) return null;
    clean.amountUsdc = Number(n.toFixed(6));
  }
  if (clean.amountNgn !== undefined) {
    const n = Number(clean.amountNgn);
    if (!Number.isFinite(n) || n < 100 || n > 50_000_000) return null;
    clean.amountNgn = Math.round(n);
  }
  if (clean.amountIn !== undefined) {
    const n = Number(clean.amountIn);
    if (!Number.isFinite(n) || n < 1 || n > 100_000) return null;
    clean.amountIn = Number(n.toFixed(6));
  }

  if (type === "transfer.wallet") {
    const to = String(clean.toAddress || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(to)) return null;
    const ownPersonal = String(auth.user?.deposit_address || "").toLowerCase();
    const ownBiz = String(auth.user?.business_deposit_address || "").toLowerCase();
    if (to === ownPersonal || (ownBiz && to === ownBiz)) return null;
    clean.toAddress = to;
  }

  if (type === "transfer.user") {
    const rec = String(clean.recipient || "").trim();
    if (!rec) return null;
    if (auth.user?.username && rec.replace(/^@/, "").toLowerCase() === auth.user.username.toLowerCase()) {
      return null;
    }
  }

  return { type, payload: clean };
}

/**
 * Build a strictly scoped, secret-free diagnostic snapshot for the authenticated user ONLY.
 */
async function buildUserDiagnosticContext(auth, accountType, deps) {
  const db = deps.db;
  const user = auth.user || db.getUser(auth.telegramId) || {};
  const snapshot = {
    activeWorkspace: accountType,
    hasBusinessAccount: Boolean(user.business_deposit_address),
    usernameSet: Boolean(user.username),
    username: user.username ? `@${user.username}` : null,
    autoEarnEnabled: Boolean(user.auto_earn_enabled),
    accountFrozen: Boolean(user.is_blocked),
    deviceRestrictedUntil: auth.device?.restricted_until || null,
    balance: null,
    savings: null,
    kyc: { personal: "not_started", personalReason: null, business: "not_started", businessReason: null },
    limits: null,
    recentTransactions: [],
    recentIssues: [],
  };

  // Live balance (non-fatal)
  try {
    const u = await deps.chains.getUnifiedBalance(user, accountType, { strictBusiness: accountType === "business" });
    snapshot.balance = {
      totalUsdc: Number((u.total || 0).toFixed(2)),
      arcUsdc: Number((u.arc?.usdc || 0).toFixed(2)),
      baseUsdc: Number((u.base?.usdc || 0).toFixed(2)),
      solanaUsdc: Number((u.solana?.usdc || 0).toFixed(2)),
      pendingBridgeUsdc: Number((u.pendingNear || 0).toFixed(2)),
    };
  } catch (_) { }

  // Open savings position
  try {
    const open = db.getOpenYieldPosition?.(auth.telegramId, accountType);
    if (open) {
      const accrued = typeof deps.savings?.calcAccruedYield === "function" ? Number(deps.savings.calcAccruedYield(open) || 0) : 0;
      snapshot.savings = {
        principalUsdc: Number(open.amount_usdc || 0),
        accruedYieldUsdc: Number(accrued.toFixed(4)),
        apy: Number(open.apy || 0),
      };
    }
  } catch (_) { }

  // KYC / KYB status (no sensitive ID numbers/BVN/NIN/SSN ever included)
  try {
    const pEnt = db.getNuvionEntityByUser?.(auth.telegramId, "personal");
    if (pEnt) {
      snapshot.kyc.personal = String(pEnt.status || "pending").toLowerCase();
      snapshot.kyc.personalReason = pEnt.rejection_reason ? String(pEnt.rejection_reason).replace(/nuvion/gi, "Global Banking Partner") : null;
    }
    const bEnt = db.getNuvionEntityByUser?.(auth.telegramId, "business");
    if (bEnt) {
      snapshot.kyc.business = String(bEnt.status || "pending").toLowerCase();
      snapshot.kyc.businessReason = bEnt.rejection_reason ? String(bEnt.rejection_reason).replace(/nuvion/gi, "Global Banking Partner") : null;
    }
  } catch (_) { }

  // Spending limits
  try {
    if (typeof deps.fraudGuard?.getUserLimits === "function") {
      const lim = deps.fraudGuard.getUserLimits(auth.telegramId, accountType);
      if (lim) {
        snapshot.limits = {
          hourlyLimitUsd: lim.hourlyLimitUsd ?? lim.hourlyUsd ?? null,
          dailyLimitUsd: lim.dailyLimitUsd ?? lim.dailyUsd ?? null,
          usedHourlyUsd: lim.usedHourlyUsd ?? null,
          usedDailyUsd: lim.usedDailyUsd ?? null,
        };
      }
    }
  } catch (_) { }

  // Recent transactions & recent failed/pending records for error diagnosis
  try {
    const txs = db.getTransactions?.(auth.telegramId, 6, accountType) || [];
    snapshot.recentTransactions = txs.map((t) => ({
      type: t.type,
      status: t.status,
      chain: t.chain || "arc",
      narration: t.narration ? String(t.narration).slice(0, 60) : null,
      createdAt: t.created_at || null,
    }));
    for (const t of txs) {
      if (t.status === "failed" || t.status === "pending") {
        snapshot.recentIssues.push(`${t.type} (${t.status}) on ${t.chain || "arc"} at ${t.created_at || "recently"}`);
      }
    }
  } catch (_) { }

  // Recent bill errors (if any)
  try {
    const bills = db.getUserBillPayments?.(auth.telegramId, 5) || [];
    for (const b of bills) {
      if (b.status === "failed" && b.error_message) {
        snapshot.recentIssues.push(`Bill (${b.category}) failed: ${String(b.error_message).replace(/nuvion/gi, "Global Banking Partner").slice(0, 120)}`);
      }
    }
  } catch (_) { }

  return snapshot;
}

const PROXIM_SYSTEM_KNOWLEDGE = `You are the official Proxim Mobile App AI Assistant.
You are friendly, clear, concise (under 140 words unless diagnosing a multi-step issue), and understand English and Nigerian Pidgin.

=== COMPLETE PROXIM SYSTEM KNOWLEDGE ===
1. ACCOUNTS & WORKSPACES:
   - Users have a Personal Account and can optionally enable a separate Business Account (strictly isolated wallets, balances, invoices, and verification).
   - Every wallet is self-custodial (Arc USDC primary settlement, plus Base & Solana rails).
   - Users can claim/edit their @username in Profile -> General so friends/clients can pay them for free.
2. FEES & LIMITS:
   - Proxim-to-Proxim (@username / phone) transfers: FREE.
   - Nigerian Naira (NGN) bank payouts: 1% platform fee charged ON TOP of the send amount. If a user tries to send 100% of their balance, they must leave 1% for the fee (e.g., max sendable is balance / 1.01).
   - Naira (NGN) bank deposits (Add Money): 0.2% platform fee.
   - USDC <-> EURC FX Swaps: 1% protocol fee.
   - Dollar Savings (Auto-Earn & Vaults): 10% fee on earned profit ONLY (principal is 100% yours, withdraw anytime).
   - Cross-chain crypto withdrawals: $0.30 bridge fee.
   - New devices have a 24-hour $100 transfer security limit (visible in Profile -> Security -> Signed-in Devices).
3. VERIFICATION (KYC vs KYB):
   - Before KYC/KYB (unverified): NGN deposits/payouts, P2P transfers, bills, savings, swaps, crypto deposits/withdrawals work immediately. Users who have not verified see "Verify KYC" (or "Verify KYB" for Business).
   - VERIFIED Personal KYC (Profile -> Verify ID): unlocks named Personal Global Bank Accounts (USD, GBP, EUR, CAD, AED, GHS, KES, TZS), Virtual & Disposable USD Cards, and 27-currency Global Transfers. Requires Government ID (front + optional back) + Proof of Address (<3 months) + BVN & NIN (for NG) or SSN (for US).
   - VERIFIED Business KYB (strictly separate from Personal KYC): unlocks Business Global Accounts, Team USD Cards, and 27-currency Payroll. Requires all 5 documents: Certificate of Incorporation (PDF or clear photo — auto-converted to PDF), Memorandum & Articles of Association (PDF/DOC/DOCX or photo), Business Proof of Address, Officer Government ID, and Officer Proof of Address.
   - Document Upload Tips: Users can tap Upload (native file/photo picker) OR tap the "Web" button next to any document row for Proxim's secure browser uploader, which auto-compresses large photos and converts COI photos to PDF.
4. SECURITY & RECOVERY:
   - Money movements ALWAYS require WebAuthn Passkey + 4-digit Transaction PIN.
   - Forgot PIN: Profile -> Security -> "Forgot PIN? Reset with Passkey" (no old PIN needed).
   - Backup Recovery Key: Profile -> Security -> "Backup Recovery Key" (Passkey + PIN).
   - Emergency Freeze: Profile -> Security -> "Freeze Account".
   - Delete Account: Profile -> General -> "Delete Account".
   - Support: igboze@proximfi.xyz or Telegram @payeetbot.

=== STRICT SECURITY BOUNDARIES (NON-NEGOTIABLE) ===
- You ONLY help the currently authenticated user with THEIR OWN active account shown in the JSON context below.
- NEVER reveal or speculate about database schemas, SQLite tables, SQL queries, environment variables, API keys, server paths, source code, or internal vendor names (never say "Nuvion" — say "Global Banking Partner").
- NEVER reveal, ask for, or generate private keys, seed phrases, or PINs.
- NEVER initiate, approve, or claim to execute transfers from another user's account. Remind users that any payment you propose only runs after THEY tap "Review & Approve with Passkey" and enter their PIN.
- If the user reports an error, check their live diagnostic context below (balance, 1% fee buffer, KYC/KYB status & rejection reason, new-device $100 restriction, frozen status, or recent failed transactions/bills) and explain clearly what happened and the exact next step.`;

/**
 * Smart deterministic Proxim troubleshooting & help responder when no external LLM key is
 * available (or if the remote LLM call times out).
 */
function buildLocalSystemAnswer(message, snapshot) {
  const low = String(message || "").toLowerCase();
  const bal = snapshot.balance?.totalUsdc;
  const balStr = bal != null ? `$${bal.toFixed(2)}` : "your current balance";

  // Account frozen check
  if (snapshot.accountFrozen) {
    return "Your Proxim account is currently frozen for security. Please contact support at igboze@proximfi.xyz or @payeetbot on Telegram to verify your identity and unfreeze it.";
  }

  // KYC / KYB questions or upload issues
  if (/\b(kyc|kyb|verif|tier\s*1|upload|document|pdf|photo|id\s*card|passport|bvn|nin|coi)\b/i.test(low)) {
    const kycLine = `Your current status: Personal KYC is ${snapshot.kyc.personal.toUpperCase()}${snapshot.kyc.personalReason ? ` (Note: ${snapshot.kyc.personalReason})` : ""}${snapshot.hasBusinessAccount ? `; Business KYB is ${snapshot.kyc.business.toUpperCase()}${snapshot.kyc.businessReason ? ` (Note: ${snapshot.kyc.businessReason})` : ""}` : ""}.`;
    if (/\b(upload|file|pdf|photo|attach|image|doc)\b/i.test(low)) {
      return `${kycLine}\n\nTo upload verification documents cleanly: open Profile → Verify ID and tap "Upload" next to each document (max 6 MB; JPG, PNG, PDF, DOC/DOCX — COI photos are auto-converted to PDF). If your phone's file picker has trouble, tap the "Web" button beside that document to use our secure browser uploader.`;
    }
    return `${kycLine}\n\nOpen Profile → Verify ID to submit or sync status. Personal KYC unlocks named Global Bank Accounts & Virtual USD Cards; Business KYB is separate and requires all 5 company & officer documents.`;
  }

  // Error / failed transaction diagnosis
  if (/\b(fail|failed|error|why|stuck|pending|not\s+work|can'?t\s+send|cannot\s+send|declin|reject|problem|issue|insufficient)\b/i.test(low)) {
    const reasons = [];
    if (snapshot.deviceRestrictedUntil && Date.parse(snapshot.deviceRestrictedUntil) > Date.now()) {
      reasons.push(`• New-device security limit: transfers on this device are capped at $100 until ${snapshot.deviceRestrictedUntil}.`);
    }
    if (snapshot.kyc.personal !== "approved" && /\b(card|global|abroad|usd\s+account|gbp|eur)\b/i.test(low)) {
      reasons.push(`• Global Accounts, Virtual USD Cards, and international transfers require KYC Verification (currently ${snapshot.kyc.personal === "approved" ? "VERIFIED" : snapshot.kyc.personal === "pending" || snapshot.kyc.personal === "incomplete" ? "UNDER REVIEW" : "Verify KYC needed"}).`);
    }
    if (bal != null && bal < 1.05) {
      reasons.push(`• Low balance: your ${snapshot.activeWorkspace} balance is ${balStr}. Remember Nigerian bank payouts require a 1% fee on top of the send amount (e.g., max sendable ≈ $${(bal / 1.01).toFixed(2)}).`);
    } else if (/\b(bank|naira|ngn|payout|withdraw|cash\s*out)\b/i.test(low) && bal != null) {
      reasons.push(`• NGN bank payouts charge a 1% fee on top of your send amount. With ${balStr}, your max sendable amount is ≈ $${(bal / 1.01).toFixed(2)}.`);
    }
    if (snapshot.recentIssues.length) {
      reasons.push(`• Recent account issue spotted: ${snapshot.recentIssues[0]}.`);
    }
    if (reasons.length) {
      return `Here is what I found on your ${snapshot.activeWorkspace} account:\n${reasons.join("\n")}\n\nIf the issue continues, email igboze@proximfi.xyz or message @payeetbot with the transaction time.`;
    }
    return `I checked your ${snapshot.activeWorkspace} account (balance ${balStr}, Personal KYC: ${snapshot.kyc.personal.toUpperCase()}) and don't see a block or pending failure right now. Tell me which action gave you an error (e.g. NGN payout, deposit, card, KYC upload, or PIN) and the exact message you saw so I can pinpoint it.`;
  }

  // Fees & pricing
  if (/\b(fee|fees|charge|cost|rate|percent|%)\b/i.test(low)) {
    return "Proxim fee summary:\n• Send to @username / phone: Free\n• Nigerian bank payout (NGN): 1% (charged on top of send amount)\n• Naira bank deposit (Add Money): 0.2%\n• USDC ↔ EURC FX swap: 1%\n• Dollar Savings yield: 10% of earned profit only\n• Cross-chain crypto withdrawal: $0.30 bridge fee";
  }

  // PIN / Passkey / Security / Recovery
  if (/\b(pin|passkey|forgot|reset|freeze|lock|delete\s+account|username)\b/i.test(low)) {
    return "Account & security shortcuts:\n• Forgot PIN? Go to Profile → Security → \"Forgot PIN? Reset with Passkey\".\n• Claim/edit @username: Profile → General → Save Profile.\n• Backup Recovery Key: Profile → Security → Backup Recovery Key (Passkey + PIN).\n• Freeze or Delete Account: Profile → Security / General.";
  }

  // Cards / Global Accounts
  if (/\b(card|virtual\s+card|usd\s+account|gbp|eur|global\s+account|receive\s+usd)\b/i.test(low)) {
    const kycState = snapshot.kyc.personal === "approved" ? "VERIFIED" : snapshot.kyc.personal === "pending" || snapshot.kyc.personal === "incomplete" ? "UNDER REVIEW" : "not yet verified (Verify KYC needed)";
    return `Named Global Bank Accounts (USD, GBP, EUR, CAD, AED, GHS, KES, TZS) and Virtual USD Cards unlock once your KYC verification is approved (your Personal KYC is currently ${kycState}). Open Accounts or Cards after completing Profile → Verify ID.`;
  }

  // Default helpful greeting / overview
  return `Hi! I'm your Proxim Assistant (${snapshot.activeWorkspace} workspace · balance ${balStr}). You can ask me to:\n• Check your balance, savings, limits, or recent transactions\n• Diagnose any transfer, deposit, card, or KYC/KYB error\n• Prepare a payment, bank payout, swap, or savings deposit for your Passkey + PIN approval`;
}

/**
 * Main entry point called by features.assistantChat(auth, body).
 */
async function handleAssistantChat(auth, body, deps) {
  const {
    reqStr,
    resolveAccountType,
    getStrictAccountArcAddress,
    formatContact,
    formatBizInvoice,
  } = deps.helpers;

  const message = reqStr(body, "message", { max: 1000 });
  const accountType = resolveAccountType(auth, body?.accountType);

  // 1. Input Security Firewall (blocks secret/DB/private-key/cross-account requests immediately)
  const blocked = checkSecurityBoundary(message);
  if (blocked) {
    return {
      status: 200,
      data: {
        intent: blocked.code,
        confidence: "high",
        summary: null,
        reply: blocked.reply,
        missingQuestion: null,
        confirmationText: null,
        suggestedAction: null,
        params: {},
        data: null,
      },
    };
  }

  // 2. Run intent router for structured account lookups & payment proposals
  const router = deps.intentRouter;
  let classified = { intent: "unknown", confidence: "low", params: {}, raw_summary: null };
  try {
    classified = await router.classifyIntent(message, auth.telegramId, {
      address: getStrictAccountArcAddress(auth.user, accountType),
      active_context: accountType,
    });
  } catch (_) { }

  const intent = classified?.intent || "unknown";
  const params = classified?.params || {};
  const missingQuestion = typeof router.getMissingQuestion === "function" ? router.getMissingQuestion(classified) : null;
  const confirmationText = typeof router.buildConfirmationText === "function"
    ? router.buildConfirmationText(classified, params.recipients || [])
    : null;

  let reply = null;
  let data = null;
  let suggestedAction = null;

  // 3. Direct read-only intents (strictly scoped to auth.telegramId + accountType)
  if (intent === "balance") {
    try {
      const u = await deps.chains.getUnifiedBalance(auth.user, accountType, { strictBusiness: accountType === "business" });
      data = { accountType, totalUsdc: u.total, arc: u.arc, base: u.base || { usdc: 0 }, gateway: u.gateway || { usdc: 0 }, solana: u.solana, pendingBridgeUsdc: u.pendingNear };
      reply = `Your ${accountType} balance is $${Number(u.total || 0).toFixed(2)}.`;
    } catch (_) {
      reply = "Could not load your live balance right now. Please try again in a moment.";
    }
  } else if (intent === "history") {
    const rows = deps.db.getTransactions(auth.telegramId, 5, accountType);
    data = { accountType, count: rows.length, transactions: rows.map((t) => ({ id: t.id, type: t.type, status: t.status, createdAt: t.created_at })) };
    reply = rows.length
      ? `Found ${rows.length} recent ${accountType} transaction${rows.length === 1 ? "" : "s"}:\n` +
        rows.map((t) => `• ${t.type} (${t.status}) — ${t.created_at || ""}`).join("\n")
      : `You have no ${accountType} transactions yet.`;
  } else if (intent === "list_payees") {
    const pb = deps.payeeBook;
    if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
    const rows = pb.getAllPayees(auth.telegramId);
    data = { contacts: rows.map(formatContact) };
    reply = rows.length ? `You have ${rows.length} saved contact${rows.length === 1 ? "" : "s"}: ${rows.slice(0, 8).map((c) => c.name).join(", ")}.` : "You have no saved contacts yet.";
  } else if (intent === "invoice_list") {
    const rows = deps.bizDb.getBizInvoices(auth.telegramId, 10);
    data = { invoices: rows.map(formatBizInvoice) };
    reply = rows.length ? `You have ${rows.length} business invoice${rows.length === 1 ? "" : "s"}.` : "You have no invoices yet.";
  } else if (intent === "savings_view") {
    const open = deps.db.getOpenYieldPosition(auth.telegramId, accountType);
    const accrued = open && typeof deps.savings.calcAccruedYield === "function" ? Number(deps.savings.calcAccruedYield(open) || 0) : 0;
    data = open ? { principalUsdc: Number(open.amount_usdc || 0), accruedYieldUsdc: accrued, apy: Number(open.apy || 0) } : null;
    reply = open
      ? `You have $${Number(open.amount_usdc || 0).toFixed(2)} in ${accountType} savings (+$${accrued.toFixed(4)} earned).`
      : `You don't have an active ${accountType} savings deposit yet. Say "Save $20" to start earning yield.`;
  } else if (intent === "referral") {
    const points = deps.db.getPointsBalance(auth.telegramId);
    const code = auth.user.referral_code || `ref${auth.telegramId}`;
    data = { pointsBalance: points, referralCode: code };
    reply = `You have ${points} reward points. Share code ${code} to earn more.`;
  } else if (intent === "cash_flow") {
    const inc = Number(deps.bizDb.getMonthIncome(auth.telegramId) || 0);
    const exp = Number(deps.bizDb.getMonthExpenses(auth.telegramId) || 0);
    data = { monthIncomeUsd: inc, monthExpensesUsd: exp, netCashFlowUsd: Number((inc - exp).toFixed(2)) };
    reply = `This month: $${inc.toFixed(2)} in, $${exp.toFixed(2)} out (net $${(inc - exp).toFixed(2)}).`;
  }

  // 4. Actionable money intents ONLY produce a strictly-sanitized suggestedAction for Passkey + PIN approval
  let r0 = params?.recipients?.[0] || null;
  if (r0 && r0.name_or_address && !r0.wallet_address && !r0.account_number) {
    try {
      const pb = deps.payeeBook;
      if (typeof pb.initPayeeTable === "function") pb.initPayeeTable();
      const matched = pb.resolvePayee(auth.telegramId, r0.name_or_address);
      if (matched && !Array.isArray(matched)) {
        r0 = {
          ...r0,
          name_or_address: matched.name || r0.name_or_address,
          wallet_address: matched.wallet_address || null,
          bank_name: r0.bank_name || matched.bank_name || null,
          account_number: r0.account_number || matched.account_number || null,
          account_name: r0.account_name || matched.account_name || null,
        };
      }
    } catch (_) { }
  }

  if (intent === "transfer" && r0 && Number(r0.amount) > 0) {
    const addr = r0.wallet_address || (/^0x[0-9a-fA-F]{40}$/.test(String(r0.name_or_address || "")) ? r0.name_or_address : null);
    if (addr) {
      suggestedAction = sanitizeSuggestedAction(
        { type: "transfer.wallet", payload: { accountType, toAddress: addr.toLowerCase(), amountUsdc: Number(r0.amount), narration: r0.description || "" } },
        { auth, accountType }
      );
      if (suggestedAction) {
        reply = `Ready to send $${Number(r0.amount).toFixed(2)} from your ${accountType} account to ${r0.name_or_address || addr}. Tap below to review and approve with your Passkey and PIN.`;
      }
    } else if (r0.name_or_address) {
      const userMatch = deps.actions.findRecipientUser(r0.name_or_address);
      if (userMatch && userMatch.deposit_address) {
        suggestedAction = sanitizeSuggestedAction(
          { type: "transfer.user", payload: { accountType, recipient: r0.name_or_address, amountUsdc: Number(r0.amount), narration: r0.description || "" } },
          { auth, accountType }
        );
        if (suggestedAction) {
          reply = `Ready to send $${Number(r0.amount).toFixed(2)} from your ${accountType} account to ${userMatch.username ? `@${userMatch.username}` : "Proxim user"} (Free). Tap below to approve with your Passkey and PIN.`;
        }
      }
    }
  } else if (intent === "offramp" && r0 && Number(r0.amount) > 0 && r0.account_number && r0.bank_name) {
    let bankCode = null;
    try {
      const b = await deps.bankResolver.resolveBankCode(r0.bank_name);
      bankCode = b?.bankCode || null;
    } catch (_) { }
    if (bankCode) {
      const isNgn = String(r0.currency || "").toUpperCase() === "NGN";
      suggestedAction = sanitizeSuggestedAction(
        {
          type: "payout.ngn",
          payload: {
            accountType,
            ...(isNgn ? { amountNgn: Math.round(Number(r0.amount)) } : { amountUsdc: Number(r0.amount) }),
            bankCode,
            accountNumber: r0.account_number,
            accountName: r0.account_name || "",
            narration: r0.narration || r0.description || "",
          },
        },
        { auth, accountType }
      );
      if (suggestedAction) {
        const amtLabel = isNgn ? `₦${Math.round(Number(r0.amount)).toLocaleString("en-NG")}` : `$${Number(r0.amount).toFixed(2)}`;
        reply = `Ready to send ${amtLabel} (+1% fee) from your ${accountType} account to ${r0.bank_name} ${r0.account_number}. Tap below to review and approve with your Passkey and PIN.`;
      }
    }
  } else if (intent === "savings_deposit" && r0 && Number(r0.amount) > 0) {
    suggestedAction = sanitizeSuggestedAction(
      { type: "savings.deposit", payload: { accountType, amountUsdc: Number(r0.amount) } },
      { auth, accountType }
    );
    if (suggestedAction) {
      reply = `Ready to deposit $${Number(r0.amount).toFixed(2)} from your ${accountType} account into savings. Tap below to approve with your Passkey and PIN.`;
    }
  } else if (intent === "savings_withdraw") {
    suggestedAction = sanitizeSuggestedAction(
      { type: "savings.withdraw", payload: { accountType } },
      { auth, accountType }
    );
    if (suggestedAction) {
      reply = `Ready to withdraw your ${accountType} savings back to your balance. Tap below to approve with your Passkey and PIN.`;
    }
  } else if (intent === "scheduled" && r0 && Number(r0.amount) > 0 && params?.schedule?.frequency) {
    const addr = r0.wallet_address || (/^0x[0-9a-fA-F]{40}$/.test(String(r0.name_or_address || "")) ? r0.name_or_address : null);
    if (addr && /^(daily|weekly|monthly)$/.test(String(params.schedule.frequency).toLowerCase())) {
      suggestedAction = sanitizeSuggestedAction(
        {
          type: "schedule.create",
          payload: {
            accountType,
            kind: "transfer.wallet",
            toAddress: addr.toLowerCase(),
            amountUsdc: Number(r0.amount),
            frequency: String(params.schedule.frequency).toLowerCase(),
            day: params.schedule.day || undefined,
            time: params.schedule.time || "09:00",
          },
        },
        { auth, accountType }
      );
      if (suggestedAction) {
        reply = `Ready to set up your recurring payment from your ${accountType} account. Tap below to approve with your Passkey and PIN.`;
      }
    }
  }

  if (!reply && missingQuestion && !suggestedAction && intent !== "unknown") {
    reply = missingQuestion;
  }

  // 5. System-aware conversational AI + live account diagnostics for questions, errors, and general help
  if (!reply) {
    const snapshot = await buildUserDiagnosticContext(auth, accountType, deps);
    const aiProvider = deps.aiProvider || require("../../agent/ai_provider");
    const history = Array.isArray(body?.history)
      ? body.history
          .slice(-6)
          .filter((h) => h && typeof h.text === "string" && (h.role === "user" || h.role === "assistant"))
          .map((h) => ({ role: h.role, content: h.text.slice(0, 600) }))
      : [];

    const systemPrompt = `${PROXIM_SYSTEM_KNOWLEDGE}\n\n=== CURRENT AUTHENTICATED USER DIAGNOSTIC CONTEXT (READ-ONLY) ===\n${JSON.stringify(snapshot)}`;
    let llmReply = null;
    if (typeof aiProvider.getTextCompletion === "function") {
      llmReply = await aiProvider.getTextCompletion(
        systemPrompt,
        [...history, { role: "user", content: message }],
        { maxTokens: 420, temperature: 0.25 }
      );
    }
    reply = llmReply || buildLocalSystemAnswer(message, snapshot);
  }

  // 6. Final deterministic DLP scrubber on all outbound assistant text
  reply = scrubAssistantOutput(reply);

  return {
    status: 200,
    data: {
      intent,
      confidence: classified?.confidence || "low",
      summary: classified?.raw_summary || null,
      reply,
      missingQuestion,
      confirmationText,
      suggestedAction,
      params,
      data,
    },
  };
}

module.exports = {
  ALLOWED_AI_ACTION_TYPES,
  checkSecurityBoundary,
  scrubAssistantOutput,
  sanitizeSuggestedAction,
  buildUserDiagnosticContext,
  buildLocalSystemAnswer,
  handleAssistantChat,
};
