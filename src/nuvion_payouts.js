// src/nuvion_payouts.js
// Nuvion Phase 3 — Global Outbound Pass-Through Payout Engine & Business Multi-Currency CSV Payroll
//
// Zero-Custody Pass-Through Design:
// 1. Live FX quote (USC -> any of Nuvion's 27 fiat currencies) with 1% FX margin baked cleanly into displayed rate.
// 2. Chain-abstracted funding from user's unified balance straight into user's Nuvion USC Base address:
//    Route 1: Circle Gateway (<500ms Arc -> Base)
//    Route 2: Direct Base USDC (gas-sponsored by Base relayer)
//    Route 3: Arc Mainnet -> Base CCTP (zero Base ETH needed on user wallet)
// 3. Automatic Nuvion dispatch when `inflows.completed` arrives on USC bridge account.
// 4. Completion HD Receipt PNG (Naira-only for NGN; clean fiat display for international) on `outflows.completed`.
// 5. Automatic USC -> Base 0x wallet refund on `outflows.failed` / `outflows.cancelled` (zero stranded custody).
// 6. Tier-1 NGN NIP routing with automatic Tier-0 Paj v2 failover.
// 7. Business Multi-Currency CSV Payroll with deterministic batch idempotency.

const crypto = require("node:crypto");
const { Contract, JsonRpcProvider, Signature, Wallet, getAddress, parseUnits } = require("ethers");
const nuvion = require("./nuvion");
const nuvionWebhooks = require("./nuvion_webhooks");
const corridors = require("./nuvion_corridors");
const db = require("./db");
const chains = require("./chains");
const gateway = require("./gateway");
const cctpBridge = require("./cctp_bridge");
const walletLib = require("./wallet");
const idempotency = require("./idempotency");
const fraudGuard = require("./fraud_guard");
const { generateReceiptPNG } = require("./receipt_generator");

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_DOMAIN_ID = 6;
const BASE_USDC_EIP3009_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: BASE_USDC_ADDRESS,
};
const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
];

let _payoutHooksRegistered = false;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBotTelegram(bot) {
  if (!bot) return null;
  if (bot.telegram && typeof bot.telegram.sendMessage === "function") return bot.telegram;
  if (bot.bot?.telegram && typeof bot.bot.telegram.sendMessage === "function") return bot.bot.telegram;
  return null;
}

function getUserPrivateKey(user, pin, accountType = "personal") {
  if (accountType === "business") {
    // STRICT ISOLATION: Business payouts/cards NEVER fall back to personal private key!
    if (!user.biz_encrypted_key) {
      throw new Error("Business wallet is not set up. Please provision your Business account before transacting.");
    }
    return db.decryptBusinessPrivateKey(pin, user);
  }
  return db.decryptPrivateKey(pin, user);
}

/**
 * Deterministic cross-module matcher for incoming Nuvion `USC` bridge deposits.
 * Inspects ALL `funding_in_transit` jobs on `entityId` across payouts, payroll batches,
 * card issuance, and card top-ups so concurrent jobs on the same entity NEVER steal each other's deposit!
 */
