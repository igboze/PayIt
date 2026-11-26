import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { toUserError } from "../utils/errors";
import type {
  AppNotification,
  AccountSummary,
  AccountType,
  ActionConfirmResponse,
  ActionIntentResponse,
  AssistantResponse,
  AuthSession,
  BankItem,
  BankRatesResponse,
  BillHistoryItem,
  BusinessExpenseItem,
  BusinessHomeResponse,
  CardItem,
  ContactItem,
  CryptoDepositIntentResponse,
  CryptoDepositTokensResponse,
  DeviceItem,
  GiftItem,
  GlobalAccountItem,
  GlobalCorridor,
  GlobalRail,
  GlobalRecipient,
  InvoiceItem,
  InvoicePaymentOptionsResponse,
  KycStatusResponse,
  NgnDepositOrder,
  PaymentLinkItem,
  ProximUser,
  ResolvedBankAccount,
  RewardsOverview,
  SavingsOverview,
  ScheduleItem,
  StockDetailResponse,
  StocksOverviewResponse,
  SwapPairRate,
  SwitchAccountResponse,
  TransactionItem,
  UnifiedBalance,
  WithdrawalChain,
} from "./types";

const KEY_DEVICE_ID = "proxim_device_id_v1";
const KEY_ACCESS_TOKEN = "proxim_access_token_v1";
const KEY_REFRESH_TOKEN = "proxim_refresh_token_v1";

export const API_BASE_URL: string = (
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  "https://payit-production.up.railway.app/api/app/v1"
).replace(/\/+$/, "");

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(toUserError(message));
    this.status = status;
    this.code = code;
  }
}

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _deviceId: string | null = null;
let _activeAccount: AccountType = "personal";
let _refreshInFlight: Promise<boolean> | null = null;
let _onSessionInvalid: ((reason: string) => void) | null = null;

function bytesToBase64Url(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += chars[(triplet >> 18) & 63];
    out += chars[(triplet >> 12) & 63];
    if (i + 1 < bytes.length) out += chars[(triplet >> 6) & 63];
    if (i + 2 < bytes.length) out += chars[triplet & 63];
  }
  return out;
}

export function setActiveAccountHeader(account: AccountType): void {
  _activeAccount = account;
}

export function getActiveAccountHeader(): AccountType {
  return _activeAccount;
}

export function onSessionInvalid(cb: (reason: string) => void): void {
  _onSessionInvalid = cb;
}

export async function getDeviceInfo(): Promise<{
  deviceId: string;
  platform: "android" | "ios";
  deviceName: string;
}> {
  if (!_deviceId) {
    const stored = await SecureStore.getItemAsync(KEY_DEVICE_ID);
    if (stored && /^[A-Za-z0-9_-]{16,128}$/.test(stored)) {
      _deviceId = stored;
    } else {
      const rand = Crypto.getRandomBytes(24);
      _deviceId = `px_${bytesToBase64Url(rand)}`;
      await SecureStore.setItemAsync(KEY_DEVICE_ID, _deviceId);
    }
  }
  const platform: "android" | "ios" = Platform.OS === "ios" ? "ios" : "android";
  const deviceName = platform === "ios" ? `iOS ${Platform.Version}` : `Android ${Platform.Version}`;
  return { deviceId: _deviceId, platform, deviceName };
}

export async function loadStoredTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const [a, r] = await Promise.all([
    SecureStore.getItemAsync(KEY_ACCESS_TOKEN),
    SecureStore.getItemAsync(KEY_REFRESH_TOKEN),
  ]);
  _accessToken = a || null;
  _refreshToken = r || null;
  return { accessToken: _accessToken, refreshToken: _refreshToken };
}

export async function saveSessionTokens(session: AuthSession): Promise<void> {
  _accessToken = session.accessToken;
  _refreshToken = session.refreshToken;
  await Promise.all([
    SecureStore.setItemAsync(KEY_ACCESS_TOKEN, session.accessToken),
    SecureStore.setItemAsync(KEY_REFRESH_TOKEN, session.refreshToken),
  ]);
}

