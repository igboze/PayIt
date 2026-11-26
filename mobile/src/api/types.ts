// Strict API contracts matching src/app_api/routes.js, features.js, and actions.js

export type AccountType = "personal" | "business";

export interface NgnReceivingAccount {
  bankName: string | null;
  accountNumber: string;
  beneficiaryName: string | null;
  status: string;
}

export interface ProximUser {
  id: string;
  username: string | null;
  senderName: string | null;
  savedSenderName: string | null;
  bizSenderName: string | null;
  phone: string | null;
  telegramLinked: boolean;
  kycTier: number;
  personalKycTier: number;
  businessKycTier: number;
  depositAddress: string | null;
  activeDepositAddress: string | null;
  ngnAccount?: NgnReceivingAccount | null;
  hasBusinessAccount: boolean;
  businessDepositAddress: string | null;
  activeContext: AccountType;
  autoEarnEnabled: boolean;
  referralCode: string;
  /** Changes when the profile photo changes; null when there is none. */
  avatarVersion?: string | null;
  deviceRestrictedUntil: string | null;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UnifiedBalance {
  accountType?: AccountType;
  depositAddress?: string | null;
  ngnAccount?: NgnReceivingAccount | null;
  totalUsdc: number;
  totalNgn?: number | null;
  usdToNgnRate?: number | null;
  arc?: { usdc?: number; eurc?: number; [k: string]: unknown };
  base?: { usdc?: number; [k: string]: unknown };
  gateway?: { usdc?: number; [k: string]: unknown };
  solana?: { usdc?: number; sol?: number; [k: string]: unknown };
  byChain?: Record<string, unknown> | null;
  pendingBridgeUsdc?: number;
}

export interface AccountSummary {
  accountType: AccountType;
  active: boolean;
  businessName?: string | null;
  depositAddress: string | null;
  solanaAddress: string | null;
  kycStatus: string;
  kycTier: number;
  balance: UnifiedBalance | null;
}

export interface SwitchAccountResponse {
  activeContext: AccountType;
  user: ProximUser;
  account: {
    accountType: AccountType;
    depositAddress: string | null;
    solanaAddress: string | null;
    kycStatus: string;
    kycTier: number;
    balance: UnifiedBalance | null;
    otherAccountBalanceUsdc: number | null;
    pendingInvoiceCount: number;
  };
}

export interface TransactionItem {
  id: number;
  type: string;
  status: string;
  amount: string;
  decimals: number;
  chain: string;
  txHash: string | null;
  narration: string | null;
  accountType: AccountType;
  createdAt: string | null;
  /** Bank payouts only. */
  counterparty?: { name: string | null; detail: string } | null;
  fiatAmount?: number | null;
  fiatCurrency?: string | null;
  payoutStatus?: "processing" | "paid" | "failed" | null;
  payoutUpdatedAt?: string | null;
}

export interface ActionIntentResponse {
  challengeId: string;
  options: Record<string, unknown>;
  actionType: string;
  requiresPin: boolean;
  summary: {
    title: string;
    lines: Array<[string, string]>;
    rows?: Array<{ name: string | null; currency: string | null; amount: number | null }>;
    parseErrors?: string[];
  };
}

export interface ActionConfirmResponse {
  success: boolean;
  actionType: string;
  notice?: string;
  txHash?: string | null;
  orderId?: string | null;
  card?: Record<string, unknown>;
  result?: Record<string, unknown>;
  schedule?: ScheduleItem;
  claimUrl?: string;
  shareUrl?: string;
  shareText?: string;
  businessDepositAddress?: string;
  [k: string]: unknown;
}

export interface ContactItem {
  id?: number;
  name: string;
  walletAddress: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
  notes: string | null;
  createdAt?: string | null;
}

export interface BankItem {
  code: string;
  name: string;
  country: string;
  logo: string | null;
}

export interface BankRatesResponse {
  currency: string;
  onRampRate: number | null;
  offRampRate: number | null;
  updatedAt: string;
}

export interface ResolvedBankAccount {
  bankCode: string;
  bankName: string | null;
  accountNumber: string;
  accountName: string;
  verified: boolean;
}

export interface NgnDepositOrder {
  accountType: AccountType;
  depositAddress: string;
  settlementRail: string;
  orderId: string | null;
  status: string;
  estimatedUsdc: number | null;
  rate: number | null;
  virtualAccount: {
    bankName: string | null;
    accountNumber: string | null;
    accountName: string | null;
    amountNgn: number;
    expiresAt: string | null;
  };
}

export interface IntentChainInfo {
  key: string;
  name: string;
  short: string;
  isEvm: boolean;
  priority: number;
  logoUrl: string | null;
  tokenCount: number;
}

export interface IntentTokenInfo {
  symbol: string;
  name: string;
  assetId: string;
  decimals: number;
  blockchain: string;
  contractAddress?: string | null;
  priceUsd?: number | null;
  logoUrl?: string | null;
}

export interface SwapPairRate {
  usdcUsd: number | null;
  eurcUsd: number | null;
  usdcToEurc: number | null;
  eurcToUsdc: number | null;
  feePct: number;
  updatedAt: string;
}

export interface CryptoDepositTokensResponse {
  accountType: AccountType;
  directAddresses: Record<string, string | null>;
  chains?: IntentChainInfo[];
  tokensByChain?: Record<string, IntentTokenInfo[]>;
  intents: {
    near: IntentTokenInfo[];
    solana: IntentTokenInfo[];
    robinhood: IntentTokenInfo[];
    starknet: IntentTokenInfo[];
  };
}

export interface CryptoDepositIntentResponse {
  accountType: AccountType;
  recipientAddress: string;
  depositId: number;
  chain: string;
  symbol: string;
  amount: number;
  depositAddress: string;
  depositMemo: string | null;
  refundTo: string;
  estimatedAmountOutUsdc: number | string | null;
  deadline: string | null;
  status: string;
  instructions: string;
}

export interface GlobalAccountItem {
  id: string | null;
  accountId: string | null;
  currency: string;
  bankName: string | null;
  beneficiaryName: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  sortCode: string | null;
  iban: string | null;
  swiftCode: string | null;
  status: string;
}

export interface GlobalRail {
  railKey: string;
  currency: string;
  country: string;
  label: string;
  paymentMethod: string;
  settlement: string;
  minAmount: number | null;
  maxAmount: number | null;
  requiredFields: Array<{ key?: string; name?: string; label?: string; placeholder?: string } | string>;
}

export interface GlobalRecipient {
  id: number;
  counterpartyId: string;
  label: string;
  currency: string;
  accountHolderName: string | null;
  railKey: string | null;
  bankName: string | null;
  accountTail: string | null;
}

export interface CardItem {
  id?: string;
  card_id?: string;
  cardId?: string;
  name?: string;
  card_name?: string;
  type?: string;
  card_type?: string;
  brand?: string;
  last4?: string;
  status?: string;
  frozen?: boolean;
  balance?: number;
  balanceUsd?: number;
  currency?: string;
  expiryMonth?: string | number;
  expiryYear?: string | number;
  [k: string]: unknown;
}

export interface BillHistoryItem {
  id: number;
  category: string;
  providerName: string | null;
  recipient: string;
  amountNgn: number;
  amountUsdc: number;
  status: string;
  meterToken: string | null;
  txHash: string | null;
  createdAt: string | null;
}

export interface ScheduleItem {
  id: number;
  kind: string;
  frequency: string;
  day?: string | null;
  time?: string | null;
  label?: string;
  status: string;
  nextRunAt?: string | null;
  payment?: Record<string, unknown>;
}

export interface RewardsOverview {
  pointsBalance: number;
  pointsPerUsd: number;
  minRedeemPoints: number;
  redeemValueUsd: number;
  referralCode: string;
  referralLink: string;
  referredCount: number;
  history: Array<{
    id: number;
    points: number;
    action: string;
    details: string | null;
    createdAt: string | null;
  }>;
}

export interface KycStatusResponse {
  personal: {
    tier: number;
    status: string;
    legalName: string | null;
    countryCode: string | null;
    rejectionReason: string | null;
    updatedAt: string | null;
  };
  business: {
    tier: number;
    status: string;
    legalName: string | null;
    countryCode: string | null;
    rejectionReason: string | null;
    updatedAt: string | null;
  };
  limits: {
    hourlyUsd: number;
    dailyUsd: number;
    businessDailyUsd: number;
    usedHourlyUsd: number;
    usedDailyUsd: number;
  };
}

export interface SavingsOverview {
  accountType: AccountType;
  position: {
    id: number;
    principalUsdc: number;
    accruedYieldUsdc: number;
    apy: number;
    /** The user's rate (after fees) when they saved. */
    apyAtDeposit?: number;
    /** Today's rate for the same vault, if known. */
    currentApy?: number | null;
    isAutoEarn?: boolean;
    symbol: string;
    vaultAddress: string | null;
    openedAt: string | null;
  } | null;
  pools: Array<{
    name: string;
    symbol: string;
    apy: number;
    tvlUsd: number;
    vaultAddress: string | null;
  }>;
}

export interface BusinessHomeResponse {
  enabled: boolean;
  depositAddress: string | null;
  profile: {
    businessName: string;
    businessEmail: string | null;
    phone: string | null;
    address: string | null;
    defaultDueDays: number;
    currencyDisplay: string;
    updatedAt: string | null;
  } | null;
  balance: UnifiedBalance | null;
  summary: {
    monthIncomeUsd: number;
    monthExpensesUsd: number;
    netCashFlowUsd: number;
    monthInvoiceCount: number;
    pendingInvoiceCount: number;
    pendingInvoiceTotalUsd: number;
    savingsGoal: { percentage?: number; label?: string } | null;
    savingsBalanceUsd: number;
  };
}

export interface InvoiceItem {
  id: number;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string | null;
  totalUsdc: number;
  dueDate: string | null;
  notes: string | null;
  status: string;
  paymentAddress: string | null;
  fiatBankName: string | null;
  fiatAccountNumber: string | null;
  fiatAccountName: string | null;
  fiatAmount: number | null;
  createdAt: string | null;
}

export interface BusinessExpenseItem {
  id: number;
  amount: number;
  currency: string;
  category: string;
  description: string;
  loggedAt: string | null;
}

export interface PaymentLinkItem {
  linkId: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  amount: number | null;
  currency: string;
  channels: string[];
  active: boolean;
  createdAt: string | null;
}

export interface DeviceItem {
  id: string;
  platform: string;
  name: string | null;
  current: boolean;
  restrictedUntil: string | null;
  addedAt: string | null;
  lastSeenAt: string | null;
}

export interface GiftItem {
  id: number;
  claimToken: string;
  targetHandle: string;
  amountUsdc: number;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
}

export interface WithdrawalChain {
  key: string;
  name: string;
  label: string;
  token: string;
  engine: string;
  example: string;
}

export interface AssistantResponse {
  intent: string;
  confidence: string;
  summary: string | null;
  reply: string;
  missingQuestion: string | null;
  confirmationText: string | null;
  suggestedAction: {
    type: string;
    payload: Record<string, unknown>;
  } | null;
  data: Record<string, unknown> | null;
}

export interface AppNotification {
  id: number;
  title: string;
  body: string;
  kind: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}