function selectBestMatchingUscCandidate(entityId, netArrivedMinor) {
  const candidates = [];

  const payoutJobs = db
    .getNuvionJobsByState("outbound_fiat_payout", "funding_in_transit")
    .filter((j) => j.entity_id === entityId);

  const batches = new Map();
  for (const job of payoutJobs) {
    const batchId = job.payload?.payrollBatchId || null;
    if (batchId) {
      if (!batches.has(batchId)) batches.set(batchId, []);
      batches.get(batchId).push(job);
    } else {
      const expectedMinor = Math.round(Number(job.payload?.expectedUscMinor || 0));
      candidates.push({
        kind: "outbound_fiat_payout",
        jobs: [job],
        expectedMinor,
        oldestId: job.id,
      });
    }
  }
  for (const [batchId, jobs] of batches.entries()) {
    const expectedMinor = jobs.reduce((sum, j) => sum + Math.round(Number(j.payload?.expectedUscMinor || 0)), 0);
    candidates.push({
      kind: "outbound_fiat_payout",
      batchId,
      jobs,
      expectedMinor,
      oldestId: Math.min(...jobs.map((j) => j.id)),
    });
  }

  const issueJobs = db
    .getNuvionJobsByState("card_issue", "funding_in_transit")
    .filter((j) => j.entity_id === entityId);
  for (const job of issueJobs) {
    const expectedMinor = Math.round(Number(job.payload?.nuvionNeededMinor || job.amount_minor || 0));
    candidates.push({
      kind: "card_issue",
      jobs: [job],
      expectedMinor,
      oldestId: job.id,
    });
  }

  const topupJobs = db
    .getNuvionJobsByState("card_topup", "funding_in_transit")
    .filter((j) => j.entity_id === entityId);
  for (const job of topupJobs) {
    const expectedMinor = Math.round(Number(job.payload?.loadAmountMinor || job.amount_minor || 0));
    candidates.push({
      kind: "card_topup",
      jobs: [job],
      expectedMinor,
      oldestId: job.id,
    });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const scored = candidates.map((c) => {
    const diff = c.expectedMinor > 0 ? Math.abs(netArrivedMinor - c.expectedMinor) : Number.MAX_SAFE_INTEGER;
    const tolerance = Math.max(100, Math.ceil((c.expectedMinor || 0) * 0.03));
    return { ...c, diff, withinTolerance: c.expectedMinor > 0 && diff <= tolerance };
  });

  const exactPool = scored.filter((s) => s.withinTolerance);
  const pool = exactPool.length > 0 ? exactPool : scored;
  pool.sort((a, b) => (a.diff - b.diff) || (a.oldestId - b.oldestId));
  return pool[0];
}

/**
 * Determine whether an approved Tier-1 user can route NGN NIP payouts via Nuvion
 * (Tier-0 users remain 100% on Solana Paj v2; Tier-1 falls back to Paj automatically on any error).
 */
function shouldUseNuvionForNgnPayout(telegramId, accountType = "personal") {
  if (!nuvion.isUserAllowedNuvion(telegramId)) return false;
  const entity = db.getNuvionEntityByUser(telegramId, accountType);
  return Boolean(entity && String(entity.status).toLowerCase() === "approved" && entity.usc_account_id && entity.usc_base_address);
}

/**
 * Ensure the user's approved Tier-1 entity has its USC bridge account & Base address ready.
 */
async function ensureApprovedBridgeEntity(telegramId, accountType = "personal") {
  let entity = db.getNuvionEntityByUser(telegramId, accountType);
  if (!entity || String(entity.status).toLowerCase() !== "approved") {
    throw new Error("Tier-1 verification must be approved before sending international payouts.");
  }
  if (!entity.usc_account_id || !entity.usc_base_address || !entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
  }
  if (!entity.usc_account_id || !entity.usc_base_address) {
    throw new Error("Your global settlement bridge is still provisioning. Please retry in a moment.");
  }
  return entity;
}

// ── 1. Live FX Quote with 1% FX Margin Baked Cleanly Into Displayed Rate ─────

/**
 * Request an indicative live Nuvion FX quote (USC -> targetCurrency) for `targetAmountMajor`
 * and bake Proxim's 1% FX margin (`NUVION_FX_MARGIN_BPS=100`) cleanly into the effective rate.
 */
async function quoteGlobalPayout({
  telegramId,
  accountType = "personal",
  railKey,
  targetCurrency,
  targetAmountMajor,
}) {
  const code = String(targetCurrency || "").toUpperCase();
  if (!corridors.isSupportedFiatCurrency(code)) {
    throw new Error(`Currency ${code} is not supported for global payouts.`);
  }
  const rail = corridors.getRailByKey(railKey, code);
  if (!rail) {
    throw new Error(`Unsupported payout rail: ${railKey}`);
  }

  const limitCheck = corridors.validateCorridorAmount(rail.key, targetAmountMajor, code);
  if (!limitCheck.valid) {
    throw new Error(limitCheck.error);
  }

  const entity = await ensureApprovedBridgeEntity(telegramId, accountType);
  const targetAmountMinor = nuvion.toNuvionMinor(targetAmountMajor);

  const quote = await nuvion.createFxQuote({
    entityId: entity.entity_id,
    fromCurrency: "USC",
    toCurrency: code,
    amountTo: targetAmountMinor,
    accountId: entity.usc_account_id,
  });

  const nuvionPrincipalMinor = Math.round(Number(quote.amount_from) || 0);
  if (nuvionPrincipalMinor <= 0) {
    throw new Error("Unable to retrieve a valid live exchange rate for this corridor right now.");
  }

  const nuvionPrincipalUsd = nuvion.fromNuvionMinor(nuvionPrincipalMinor);
  const railFeeInfo = corridors.estimateNuvionRailFeeUsd(
    rail.key,
    code,
    nuvionPrincipalUsd,
    targetAmountMajor,
    quote.rate
  );
  const nuvionRailFeeUsd = railFeeInfo.nuvionRailFeeUsd;
  const nuvionRailFeeMinor = nuvion.toNuvionMinor(nuvionRailFeeUsd);

  // Total USC that must land on Nuvion = FX principal + Nuvion's outbound rail fee
  const nuvionCostMinor = nuvionPrincipalMinor + nuvionRailFeeMinor;
  const nuvionCostUsd = nuvion.fromNuvionMinor(nuvionCostMinor);

  // Proxim platform fee: enforced strictly (default 1.00% with $0.50 minimum on international payouts)
  const marginBps = nuvion.getFxMarginBps("outbound");
  const minProximFeeMinor = Math.max(0, Math.round(Number(process.env.PROXIM_MIN_PAYOUT_FEE_USD ?? 0.5) * 100));
  const rawMarginMinor = marginBps > 0 ? nuvion.calcMarginMinor(nuvionPrincipalMinor, marginBps) : 0;
  const marginMinor = marginBps > 0 ? Math.max(minProximFeeMinor, rawMarginMinor) : 0;
  const userTotalMinor = nuvionCostMinor + marginMinor;

  const marginUsd = nuvion.fromNuvionMinor(marginMinor);
  const userTotalUsd = nuvion.fromNuvionMinor(userTotalMinor);
  const effectiveRate = userTotalUsd > 0 ? (Number(targetAmountMajor) / userTotalUsd) : Number(quote.rate || 0);

  return {
    entity,
    rail,
    targetCurrency: code,
    targetAmountMajor: Number(targetAmountMajor),
    targetAmountMinor,
    nuvionQuoteId: quote.id,
    nuvionRawRate: Number(quote.rate || 0),
    nuvionPrincipalMinor,
    nuvionPrincipalUsd,
    nuvionRailFeeMinor,
    nuvionRailFeeUsd,
    nuvionFeeLabel: railFeeInfo.feeLabel,
    nuvionCostMinor,
    nuvionCostUsd,
    marginBps,
    marginMinor,
    marginUsd,
    userTotalMinor,
    userTotalUsd,
    effectiveRate,
    expiresAt: quote.quote?.expires_at || (Date.now() + 180000),
    validForSec: quote.quote?.valid_for || 180,
  };
}

// ── 2. Recipient Counterparty & Payment Detail Registration (Reusable!) ──────

function _recipientFingerprint(currency, railKey, details) {
  const keyPart = (
    details.iban ||
    details.account_number ||
    details.phone_number ||
    details.email ||
    ""
  ).toLowerCase().replace(/\s+/g, "");
  return `${String(currency).toUpperCase()}:${railKey}:${keyPart}`;
}

/**
 * Create or reuse a recipient counterparty + payment detail on the child entity.
 */
async function ensurePayoutRecipient(entityId, rail, details) {
  const currency = String(rail.currency || "").toUpperCase();
  const fp = _recipientFingerprint(currency, rail.key, details);

  const existing = db.getNuvionCounterpartiesByEntity(entityId, currency).find((c) => {
    try {
      const s = c.summary_json ? JSON.parse(c.summary_json) : {};
      return s.fingerprint === fp && !s.isSelf && !s.isPlatformMargin;
    } catch (_) {
      return false;
    }
  });

  if (existing) {
    return {
      counterpartyId: existing.counterparty_id,
      paymentDetailId: existing.payment_detail_id,
      reused: true,
      record: existing,
    };
  }

  const cpPayload = corridors.buildCounterpartyPayload(entityId, rail, details);
  const cp = await nuvion.createCounterparty(cpPayload);

  const pdPayload = corridors.buildPaymentDetailPayload(entityId, cp.id, rail, details);
  const pd = await nuvion.createPaymentDetail(pdPayload);

  const label = `${details.account_holder_name} (${currency} · ${rail.label.split("(")[0].trim()})`.slice(0, 80);
  db.saveNuvionCounterparty({
    entityId,
    counterpartyId: cp.id,
    paymentDetailId: pd.id,
    label,
    currency,
    scheme: pdPayload.scheme || rail.key,
    paymentMethod: rail.paymentMethod,
    accountHolderName: details.account_holder_name,
    summary: {
      fingerprint: fp,
      railKey: rail.key,
      country: pdPayload.country,
      accountTail: (details.iban || details.account_number || details.phone_number || details.email || "").slice(-6),
      bankName: details.bank_name || pdPayload.scheme || rail.label,
    },
  });

  return {
    counterpartyId: cp.id,
    paymentDetailId: pd.id,
    reused: false,
  };
}

// ── 3. Smart Chain-Abstracted Funding (Circle Gateway / Base / Arc->Base CCTP) ─

/**
 * Sign an off-chain EIP-3009 `TransferWithAuthorization` for native Base USDC
 * so the platform relayer submits a single gasless transaction with ZERO Base ETH on the user's wallet!
 */
async function signBaseUsdcTransferAuthorization({ userWallet, toAddress, amountUsdc, validForSeconds = 600 }) {
  const from = getAddress(await userWallet.getAddress());
  const to = getAddress(toAddress);
  const value = parseUnits(Number(amountUsdc).toFixed(6), 6);
  const nowSec = Math.floor(Date.now() / 1000);
  const validAfter = Math.max(0, nowSec - 60);
  const validBefore = nowSec + Math.max(60, Number(validForSeconds) || 600);
  const nonce = "0x" + crypto.randomBytes(32).toString("hex");

  const message = { from, to, value, validAfter, validBefore, nonce };
  const signature = await userWallet.signTypedData(BASE_USDC_EIP3009_DOMAIN, TRANSFER_WITH_AUTH_TYPES, message);
  const sig = Signature.from(signature);
  return {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
    signature,
  };
}

async function sendDirectBaseUsdc(privateKey, toAddress, amountUsdc) {
  const baseCfg = chains.getChain("base");
  const rpcUrl = baseCfg?.rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
  const userSigner = new Wallet(privateKey, provider);
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

  // Preferred Path (Zero ETH dust on user wallet, 1 single Base tx):
  // User signs off-chain EIP-3009 TransferWithAuthorization; relayer broadcasts directly to Base USDC!
  if (relayerKey) {
    try {
      const relayer = new Wallet(relayerKey, provider);
      const relBal = await provider.getBalance(relayer.address).catch(() => 0n);
      const minRelayerGas = parseUnits("0.00001", 18);
      if (relBal >= minRelayerGas) {
        const auth = await signBaseUsdcTransferAuthorization({
          userWallet: userSigner,
          toAddress,
          amountUsdc,
        });
        const usdcAsRelayer = new Contract(BASE_USDC_ADDRESS, ERC20_TRANSFER_ABI, relayer);
        const tx = await usdcAsRelayer.transferWithAuthorization(
          auth.from,
          auth.to,
          auth.value,
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.v,
          auth.r,
          auth.s
        );
        await tx.wait(1);
        return { route: "base_eip3009_gasless", txHash: tx.hash };
      }
    } catch (eipErr) {
      console.warn("[nuvion_payouts] EIP-3009 gasless Base transfer fallback:", eipErr.message);
    }
  }

  // Fallback Path: Micro-gas drip (0.000025 ETH on Base) + standard ERC-20 transfer
  try {
    const ethBal = await provider.getBalance(userSigner.address);
    const minGas = parseUnits("0.000015", 18);
    if (ethBal < minGas && relayerKey) {
      const relayer = new Wallet(relayerKey, provider);
      const drip = parseUnits("0.000025", 18);
      const relBal = await provider.getBalance(relayer.address).catch(() => 0n);
      if (relBal >= drip) {
        const dripTx = await relayer.sendTransaction({ to: userSigner.address, value: drip });
        await dripTx.wait(1);
      }
    }
  } catch (gasErr) {
    console.warn("[nuvion_payouts] Base gas sponsor note:", gasErr.message);
  }

  const usdc = new Contract(BASE_USDC_ADDRESS, ERC20_TRANSFER_ABI, userSigner);
  const units = parseUnits(Number(amountUsdc).toFixed(6), 6);
  const tx = await usdc.transfer(toAddress, units);
  await tx.wait(1);
  return { route: "base_direct", txHash: tx.hash };
}

/**
 * Fund the user's Nuvion USC Base deposit address from their unified Proxim wallet
 * (zero Base ETH required on user wallet for Gateway or Arc->Base CCTP!)
 * and collect Proxim's 1% FX margin into the configured fee wallet.
 */
async function fundNuvionBaseBridge({
  user,
  pin,
  accountType = "personal",
  nuvionBaseAddress,
  nuvionCostUsd,
  marginUsd = 0,
  bot = null,
  fundingExecutor = null,
}) {
  const totalNeededUsd = round2(Number(nuvionCostUsd) + Number(marginUsd));
  // STRICT ISOLATION: never blend Personal balance into a Business account!
  const unified = await chains.getUnifiedBalance(user, accountType, { strictBusiness: true });
  if (unified.total + 0.001 < totalNeededUsd) {
    throw new Error(
      `Insufficient balance. Needed $${totalNeededUsd.toFixed(2)}, available $${unified.total.toFixed(2)}.`
    );
  }

  const privateKey = getUserPrivateKey(user, pin, accountType);

  // Optional test/mock funding hook
  if (typeof fundingExecutor === "function") {
    return fundingExecutor({
      privateKey,
      nuvionBaseAddress,
      nuvionCostUsd,
      marginUsd,
      unified,
    });
  }

  let fundingResult = null;
  let arcAvailable = Number(unified.arc?.usdc || 0);
  let baseAvailable = Number(unified.base?.usdc || 0);
  const gwAvailable = Number(unified.gateway?.usdc || 0);

  // Route 1 (Fastest <500ms): Circle Gateway unified USDC -> mint straight onto Base Nuvion address
  if (gwAvailable >= nuvionCostUsd) {
    const signer = new Wallet(privateKey);
    const gwRes = await gateway.transferBetweenChains({
      signer,
      sourceChain: "Arc",
      destinationChain: "Base",
      amountUsdc: nuvionCostUsd,
      recipientAddress: nuvionBaseAddress,
    });
    fundingResult = {
      route: "circle_gateway",
      txHash: gwRes.txHash || gwRes.transferId || `gw_${Date.now()}`,
    };
  }
  // Route 2: Direct Base USDC (if already sitting on Base EOA — instant 2s on Base!)
  else if (baseAvailable >= nuvionCostUsd) {
    fundingResult = await sendDirectBaseUsdc(privateKey, nuvionBaseAddress, nuvionCostUsd);
  }
  // Route 3: Arc Mainnet -> Base CCTP burn (or auto-consolidate split Base+Arc -> Arc first!)
  else {
    // If balance is split across Arc + Base (e.g. fresh Nuvion deposit + existing Paj Arc balance),
    // automatically sweep Base -> Arc silently so Arc covers the full transfer seamlessly!
    if (arcAvailable < nuvionCostUsd && baseAvailable >= 1.0 && (arcAvailable + baseAvailable) >= nuvionCostUsd) {
      try {
        const evmDepositSweeper = require("./evm_deposit_sweeper");
        await evmDepositSweeper.sweepUserDeposits(user.telegram_id, null, {
          silent: true,
          onlyChain: "BASE",
          onlyAccountType: accountType,
          overridePrivateKey: privateKey,
          force: true,
        });
        const refreshed = await chains.getUnifiedBalance(user, accountType, { strictBusiness: true });
        arcAvailable = Number(refreshed.arc?.usdc || 0);
        baseAvailable = Number(refreshed.base?.usdc || 0);
      } catch (consolidateErr) {
        console.warn("[nuvion_payouts] Split Base+Arc auto-consolidation note:", consolidateErr.message);
      }
    }

    if (arcAvailable >= nuvionCostUsd) {
      const arcWallet = walletLib.walletFromPrivateKey(privateKey);
      const burn = await cctpBridge.executeArcToEvmCctpBurn({
        userWallet: arcWallet,
        amountUsdc: nuvionCostUsd,
        destinationDomain: BASE_DOMAIN_ID,
        destinationRecipientAddress: nuvionBaseAddress,
        telegramId: user.telegram_id,
      });
      if (!burn?.success) {
        throw new Error(burn?.error || "Failed to initiate Arc -> Base settlement transfer.");
      }
      fundingResult = {
        route: "arc_cctp_base",
        txHash: burn.txHash,
        messageHash: burn.messageHash || null,
      };

      // Kick off non-blocking relayer mint onto Base straight into Nuvion's Base USC address
      if (process.env.NODE_ENV !== "test") {
        cctpBridge.completeCctpWithdrawalOnEvm({
          arcTxHash: burn.txHash,
          messageHex: burn.messageHex || null,
          messageHash: burn.messageHash || null,
          destinationDomain: BASE_DOMAIN_ID,
          destinationRecipientAddress: nuvionBaseAddress,
          userWallet: arcWallet,
          userPrivateKey: privateKey,
          telegramId: user.telegram_id,
          bot: null, // Silent bridge — Nuvion payout webhook sends the clean fiat receipt!
          amountUsdc: nuvionCostUsd,
          chainName: "Base",
        }).catch((err) => {
          console.warn("[nuvion_payouts] Arc->Base CCTP completion note:", err.message);
        });
      }
    } else {
      throw new Error(
        "Your funds are split across rails. Please consolidate into your main balance or wait a moment for pending sweeps to settle."
      );
    }
  }

  // Collect 1% FX margin (plus any Proxim card issuance fee) to Proxim's fee wallet across Arc, Base, or Gateway!
  const feeRecipient = (
    process.env.APP_FEE_RECIPIENT_ADDRESS ||
    process.env.PAYIT_DEV_FEE_ADDRESS ||
    process.env.FEE_RECIPIENT_ADDRESS ||
    "0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359"
  ).trim();

  let marginTxHash = null;
  if (marginUsd >= 0.01) {
    if (!feeRecipient || !walletLib.isValidAddress(feeRecipient)) {
      throw new Error("Proxim fee recipient wallet is not configured; payout blocked.");
    }
    const arcWallet = walletLib.walletFromPrivateKey(privateKey);
    if (feeRecipient.toLowerCase() !== arcWallet.address.toLowerCase()) {
      const arcRemaining = round2(
        arcAvailable - (fundingResult?.route === "arc_cctp_base" ? Number(nuvionCostUsd) : 0)
      );
      const baseRemaining = round2(
        baseAvailable -
          (fundingResult?.route === "base_direct" || fundingResult?.route === "base_eip3009_sponsored"
            ? Number(nuvionCostUsd)
            : 0)
      );
      const gwRemaining = round2(
        gwAvailable - (fundingResult?.route === "circle_gateway" ? Number(nuvionCostUsd) : 0)
      );

      if (arcRemaining + 0.001 >= marginUsd) {
        const feeRes = await walletLib.sendSponsoredOrDirectTransaction(
          arcWallet,
          feeRecipient,
          walletLib.parseToMicro(marginUsd.toFixed(6))
        );
        marginTxHash = feeRes?.txHash || feeRes?.hash || (typeof feeRes === "string" ? feeRes : null);
      } else if (baseRemaining + 0.001 >= marginUsd) {
        const baseFeeRes = await sendDirectBaseUsdc(privateKey, feeRecipient, marginUsd);
        marginTxHash = baseFeeRes?.txHash || null;
      } else if (gwRemaining + 0.001 >= marginUsd) {
        const signer = new Wallet(privateKey);
        const gwFeeRes = await gateway.transferBetweenChains({
          signer,
          sourceChain: "Arc",
          destinationChain: "Base",
          amountUsdc: marginUsd,
          recipientAddress: feeRecipient,
        });
        marginTxHash = gwFeeRes?.txHash || gwFeeRes?.transferId || null;
      } else {
        throw new Error(
          `Insufficient balance to cover Proxim platform fee ($${marginUsd.toFixed(2)}). Please top up and try again.`
        );
      }

      if (!marginTxHash) {
        throw new Error("Proxim platform fee collection did not return a transaction hash; payout aborted.");
      }
    }
  }

  return { ...fundingResult, marginTxHash };
}

// ── 4. Initiate Outbound Pass-Through Payout ─────────────────────────────────

/**
 * End-to-end initiation of a single outbound fiat payout across any of Nuvion's 27 currencies:
 *  1. Verify PIN & live quote (with 1% FX margin)
 *  2. Register or reuse counterparty & payment detail on Nuvion
 *  3. Fund Nuvion USC Base address via Circle Gateway / Base / Arc->Base CCTP
 *  4. Create durable `outbound_fiat_payout` job (`funding_in_transit`) awaiting `inflows.completed`
 */
async function initiateGlobalPayout({
  telegramId,
  pin,
  accountType = "personal",
  railKey,
  targetCurrency,
  targetAmountMajor,
  recipientDetails = null,
  savedCounterparty = null,
  narration = null,
  bot = null,
  fundingExecutor = null,
}) {
  const user = db.getUser(telegramId);
  if (!user) throw new Error("User account not found.");
  if (!db.verifyPin(telegramId, pin)) throw new Error("Incorrect PIN.");

  const quoteInfo = await quoteGlobalPayout({
    telegramId,
    accountType,
    railKey,
    targetCurrency,
    targetAmountMajor,
  });

  // Enforce Anti-Fraud Velocity Tripwires, Tier Daily Limits & Global Circuit Breaker (Finding 5)
  await fraudGuard.assertOutboundAllowed({
    telegramId,
    accountType,
    action: `nuvion_payout_${quoteInfo.targetCurrency}`,
    amountUsd: quoteInfo.userTotalUsd,
    reference: railKey,
    bot,
  });

  const { entity, rail } = quoteInfo;

  // Resolve recipient counterparty + payment detail
  let counterpartyId;
  let paymentDetailId;
  let recipientName;
  let recipientSummary;

  if (savedCounterparty && savedCounterparty.counterparty_id && savedCounterparty.payment_detail_id) {
    counterpartyId = savedCounterparty.counterparty_id;
    paymentDetailId = savedCounterparty.payment_detail_id;
    recipientName = savedCounterparty.account_holder_name || savedCounterparty.label;
    recipientSummary = savedCounterparty.label;
  } else {
    if (!recipientDetails) throw new Error("Recipient banking details are required.");
    const registered = await ensurePayoutRecipient(entity.entity_id, rail, recipientDetails);
    counterpartyId = registered.counterpartyId;
    paymentDetailId = registered.paymentDetailId;
    recipientName = recipientDetails.account_holder_name;
    recipientSummary = `${recipientName} (${quoteInfo.targetCurrency})`;
  }

  const refSuffix = crypto.randomBytes(4).toString("hex");
  const uniqueReference = `prx-out-${Date.now()}-${refSuffix}`;

  const basePayload = {
    railKey: rail.key,
    paymentMethod: rail.paymentMethod,
    railLabel: rail.label,
    targetCurrency: quoteInfo.targetCurrency,
    targetAmountMajor: quoteInfo.targetAmountMajor,
    targetAmountMinor: quoteInfo.targetAmountMinor,
    nuvionPrincipalMinor: quoteInfo.nuvionPrincipalMinor,
    nuvionRailFeeMinor: quoteInfo.nuvionRailFeeMinor,
    expectedUscMinor: quoteInfo.nuvionCostMinor,
    userTotalUsd: quoteInfo.userTotalUsd,
    effectiveRate: quoteInfo.effectiveRate,
    counterpartyId,
    paymentDetailId,
    recipientName,
    recipientSummary,
    narration: narration || `Payment to ${recipientName}`,
    fundingRoute: null,
    fundingTxHash: null,
    marginTxHash: null,
  };

  // CRITICAL: Insert durable job row BEFORE broadcasting funds so <500ms Gateway settlement
  // can NEVER arrive before the job exists!
  let job = db.createNuvionJob({
    entityId: entity.entity_id,
    telegramId,
    accountType,
    jobType: "outbound_fiat_payout",
    state: "funding_in_transit",
    currency: quoteInfo.targetCurrency,
    amountMinor: quoteInfo.targetAmountMinor,
    marginMinor: quoteInfo.marginMinor,
    uniqueReference,
    sourceTxHash: null,
    fxQuoteId: quoteInfo.nuvionQuoteId,
    payload: basePayload,
  });

  // Fund Nuvion USC Base deposit address from user's unified balance
  let funding;
  try {
    funding = await fundNuvionBaseBridge({
      user,
      pin,
      accountType,
      nuvionBaseAddress: entity.usc_base_address,
      nuvionCostUsd: quoteInfo.nuvionCostUsd,
      marginUsd: quoteInfo.marginUsd,
      bot,
      fundingExecutor,
    });
  } catch (fundErr) {
    db.updateNuvionJob(job.id, { state: "failed", error_message: fundErr.message });
    throw fundErr;
  }

  job = db.updateNuvionJob(job.id, {
    source_tx_hash: funding.txHash || null,
    payload_json: {
      ...basePayload,
      fundingRoute: funding.route,
      fundingTxHash: funding.txHash || null,
      marginTxHash: funding.marginTxHash || null,
    },
  });

  return {
    job,
    quote: quoteInfo,
    funding,
    uniqueReference,
  };
}

// ── 5. Automatic Nuvion Dispatch on USC Base Inflow (`inflows.completed`) ────

async function _dispatchSinglePayoutJob({ job, entity, availableUscMinor, isBatchItem = false }) {
  const p = job.payload || {};
  const targetCurrency = p.targetCurrency || job.currency;
  const targetAmountMinor = p.targetAmountMinor || job.amount_minor;
  const paymentMethod = p.paymentMethod || "bank-transfer";
  const accountId = entity.usc_account_id;

  let quote = null;
  let transfer = null;

  // Attempt 1: exact destination amount (`amount_to`) if within available USC, else cap by `amount_from`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 0) {
        quote = await nuvion.createFxQuote({
          entityId: entity.entity_id,
          fromCurrency: "USC",
          toCurrency: targetCurrency,
          amountTo: targetAmountMinor,
          accountId,
        });
        // If live FX moved slightly higher than landed USC, re-quote capped to exact landed USC
        if (quote.amount_from > availableUscMinor) {
          const safeFrom = isBatchItem
            ? Math.min(availableUscMinor, p.expectedUscMinor || availableUscMinor)
            : availableUscMinor;
          if (safeFrom <= 0) throw new Error("Insufficient arrived USC to execute payout.");
          quote = await nuvion.createFxQuote({
            entityId: entity.entity_id,
            fromCurrency: "USC",
            toCurrency: targetCurrency,
            amountFrom: safeFrom,
            accountId,
          });
        }
      } else {
        // Retry with fee buffer deducted after 400 error_transfer_insufficient_funds
        const feeBuf = Math.max(50, Math.ceil(availableUscMinor * 0.015));
        const safeFrom = Math.max(1, availableUscMinor - feeBuf);
        quote = await nuvion.createFxQuote({
          entityId: entity.entity_id,
          fromCurrency: "USC",
          toCurrency: targetCurrency,
          amountFrom: safeFrom,
          accountId,
        });
      }

      const ref = attempt === 0 ? job.unique_reference : `${job.unique_reference}-r${attempt}`;
      transfer = await nuvion.createTransfer({
        entityId: entity.entity_id,
        accountId,
        counterpartyId: p.counterpartyId,
        paymentDetailId: p.paymentDetailId,
        amountMinor: quote.amount_from,
        currency: "USC",
        narration: p.narration || `Proxim payout ${job.unique_reference}`,
        paymentType: paymentMethod,
        fxQuoteId: quote.id,
        uniqueReference: ref,
      });
      break;
    } catch (err) {
      if (attempt === 0 && err instanceof nuvion.NuvionError && err.type === "error_transfer_insufficient_funds") {
        console.warn(`[nuvion_payouts] Fee-buffer retry on payout job #${job.id}`);
        continue;
      }
      db.updateNuvionJob(job.id, {
        state: "retry_pending",
        retry_count: (job.retry_count || 0) + 1,
        error_message: err.message,
      });
      throw err;
    }
  }

  const updatedJob = db.updateNuvionJob(job.id, {
    state: "dispatched",
    fx_quote_id: quote.id,
    nuvion_transfer_id: transfer.id,
    payload_json: {
      ...p,
      dispatchedUscMinor: quote.amount_from,
      dispatchedTargetMinor: quote.amount_to,
      dispatchedRate: quote.rate,
      nuvionTransferId: transfer.id,
    },
  });

  return { job: updatedJob, transfer, quote, spentUscMinor: quote.amount_from };
}