export async function clearSessionTokens(): Promise<void> {
  _accessToken = null;
  _refreshToken = null;
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_ACCESS_TOKEN).catch(() => {}),
    SecureStore.deleteItemAsync(KEY_REFRESH_TOKEN).catch(() => {}),
  ]);
}

export function getAccessToken(): string | null {
  return _accessToken;
}

async function refreshSessionTokens(): Promise<boolean> {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      if (!_refreshToken) return false;
      const { deviceId } = await getDeviceInfo();
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken: _refreshToken, deviceId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.session?.accessToken) {
        const code = json?.error?.code || "unauthorized";
        await clearSessionTokens();
        if (_onSessionInvalid) {
          _onSessionInvalid(toUserError(json?.error?.message, "Session expired. Please sign in again."));
        }
        if (code === "account_frozen" || code === "session_revoked") return false;
        return false;
      }
      await saveSessionTokens(json.session as AuthSession);
      return true;
    } catch {
      return false;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
  auth?: boolean;
  account?: AccountType | null;
  rawText?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true, account, rawText = false } = opts;

  const exec = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: rawText ? "text/csv, text/plain" : "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && _accessToken) {
      headers.Authorization = `Bearer ${_accessToken}`;
      const acct = account === undefined ? _activeAccount : account;
      if (acct) headers["X-Proxim-Account"] = acct;
    }
    return fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res: Response;
  try {
    res = await exec();
  } catch (netErr) {
    throw new ApiError(0, "network_error", toUserError(netErr, "Couldn't connect to Proxim. Check your internet connection and try again."));
  }
  if (res.status === 401 && auth && _refreshToken) {
    const refreshed = await refreshSessionTokens();
    if (refreshed) {
      try {
        res = await exec();
      } catch (netErr) {
        throw new ApiError(0, "network_error", toUserError(netErr, "Couldn't connect to Proxim. Check your internet connection and try again."));
      }
    }
  }

  if (rawText) {
    const text = await res.text();
    if (!res.ok) {
      let parsed: { error?: { code?: string; message?: string } } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      throw new ApiError(
        res.status,
        parsed?.error?.code || "request_failed",
        toUserError(parsed?.error?.message, res.status >= 500 ? "Proxim is temporarily busy. Please try again in a moment." : "Something went wrong. Please try again.")
      );
    }
    return text as unknown as T;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code || "request_failed";
    const msg = toUserError(
      data?.error?.message,
      res.status >= 500 ? "Proxim is temporarily busy. Please try again in a moment." : "Something went wrong. Please try again."
    );
    if (res.status === 403 && code === "account_frozen") {
      await clearSessionTokens();
      if (_onSessionInvalid) _onSessionInvalid(msg);
    }
    throw new ApiError(res.status, code, msg);
  }
  return data as T;
}

// ─── Typed Endpoint Methods ───────────────────────────────────────────────────