/**
 * Triggered automatically when `inflows.completed` arrives on a user's Nuvion `USC` bridge account.
 * Dispatches matching queued `outbound_fiat_payout` job(s) (including multi-row Business CSV payroll batches!)
 * and keeps Nuvion balance swept cleanly down to 0.00.
 */
async function handleUscInflowForPendingPayout({ confirmed, entityRecord, bot = null }) {
  if (!confirmed || !entityRecord) return { dispatched: false, reason: "missing_context" };
  const currency = String(confirmed.currency || "").toUpperCase();
  const status = String(confirmed.status || "").toLowerCase();
  if (currency !== "USC" || status !== "successful") {
    return { dispatched: false, reason: "not_settled_usc" };
  }

  const inflowClaimKey = confirmed.id ? `nuvion_usc_inflow:${confirmed.id}` : null;
  if (inflowClaimKey && idempotency.isWebhookProcessed(inflowClaimKey)) {
    return { dispatched: false, duplicate: true, reason: "inflow_already_claimed" };
  }

  const netArrivedMinor = Math.max(0, Math.round(Number(confirmed.amount || 0)) - Math.round(Number(confirmed.applicable_fee || 0)));
  if (netArrivedMinor <= 0) return { dispatched: false, reason: "zero_net_inflow" };

  // Cross-module best-fit match: never steal a USC deposit meant for a card issuance/top-up!
  const best = selectBestMatchingUscCandidate(entityRecord.entity_id, netArrivedMinor);
  if (!best) {
    return { dispatched: false, reason: "no_pending_payout_jobs" };
  }
  if (best.kind !== "outbound_fiat_payout") {
    return { dispatched: false, reason: "deferred_to_card_job" };
  }

  // Atomically claim this USC inflow so no second handler/retry can double-spend it
  if (inflowClaimKey) {
    const claimedInflow = idempotency.tryClaimWebhookEvent(inflowClaimKey, "usc_inflow_payout", entityRecord.entity_id);
    if (!claimedInflow) {
      return { dispatched: false, duplicate: true, reason: "inflow_already_claimed" };
    }
  }

  let remainingMinor = netArrivedMinor;
  const dispatched = [];
  const targetJobs = best.jobs;

  for (const job of targetJobs) {
    if (remainingMinor <= 0) break;

    // Atomic SQLite state lock: funding_in_transit -> dispatching
    const locked = db.db
      .prepare("UPDATE nuvion_jobs SET state = 'dispatching', updated_at = datetime('now') WHERE id = ? AND state = 'funding_in_transit'")
      .run(job.id);
    if (!locked || locked.changes === 0) {
      continue;
    }

    const itemCap = targetJobs.length > 1
      ? Math.min(remainingMinor, Math.round((job.payload?.expectedUscMinor || remainingMinor) * 1.02))
      : remainingMinor;
    try {
      const res = await _dispatchSinglePayoutJob({
        job,
        entity: entityRecord,
        availableUscMinor: itemCap,
        isBatchItem: targetJobs.length > 1,
      });
      remainingMinor = Math.max(0, remainingMinor - res.spentUscMinor);
      dispatched.push({ jobId: job.id, transferId: res.transfer.id, spentUscMinor: res.spentUscMinor });
    } catch (err) {
      console.error(`[nuvion_payouts] Failed dispatching payout job #${job.id}:`, err.message);
      dispatched.push({ jobId: job.id, error: err.message });
    }
  }

  return { dispatched: dispatched.length > 0, count: dispatched.length, results: dispatched, remainingMinor };
}

// ── 6. Completion HD Receipt & Automatic Failure Refund to Base 0x ───────────

function _findOutboundJobForTransfer(confirmed) {
  if (!confirmed) return null;
  if (confirmed.id) {
    const byTx = db
      .prepare("SELECT * FROM nuvion_jobs WHERE job_type = 'outbound_fiat_payout' AND nuvion_transfer_id = ? LIMIT 1")
      .get(String(confirmed.id));
    if (byTx) {
      let payload = {};
      try { payload = byTx.payload_json ? JSON.parse(byTx.payload_json) : {}; } catch (_) {}
      return { ...byTx, payload };
    }
  }
  if (confirmed.unique_reference) {
    const byRef = db
      .prepare("SELECT * FROM nuvion_jobs WHERE job_type = 'outbound_fiat_payout' AND unique_reference = ? LIMIT 1")
      .get(String(confirmed.unique_reference));
    if (byRef) {
      let payload = {};
      try { payload = byRef.payload_json ? JSON.parse(byRef.payload_json) : {}; } catch (_) {}
      return { ...byRef, payload };
    }
  }
  return null;
}

/**
 * Handle `outflows.completed` for an outbound fiat payout:
 * records ledger row & sends HD Receipt PNG (Naira-only for NGN, clean fiat for international).
 */