export const api = {
  // Every chain and token NEAR Intents can deliver to.
  listWithdrawalTokens() {
    return request<{
      feeUsd: number;
      chains: Array<{ key: string; name: string; short: string; isEvm: boolean; priority: number; logoUrl: string | null; tokenCount: number }>;
      tokensByChain: Record<string, Array<{ symbol: string; name: string; assetId: string; decimals: number; blockchain: string; priceUsd: number | null; logoUrl: string | null }>>;
    }>("/withdrawals/tokens");
  },
  // Profile photo.
  uploadAvatar(imageBase64: string) {
    return request<{ success: boolean; avatarVersion: string | null }>("/me/avatar", { method: "POST", body: { imageBase64 } });
  },
  deleteAvatar() {
    return request<{ success: boolean }>("/me/avatar", { method: "DELETE" });
  },
  getAvatarUrl(version: string) {
    return `${API_BASE_URL}/me/avatar?v=${encodeURIComponent(version)}`;
  },
  // In-app notification inbox.
  listNotifications(afterId?: number) {
    const qs = afterId ? `?after=${afterId}` : "";
    return request<{ unread: number; notifications: AppNotification[] }>(`/notifications${qs}`);
  },
  markNotificationsRead(ids?: number[]) {
    return request<{ success: boolean }>("/notifications/read", { method: "POST", body: ids ? { ids } : {} });
  },
  // Push notifications: the device token FCM gives this install.
  async registerPush(pushToken: string) {
    return request<{ success: boolean }>("/push/register", { method: "POST", body: { pushToken } });
  },
  // Auth
  async signupStart(phoneOrEmail: string, channel?: "email" | "phone") {
    const dev = await getDeviceInfo();
    const trimmed = phoneOrEmail.trim();
    const isEmail = channel === "email" || (!channel && trimmed.includes("@"));
    return request<{ signupId: string; channel?: "email" | "phone"; otpExpiresInSec: number }>("/auth/signup/start", {
      method: "POST",
      auth: false,
      body: isEmail ? { ...dev, email: trimmed.toLowerCase() } : { ...dev, phone: trimmed },
    });
  },
  async signupVerifyOtp(signupId: string, code: string) {
    return request<{ challengeId: string; options: Record<string, unknown> }>("/auth/signup/verify-otp", {
      method: "POST",
      auth: false,
      body: { signupId, code },
    });
  },
  async signupFinish(params: {
    signupId: string;
    challengeId: string;
    pin: string;
    acceptTerms: boolean;
    response: Record<string, unknown>;
  }) {
    const dev = await getDeviceInfo();
    return request<{ user: ProximUser; session: AuthSession }>("/auth/signup/finish", {
      method: "POST",
      auth: false,
      body: { ...params, deviceName: dev.deviceName },
    });
  },
  async linkStart(code: string) {
    const dev = await getDeviceInfo();
    return request<{ challengeId: string; options: Record<string, unknown> }>("/auth/link/start", {
      method: "POST",
      auth: false,
      body: { ...dev, code },
    });
  },
  async linkFinish(params: {
    code: string;
    challengeId: string;
    pin: string;
    response: Record<string, unknown>;
  }) {
    const dev = await getDeviceInfo();
    return request<{ user: ProximUser; session: AuthSession }>("/auth/link/finish", {
      method: "POST",
      auth: false,
      body: { ...dev, ...params },
    });
  },
  async loginStart() {
    const dev = await getDeviceInfo();
    return request<{ challengeId: string; options: Record<string, unknown> }>("/auth/login/start", {
      method: "POST",
      auth: false,
      body: dev,
    });
  },
  async loginFinish(challengeId: string, response: Record<string, unknown>) {
    const dev = await getDeviceInfo();
    return request<{ user: ProximUser; session: AuthSession }>("/auth/login/finish", {
      method: "POST",
      auth: false,
      body: { ...dev, challengeId, response },
    });
  },
  logout() {
    return request<{ success: boolean }>("/auth/logout", { method: "POST" });
  },

  // Profile, accounts, balances, transactions
  me() {
    return request<{ user: ProximUser }>("/me");
  },
  updateProfile(body: {
    senderName?: string;
    bizSenderName?: string;
    username?: string;
    autoEarnEnabled?: boolean;
    accountType?: AccountType;
  }) {
    return request<{ user: ProximUser }>("/me", { method: "PATCH", body });
  },
  listAccounts() {
    return request<{ activeContext: AccountType; hasBusinessAccount: boolean; accounts: AccountSummary[] }>(
      "/accounts"
    );
  },
  switchAccount(accountType: AccountType) {
    return request<SwitchAccountResponse>("/accounts/switch", {
      method: "POST",
      body: { accountType },
    });
  },
  getBalances(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<UnifiedBalance>(`/balances${qs}`, { account });
  },
  getTransactions(limit = 30, account?: AccountType | "all") {
    const qs = `?limit=${limit}${account ? `&account=${encodeURIComponent(account)}` : ""}`;
    return request<{ accountType: string; transactions: TransactionItem[] }>(`/transactions${qs}`);
  },
  exportStatementCsv(limit = 500, account?: AccountType | "all") {
    const qs = `?limit=${limit}${account ? `&account=${encodeURIComponent(account)}` : ""}`;
    return request<string>(`/transactions/statement.csv${qs}`, { rawText: true });
  },
  /** Short-lived signed link that opens the receipt without the auth header. */
  async getReceiptLink(txId: number) {
    const res = await request<{ path: string; expiresInSec: number }>(`/transactions/${txId}/receipt-link`, { method: "POST", body: {} });
    return `${API_BASE_URL}${res.path}`;
  },
  getReceiptUrl(txId: number) {
    return `${API_BASE_URL}/transactions/${txId}/receipt`;
  },

  // Passkey + PIN actions
  actionIntent(actionType: string, body: Record<string, unknown>) {
    return request<ActionIntentResponse>(`/actions/${encodeURIComponent(actionType)}/intent`, {
      method: "POST",
      body,
    });
  },
  actionConfirm(body: {
    challengeId: string;
    response: Record<string, unknown>;
    pin?: string;
    newPin?: string;
  }) {
    return request<ActionConfirmResponse>("/actions/confirm", {
      method: "POST",
      body,
    });
  },

  // Devices
  listDevices() {
    return request<{ devices: DeviceItem[] }>("/devices");
  },
  deviceRevokeIntent(deviceId: string) {
    return request<{ challengeId: string; options: Record<string, unknown> }>(
      `/devices/${encodeURIComponent(deviceId)}/revoke/intent`,
      { method: "POST" }
    );
  },
  deviceRevoke(deviceId: string, challengeId: string, response: Record<string, unknown>) {
    return request<{ success: boolean }>(`/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
      body: { challengeId, response },
    });
  },

  // Contacts & User Lookup
  listContacts(q?: string) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return request<{ contacts: ContactItem[] }>(`/contacts${qs}`);
  },
  upsertContact(body: Partial<ContactItem> & { name: string }) {
    return request<{ contact: ContactItem }>("/contacts", { method: "POST", body });
  },
  deleteContact(name: string) {
    return request<{ success: boolean }>(`/contacts/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  lookupUser(q: string) {
    return request<{ user: { id: string; username: string | null; displayName: string; isSelf: boolean } }>(
      `/users/lookup?q=${encodeURIComponent(q)}`
    );
  },

  // Banks & Naira
  listBanks(q?: string, country = "NG") {
    const qs = `?country=${encodeURIComponent(country)}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    return request<{ country: string; source: string; banks: BankItem[] }>(`/banks${qs}`);
  },
  getBankRates() {
    return request<BankRatesResponse>("/banks/rates");
  },
  resolveBankAccount(bankCode: string, accountNumber: string, bankName?: string) {
    return request<ResolvedBankAccount>("/banks/resolve", {
      method: "POST",
      body: { bankCode, accountNumber, bankName },
    });
  },

  // Deposits (Naira, Card/Apple Pay, Crypto)
  createNgnDeposit(amountNgn: number, accountType?: AccountType) {
    return request<NgnDepositOrder>("/deposits/ngn", {
      method: "POST",
      body: { amountNgn, ...(accountType ? { accountType } : {}) },
    });
  },
  getNgnDepositStatus(orderId: string) {
    return request<{ orderId: string; accountType: AccountType; status: string; order: Record<string, unknown> }>(
      `/deposits/ngn/${encodeURIComponent(orderId)}`
    );
  },
  getCardDepositLink(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<{ accountType: AccountType; url?: string; link?: string; [k: string]: unknown }>(
      `/deposits/card${qs}`
    );
  },
  listCryptoDepositTokens(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<CryptoDepositTokensResponse>(`/deposits/crypto/tokens${qs}`);
  },
  createCryptoDepositIntent(body: {
    chain: string;
    symbol: string;
    assetId?: string;
    amount: number;
    refundTo?: string;
    accountType?: AccountType;
  }) {
    return request<CryptoDepositIntentResponse>("/deposits/crypto/intent", {
      method: "POST",
      body,
    });
  },
  getCryptoDepositStatus(depositId: number) {
    return request<{ deposit: Record<string, unknown>; liveStatus: Record<string, unknown> | null }>(
      `/deposits/crypto/${depositId}`
    );
  },
  sweepCryptoDeposits(accountType?: AccountType) {
    return request<{ swept: unknown[] }>("/deposits/crypto/sweep", {
      method: "POST",
      body: accountType ? { accountType } : {},
    });
  },

  // Cross-chain withdrawals, bridge & swap
  listWithdrawalChains() {
    return request<{ feeUsd: number; chains: WithdrawalChain[] }>("/withdrawals/chains");
  },
  listBridgeMoves() {
    return request<{ arcToSolana: Array<Record<string, unknown>>; solanaToArc: Array<Record<string, unknown>> }>(
      "/bridge/moves"
    );
  },
  getSwapRates() {
    return request<{ pair?: SwapPairRate | null; rates: Record<string, unknown> }>("/swap/rates");
  },
  quoteSwap(tokenIn: "USDC" | "EURC", tokenOut: "USDC" | "EURC", amountIn: number) {
    return request<{ quote: Record<string, unknown> }>("/swap/quote", {
      method: "POST",
      body: { tokenIn, tokenOut, amountIn },
    });
  },

  // Gifts
  listPendingGifts() {
    return request<{ gifts: GiftItem[] }>("/gifts");
  },
  claimGift(claimToken: string) {
    return request<{ success: boolean; txHash: string | null; escrow: Record<string, unknown> }>("/gifts/claim", {
      method: "POST",
      body: { claimToken },
    });
  },

  // Global Neobank
  listGlobalAccounts(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<{
      accountType: AccountType;
      kycStatus: string;
      supportedCurrencies: string[];
      accounts: GlobalAccountItem[];
    }>(`/global/accounts${qs}`);
  },
  provisionGlobalAccount(currency: string, accountType?: AccountType) {
    return request<{ accountType: AccountType; account: GlobalAccountItem; isPending: boolean; cached: boolean }>(
      `/global/accounts/${encodeURIComponent(currency)}`,
      { method: "POST", body: accountType ? { accountType } : {} }
    );
  },
  listGlobalCorridors() {
    return request<{
      currencies: string[];
      receivingCurrencies: string[];
      corridors?: GlobalCorridor[];
      rails: GlobalRail[];
    }>("/global/corridors");
  },
  getGlobalBankCodes(currency: string, q?: string) {
    const params = new URLSearchParams({ currency: currency.toUpperCase() });
    if (q) params.set("q", q);
    return request<{
      currency: string;
      banks: Array<{
        code: string;
        name: string;
        swiftBic: string | null;
        institutionNumber: string | null;
      }>;
    }>(`/global/bank-codes?${params.toString()}`);
  },
  listGlobalRecipients(currency?: string, account?: AccountType) {
    const params = new URLSearchParams();
    if (currency) params.set("currency", currency);
    if (account) params.set("account", account);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<{ recipients: GlobalRecipient[] }>(`/global/recipients${qs}`);
  },
  createGlobalPaymentLink(body: {
    currency: string;
    amount: number;
    fundingType: "open-banking" | "interac" | "momo";
    payerName?: string;
    payerEmail?: string;
    msisdn?: string;
    momoChannel?: string;
    narration?: string;
    accountType?: AccountType;
  }) {
    return request<{ sessionId: string | null; paymentUrl: string | null; status: string }>("/global/payment-links", {
      method: "POST",
      body,
    });
  },

  // Cards
  listCards(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<{ accountType: AccountType; cards: CardItem[] }>(`/cards${qs}`);
  },
  listCardTransactions(cardId: string, limit = 20) {
    return request<{ accountType: AccountType; cardId: string; transactions: Array<Record<string, unknown>> }>(
      `/cards/${encodeURIComponent(cardId)}/transactions?limit=${limit}`
    );
  },

  // Bills
  listBillProviders(category?: string, extra?: { networkId?: string; provider?: string }) {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (extra?.networkId) params.set("networkId", extra.networkId);
    if (extra?.provider) params.set("provider", extra.provider);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<{ categories?: unknown[]; networks?: unknown[]; providers?: unknown[] }>(`/bills/providers${qs}`);
  },
  validateBillMeter(meterNo: string, electId: string) {
    return request<{ valid: boolean; details: Record<string, unknown> }>("/bills/validate-meter", {
      method: "POST",
      body: { meterNo, electId },
    });
  },
  listBillHistory(limit = 20) {
    return request<{ bills: BillHistoryItem[] }>(`/bills/history?limit=${limit}`);
  },

  // Schedules
  listSchedules() {
    return request<{ schedules: ScheduleItem[] }>("/schedules");
  },
  updateScheduleStatus(id: number, action: "pause" | "resume" | "cancel") {
    return request<{ success: boolean; schedule: ScheduleItem }>(`/schedules/${id}/${action}`, { method: "POST" });
  },

  // Rewards, KYC/KYB, Savings
  getRewards(limit = 20) {
    return request<RewardsOverview>(`/rewards?limit=${limit}`);
  },
  getKycStatus() {
    return request<KycStatusResponse>("/kyc/status");
  },
  refreshKycStatus(accountType?: AccountType) {
    return request<KycStatusResponse>("/kyc/refresh", {
      method: "POST",
      body: accountType ? { accountType } : {},
    });
  },
  createKycUploadSession(slot: string, label?: string) {
    return request<{ sessionId: string; slot: string; uploadUrl: string; expiresInSec: number }>("/kyc/upload-session", {
      method: "POST",
      body: { slot, ...(label ? { label } : {}) },
    });
  },
  getKycUploadSession(sessionId: string) {
    return request<{
      ready: boolean;
      slot: string;
      documentId: string | null;
      name: string | null;
      mimeType: string | null;
    }>(`/kyc/upload-session/${encodeURIComponent(sessionId)}`);
  },
  listKycUploadSessions() {
    return request<{
      documents: Array<{
        slot: string;
        documentId: string;
        name: string;
        mimeType: string;
      }>;
    }>("/kyc/upload-sessions");
  },
  submitKyc(body: Record<string, unknown>) {
    return request<{ status: string; tier: number }>("/kyc/submit", { method: "POST", body });
  },
  submitKyb(body: Record<string, unknown>) {
    return request<{ status: string; tier: number }>("/kyb/submit", { method: "POST", body });
  },
  getSavings(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<SavingsOverview>(`/savings${qs}`);
  },

  // Tokenized US Stocks (Pods Finance / Ondo Global Markets)
  getStocks(q?: string, account?: AccountType) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (account) params.set("account", account);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<StocksOverviewResponse>(`/stocks${qs}`);
  },
  getStockChart(ticker: string, range: "1D" | "1W" | "1M" | "3M" | "1Y" = "1M", account?: AccountType) {
    const params = new URLSearchParams({ range });
    if (account) params.set("account", account);
    return request<StockDetailResponse>(`/stocks/${encodeURIComponent(ticker)}/chart?${params.toString()}`);
  },

  // Invoice payment options & PNG downloads
  getInvoicePaymentOptions(account?: AccountType) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : "";
    return request<InvoicePaymentOptionsResponse>(`/invoices/options${qs}`);
  },
  getInvoiceDownloadUrl(id: number, scope: "personal" | "business" = "personal") {
    const base = scope === "business" ? `/business/invoices/${id}/download` : `/invoices/${id}/download`;
    return `${API_BASE_URL}${base}`;
  },
  async getInvoiceDownloadLink(id: number, scope: "personal" | "business" = "personal") {
    const path = scope === "business" ? `/business/invoices/${id}/download-link` : `/invoices/${id}/download-link`;
    const r = await request<{ path: string; expiresInSec: number }>(path, { method: "POST", body: {} });
    return `${API_BASE_URL}${r.path}`;
  },

  // Personal & Business Invoices, Expenses, Payment Links
  listPersonalInvoices(limit = 20) {
    return request<{ invoices: InvoiceItem[] }>(`/invoices?limit=${limit}`);
  },
  createPersonalInvoice(body: Record<string, unknown>) {
    return request<{ invoice: InvoiceItem; paymentDetails: Record<string, unknown> }>("/invoices", {
      method: "POST",
      body,
    });
  },
  markPersonalInvoicePaid(id: number) {
    return request<{ success: boolean; invoice: InvoiceItem }>(`/invoices/${id}/mark-paid`, { method: "POST" });
  },

  getBusinessHome() {
    return request<BusinessHomeResponse>("/business/home");
  },
  updateBusinessProfile(body: Record<string, unknown>) {
    return request<{ profile: BusinessHomeResponse["profile"] }>("/business/profile", {
      method: "PATCH",
      body,
    });
  },
  uploadBusinessLogo(imageBase64: string) {
    return request<{ ok: boolean; logoDataUri: string | null }>("/business/profile/logo", {
      method: "POST",
      body: { imageBase64 },
    });
  },
  listBusinessInvoices(limit = 20) {
    return request<{ invoices: InvoiceItem[] }>(`/business/invoices?limit=${limit}`);
  },
  createBusinessInvoice(body: Record<string, unknown>) {
    return request<{ invoice: InvoiceItem; paymentDetails: Record<string, unknown> }>("/business/invoices", {
      method: "POST",
      body,
    });
  },
  markBusinessInvoicePaid(id: number) {
    return request<{ success: boolean; invoice: InvoiceItem }>(`/business/invoices/${id}/mark-paid`, {
      method: "POST",
    });
  },
  listBusinessExpenses(limit = 30) {
    return request<{ expenses: BusinessExpenseItem[] }>(`/business/expenses?limit=${limit}`);
  },
  logBusinessExpense(body: { amount: number; currency?: string; description: string }) {
    return request<{ expense: BusinessExpenseItem }>("/business/expenses", { method: "POST", body });
  },
  setBusinessSavingsGoal(percentage: number, label?: string) {
    return request<{ savingsGoal: { percentage: number; label: string } }>("/business/savings-goal", {
      method: "PUT",
      body: { percentage, label },
    });
  },
  listBusinessPaymentLinks() {
    return request<{ paymentLinks: PaymentLinkItem[] }>("/business/payment-links");
  },
  createBusinessPaymentLink(body: {
    title: string;
    description?: string;
    amount?: number;
    currency?: string;
    slug?: string;
  }) {
    return request<{ paymentLink: PaymentLinkItem }>("/business/payment-links", { method: "POST", body });
  },
  deactivateBusinessPaymentLink(linkId: string) {
    return request<{ success: boolean }>(`/business/payment-links/${encodeURIComponent(linkId)}`, {
      method: "DELETE",
    });
  },

  // Assistant
  assistantChat(message: string, accountType?: AccountType) {
    return request<AssistantResponse>("/assistant", {
      method: "POST",
      body: { message, ...(accountType ? { accountType } : {}) },
    });
  },
};