async function handleOutboundPayoutCompleted({ confirmed, entityRecord, bot = null }) {
  const job = _findOutboundJobForTransfer(confirmed);
  if (!job) return { handled: false, reason: "no_matching_payout_job" };
  if (job.state === "completed") return { handled: true, duplicate: true, jobId: job.id };

  const p = job.payload || {};
  const targetCurrency = p.targetCurrency || job.currency || "USD";
  const targetMajor = p.dispatchedTargetMinor
    ? nuvion.fromNuvionMinor(p.dispatchedTargetMinor)
    : (p.targetAmountMajor || nuvion.fromNuvionMinor(job.amount_minor));
  const userTotalUsd = Number(p.userTotalUsd || nuvion.fromNuvionMinor(confirmed.amount || 0));
  const isNgn = targetCurrency === "NGN";

  db.updateNuvionJob(job.id, { state: "completed" });

  // Record ledger transaction
  try {
    const txType = isNgn ? "withdraw_naira" : "payout_global";
    const amountMicro = walletLib.parseToMicro(userTotalUsd.toFixed(6));
    db.recordTransaction(
      job.telegram_id,
      txType,
      String(amountMicro),
      "confirmed",
      confirmed.id || job.nuvion_transfer_id,
      job.account_type || "personal",
      18,
      "base",
      p.narration || `Payout to ${p.recipientName || targetCurrency}`
    );
  } catch (txErr) {
    console.warn("[nuvion_payouts] recordTransaction note:", txErr.message);
  }

  // Notify external Builder webhook (if wallet belongs to an API key with webhook_url)
  try {
    const apiKeys = require("./api_keys");
    apiKeys.dispatchBuilderWebhook(job.telegram_id, "payout.completed", {
      reference: job.unique_reference,
      currency: targetCurrency,
      targetAmountMajor: targetMajor,
      totalDebitUsd: userTotalUsd,
      transferId: confirmed.id,
      status: "completed",
    }).catch(() => {});
  } catch (_) {}

  // Send HD Receipt PNG in Telegram
  const telegram = getBotTelegram(bot);
  if (telegram && job.telegram_id) {
    const fiatDisplay = corridors.formatCurrencyMajor(targetCurrency, targetMajor);
    const captionLines = [
      `✅ <b>Transfer Delivered!</b>`,
      `──────────────────────────`,
      `👤 <b>Recipient:</b> ${escapeHtml(p.recipientName || "Recipient")}`,
      `💵 <b>Amount Delivered:</b> ${fiatDisplay}`,
    ];
    if (!isNgn) {
      captionLines.push(`💳 <b>Total Paid:</b> $${userTotalUsd.toFixed(2)}`);
      if (p.effectiveRate) {
        captionLines.push(`💱 <b>Rate:</b> 1 USD = ${Number(p.effectiveRate).toFixed(4)} ${targetCurrency}`);
      }
    }
    if (p.railLabel) captionLines.push(`🏦 <b>Method:</b> ${escapeHtml(p.railLabel)}`);
    if (p.narration) captionLines.push(`💬 <b>Note:</b> <i>${escapeHtml(p.narration)}</i>`);
    captionLines.push(`🔖 <b>Reference:</b> <code>${escapeHtml(confirmed.id || job.unique_reference)}</code>`);
    const caption = captionLines.join("\n");

    let receiptPath = null;
    try {
      receiptPath = await generateReceiptPNG({
        receiptId: `PAY-${String(confirmed.id || job.id).slice(-10)}`,
        senderName: entityRecord?.legal_name || "Proxim Account",
        recipientName: p.recipientName || "Recipient",
        amountUsdc: userTotalUsd,
        displayCurrency: isNgn ? "NGN" : "USD",
        fiatAmountDisplay: isNgn ? fiatDisplay : `${fiatDisplay} ($${userTotalUsd.toFixed(2)})`,
        type: p.payrollBatchId ? "Payroll" : "Cash Out",
        timestamp: new Date().toISOString(),
        status: "Confirmed",
        txHash: confirmed.id || job.unique_reference,
        narration: p.narration || null,
      });
    } catch (_) {}

    if (receiptPath && typeof telegram.sendPhoto === "function") {
      try {
        await telegram.sendPhoto(job.telegram_id, { source: receiptPath }, { caption, parse_mode: "HTML" });
      } catch (_) {
        await telegram.sendMessage(job.telegram_id, caption, { parse_mode: "HTML" }).catch(() => {});
      }
    } else {
      await telegram.sendMessage(job.telegram_id, caption, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  return { handled: true, jobId: job.id, status: "completed" };
}

/**
 * Handle `outflows.failed` / `outflows.cancelled`:
 * Nuvion credits the USC back into the user's Nuvion USC account.
 * Proxim immediately fires that USC straight back to the user's 0x wallet on BASE_MAINNET
 * so zero funds ever sit stranded inside Nuvion!
 */
async function handleOutboundPayoutFailed({ confirmed, entityRecord, bot = null }) {
  const job = _findOutboundJobForTransfer(confirmed);
  if (!job) return { refunded: false, reason: "no_matching_payout_job" };

  // Atomic SQLite claim so simultaneous webhook + poller can NEVER double-refund!
  const claimed = db.db
    .prepare("UPDATE nuvion_jobs SET state = 'refunding', updated_at = datetime('now') WHERE id = ? AND state NOT IN ('refunding', 'refunded')")
    .run(job.id);
  if (!claimed || claimed.changes === 0) {
    return { refunded: false, duplicate: true, jobId: job.id };
  }

  let entity = entityRecord || db.getNuvionEntityByEntityId(job.entity_id);
  if (!entity) {
    db.updateNuvionJob(job.id, { state: "refund_pending", error_message: "missing_entity" });
    return { refunded: false, reason: "missing_entity" };
  }
  if (!entity.self_counterparty_id || !entity.self_base_payment_detail_id) {
    entity = await nuvionWebhooks.bootstrapApprovedEntity(entity);
  }

  let refundMinor = Math.round(Number(confirmed.amount || job.payload?.dispatchedUscMinor || job.payload?.expectedUscMinor || 0));
  if (refundMinor <= 0) {
    db.updateNuvionJob(job.id, { state: "failed", error_message: "Zero refund amount" });
    return { refunded: false, reason: "zero_refund_amount" };
  }

  let refundTransfer = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = attempt === 0 ? `refund-${job.unique_reference}` : `refund-${job.unique_reference}-r${attempt}`;
    try {
      refundTransfer = await nuvion.createTransfer({
        entityId: entity.entity_id,
        accountId: entity.usc_account_id,
        counterpartyId: entity.self_counterparty_id,
        paymentDetailId: entity.self_base_payment_detail_id,
        amountMinor: refundMinor,
        currency: "USC",
        narration: `Auto-refund failed payout ${job.unique_reference}`,
        paymentType: "stablecoin-transfer",
        uniqueReference: ref,
      });
      break;
    } catch (err) {
      if (err instanceof nuvion.NuvionError && err.status === 409 && err.type === "error_duplicate_resource") {
        const recovered = await nuvion.recoverTransferByReference(ref, entity.entity_id).catch(() => null);
        if (recovered) {
          refundTransfer = recovered;
          break;
        }
      }
      if (attempt === 0 && err instanceof nuvion.NuvionError && err.type === "error_transfer_insufficient_funds") {
        const feeBuf = Math.max(50, Math.ceil(refundMinor * 0.015));
        if (refundMinor - feeBuf > 0) {
          refundMinor -= feeBuf;
          continue;
        }
      }
      db.updateNuvionJob(job.id, {
        state: "refund_pending",
        retry_count: (job.retry_count || 0) + 1,
        error_message: err.message,
      });
      throw err;
    }
  }

  const refundedUsd = nuvion.fromNuvionMinor(refundMinor);
  db.updateNuvionJob(job.id, {
    state: "refunded",
    payload_json: {
      ...(job.payload || {}),
      refundTransferId: refundTransfer.id,
      refundedUsd,
      failureReason: confirmed.failure_reason || confirmed.status || "failed",
    },
  });

  // Notify user immediately that their balance was returned!
  const telegram = getBotTelegram(bot);
  if (telegram && job.telegram_id) {
    const p = job.payload || {};
    const fiatDisplay = corridors.formatCurrencyMajor(p.targetCurrency || job.currency, p.targetAmountMajor || nuvion.fromNuvionMinor(job.amount_minor));
    await telegram.sendMessage(
      job.telegram_id,
      `↩️ <b>Transfer Refunded to Your Balance</b>\n` +
      `──────────────────────────\n` +
      `Your transfer of <b>${fiatDisplay}</b> to <b>${escapeHtml(p.recipientName || "recipient")}</b> could not be completed by the receiving bank.\n\n` +
      `💰 <b>Refunded:</b> $${refundedUsd.toFixed(2)} has been sent right back to your main Proxim balance.\n` +
      `🔖 <b>Reference:</b> <code>${escapeHtml(refundTransfer.id)}</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }

  // Trigger silent background sweep Base -> Arc strictly for this accountType (non-test only)
  if (process.env.NODE_ENV !== "test") {
    setTimeout(() => {
      try {
        const evmDepositSweeper = require("./evm_deposit_sweeper");
        evmDepositSweeper.sweepUserDeposits(entity.telegram_id, null, {
          silent: true,
          onlyChain: "BASE",
          onlyAccountType: entity.account_type || "personal",
        }).catch(() => {});
      } catch (_) {}
    }, 15000);
  }

  return { refunded: true, jobId: job.id, refundTransferId: refundTransfer.id, refundedUsd };
}

// ── 7. Business Multi-Currency Global CSV Payroll ────────────────────────────

/**
 * Parse a multi-currency CSV file and quote every row live on Nuvion with the 1% FX margin.
 */
async function parseAndQuoteGlobalPayroll({ telegramId, csvText, accountType = "business" }) {
  const { rows, errors } = corridors.parseMultiCurrencyCsv(csvText);
  if (rows.length === 0) {
    throw new Error(errors.length > 0 ? errors.join("\n") : "No valid payroll rows found in CSV.");
  }

  const quotedRows = [];
  let totalNuvionCostUsd = 0;
  let totalMarginUsd = 0;
  let totalUserUsd = 0;

  for (const row of rows) {
    const q = await quoteGlobalPayout({
      telegramId,
      accountType,
      railKey: row.railKey,
      targetCurrency: row.currency,
      targetAmountMajor: row.amount,
    });
    totalNuvionCostUsd = round2(totalNuvionCostUsd + q.nuvionCostUsd);
    totalMarginUsd = round2(totalMarginUsd + q.marginUsd);
    totalUserUsd = round2(totalUserUsd + q.userTotalUsd);
    quotedRows.push({
      ...row,
      quote: q,
    });
  }

  const batchId = `gpay_${crypto.createHash("sha256").update(String(csvText).trim()).digest("hex").slice(0, 12)}`;

  return {
    batchId,
    rows: quotedRows,
    parseErrors: errors,
    totalNuvionCostUsd,
    totalMarginUsd,
    totalUserUsd,
  };
}

/**
 * Execute a quoted Business Multi-Currency Global Payroll batch:
 *  - Deterministic payroll idempotency per row (`idempotency.js`) so re-uploads never double-pay!
 *  - Registers/reuses each staff recipient on Nuvion
 *  - Funds ONE consolidated Base/Gateway/Arc deposit into the Business entity's Nuvion USC Base address
 *  - Queues all row jobs under `payrollBatchId` so when `inflows.completed` lands, ALL rows dispatch automatically!
 */
async function executeGlobalPayrollBatch({
  telegramId,
  pin,
  payrollPlan,
  accountType = "business",
  bot = null,
  fundingExecutor = null,
}) {
  const user = db.getUser(telegramId);
  if (!user) throw new Error("User account not found.");
  if (!db.verifyPin(telegramId, pin)) throw new Error("Incorrect PIN.");

  const entity = await ensureApprovedBridgeEntity(telegramId, accountType);
  const { batchId, rows } = payrollPlan;

  // Filter out rows already paid in this batch (idempotency protection!)
  const payableRows = [];
  const skippedRows = [];
  for (const row of rows) {
    const destId = row.details.account_number || row.details.iban || row.details.phone_number || row.details.email || row.name;
    const idemKey = idempotency.generateIdempotencyKey(batchId, row.rowIndex, {
      to: `${row.name}:${destId}`,
      account_number: destId,
      amount: row.amount,
      currency: row.currency,
    });
    const prev = idempotency.checkIdempotency(idemKey);
    if (prev && (prev.status === "completed" || prev.status === "pending")) {
      skippedRows.push({ rowIndex: row.rowIndex, name: row.name, reason: "already_processed" });
      continue;
    }
    payableRows.push({ ...row, idemKey });
  }

  if (payableRows.length === 0) {
    return { batchId, queuedCount: 0, skippedCount: skippedRows.length, jobs: [] };
  }

  const batchNuvionCostUsd = round2(payableRows.reduce((s, r) => s + r.quote.nuvionCostUsd, 0));
  const batchMarginUsd = round2(payableRows.reduce((s, r) => s + r.quote.marginUsd, 0));

  // Enforce Anti-Fraud Velocity Tripwires, Tier Daily Limits & Global Circuit Breaker on Payroll Batch (Finding 5)
  await fraudGuard.assertOutboundAllowed({
    telegramId,
    accountType,
    action: "nuvion_batch_payroll",
    amountUsd: round2(batchNuvionCostUsd + batchMarginUsd),
    reference: batchId,
    bot,
  });

  // Register/reuse recipients first so we never fund if a recipient payload is invalid
  const prepared = [];
  for (const row of payableRows) {
    const reg = await ensurePayoutRecipient(entity.entity_id, row.rail, row.details);
    prepared.push({ ...row, counterpartyId: reg.counterpartyId, paymentDetailId: reg.paymentDetailId });
  }

  // Create durable payroll jobs & pending idempotency locks BEFORE broadcasting funds
  // so <500ms Gateway settlement can NEVER arrive before the batch jobs exist!
  const jobs = [];
  for (const item of prepared) {
    const uniqueReference = `prx-gpay-${batchId.slice(-6)}-${item.rowIndex}-${crypto.randomBytes(2).toString("hex")}`;
    idempotency.startIdempotency(item.idemKey, {
      batchId,
      rowIndex: item.rowIndex,
      recipient: item.name,
      amount: item.amount,
      currency: item.currency,
      method: item.railKey,
    });

    const job = db.createNuvionJob({
      entityId: entity.entity_id,
      telegramId,
      accountType,
      jobType: "outbound_fiat_payout",
      state: "funding_in_transit",
      currency: item.currency,
      amountMinor: item.quote.targetAmountMinor,
      marginMinor: item.quote.marginMinor,
      uniqueReference,
      sourceTxHash: null,
      fxQuoteId: item.quote.nuvionQuoteId,
      payload: {
        payrollBatchId: batchId,
        payrollRowIndex: item.rowIndex,
        idemKey: item.idemKey,
        railKey: item.railKey,
        paymentMethod: item.rail.paymentMethod,
        railLabel: item.rail.label,
        targetCurrency: item.currency,
        targetAmountMajor: item.amount,
        targetAmountMinor: item.quote.targetAmountMinor,
        expectedUscMinor: item.quote.nuvionCostMinor,
        userTotalUsd: item.quote.userTotalUsd,
        effectiveRate: item.quote.effectiveRate,
        counterpartyId: item.counterpartyId,
        paymentDetailId: item.paymentDetailId,
        recipientName: item.name,
        narration: item.narration,
        fundingRoute: null,
        fundingTxHash: null,
      },
    });
    jobs.push({ job, item, uniqueReference });
  }

  // Single consolidated funding transfer to Business entity's Nuvion Base USC address
  let funding;
  try {
    funding = await fundNuvionBaseBridge({
      user,
      pin,
      accountType,
      nuvionBaseAddress: entity.usc_base_address,
      nuvionCostUsd: batchNuvionCostUsd,
      marginUsd: batchMarginUsd,
      bot,
      fundingExecutor,
    });
  } catch (fundErr) {
    for (const entry of jobs) {
      db.updateNuvionJob(entry.job.id, { state: "failed", error_message: fundErr.message });
      idempotency.failIdempotency(entry.item.idemKey, fundErr.message);
    }
    throw fundErr;
  }

  const finalJobs = [];
  for (const entry of jobs) {
    const updated = db.updateNuvionJob(entry.job.id, {
      source_tx_hash: funding.txHash || null,
      payload_json: {
        ...(entry.job.payload || {}),
        fundingRoute: funding.route,
        fundingTxHash: funding.txHash || null,
      },
    });
    idempotency.completeIdempotency(entry.item.idemKey, {
      txHash: funding.txHash || entry.uniqueReference,
      reference: entry.uniqueReference,
    });
    finalJobs.push(updated);
  }

  return {
    batchId,
    queuedCount: finalJobs.length,
    skippedCount: skippedRows.length,
    totalNuvionCostUsd: batchNuvionCostUsd,
    totalMarginUsd: batchMarginUsd,
    totalUserUsd: round2(batchNuvionCostUsd + batchMarginUsd),
    funding,
    jobs: finalJobs,
  };
}

// ── 8. Register Phase 3 Webhook Hooks (Idempotent) ───────────────────────────

function registerPayoutHooks() {
  if (_payoutHooksRegistered) return;
  _payoutHooksRegistered = true;

  nuvionWebhooks.onNuvionEvent("inflows.completed", async ({ confirmed, entityRecord, bot }) => {
    if (!entityRecord) return;
    if (String(confirmed?.currency || "").toUpperCase() !== "USC") return;
    await handleUscInflowForPendingPayout({ confirmed, entityRecord, bot });
  });

  nuvionWebhooks.onNuvionEvent("outflows.completed", async ({ confirmed, entityRecord, bot }) => {
    await handleOutboundPayoutCompleted({ confirmed, entityRecord, bot });
  });

  nuvionWebhooks.onNuvionEvent("outflows.failed", async ({ confirmed, entityRecord, bot }) => {
    await handleOutboundPayoutFailed({ confirmed, entityRecord, bot });
  });

  nuvionWebhooks.onNuvionEvent("outflows.cancelled", async ({ confirmed, entityRecord, bot }) => {
    await handleOutboundPayoutFailed({ confirmed, entityRecord, bot });
  });
}

module.exports = {
  BASE_USDC_EIP3009_DOMAIN,
  TRANSFER_WITH_AUTH_TYPES,
  signBaseUsdcTransferAuthorization,
  sendDirectBaseUsdc,
  getUserPrivateKey,
  selectBestMatchingUscCandidate,
  shouldUseNuvionForNgnPayout,
  ensureApprovedBridgeEntity,
  quoteGlobalPayout,
  ensurePayoutRecipient,
  fundNuvionBaseBridge,
  initiateGlobalPayout,
  handleUscInflowForPendingPayout,
  handleOutboundPayoutCompleted,
  handleOutboundPayoutFailed,
  parseAndQuoteGlobalPayroll,
  executeGlobalPayrollBatch,
  registerPayoutHooks,
};
