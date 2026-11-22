// src/nuvion_corridors.js
// Complete Single Source of Truth for ALL 27 Nuvion Fiat Currencies & ALL 24+ Payout Rails
// Verified directly against https://docs.nuvion.co/supported-currencies,
// /core-concepts/accounts, and /guides/send-a-payout (X-API-Version: 2026-02-06).

const ALL_NUVION_FIAT_CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY",
  "HKD", "SGD", "THB", "PHP", "KRW", "AED", "ILS", "ZAR", "NGN",
  "GHS", "KES", "TZS", "UGX", "MXN", "BRL", "SEK", "NOK", "DKK",
];

const ALL_NUVION_RECEIVING_CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "NGN", "AED", "KES", "GHS", "TZS", "MXN",
];

const CURRENCY_INFO = {
  USD: { code: "USD", name: "US Dollar", symbol: "$", flag: "🇺🇸", region: "americas", defaultCountry: "US", receiving: true },
  EUR: { code: "EUR", name: "Euro", symbol: "€", flag: "🇪🇺", region: "europe", defaultCountry: "DE", receiving: true },
  GBP: { code: "GBP", name: "British Pound", symbol: "£", flag: "🇬🇧", region: "europe", defaultCountry: "GB", receiving: true },
  CAD: { code: "CAD", name: "Canadian Dollar", symbol: "CA$", flag: "🇨🇦", region: "americas", defaultCountry: "CA", receiving: true },
  AUD: { code: "AUD", name: "Australian Dollar", symbol: "A$", flag: "🇦🇺", region: "apac_me", defaultCountry: "AU", receiving: false },
  NZD: { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$", flag: "🇳🇿", region: "apac_me", defaultCountry: "NZ", receiving: false },
  CHF: { code: "CHF", name: "Swiss Franc", symbol: "CHF ", flag: "🇨🇭", region: "europe", defaultCountry: "CH", receiving: false },
  JPY: { code: "JPY", name: "Japanese Yen", symbol: "¥", flag: "🇯🇵", region: "apac_me", defaultCountry: "JP", receiving: false },
  CNY: { code: "CNY", name: "Chinese Yuan", symbol: "¥", flag: "🇨🇳", region: "apac_me", defaultCountry: "CN", receiving: false },
  HKD: { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", flag: "🇭🇰", region: "apac_me", defaultCountry: "HK", receiving: false },
  SGD: { code: "SGD", name: "Singapore Dollar", symbol: "S$", flag: "🇸🇬", region: "apac_me", defaultCountry: "SG", receiving: false },
  THB: { code: "THB", name: "Thai Baht", symbol: "฿", flag: "🇹🇭", region: "apac_me", defaultCountry: "TH", receiving: false },
  PHP: { code: "PHP", name: "Philippine Peso", symbol: "₱", flag: "🇵🇭", region: "apac_me", defaultCountry: "PH", receiving: false },
  KRW: { code: "KRW", name: "South Korean Won", symbol: "₩", flag: "🇰🇷", region: "apac_me", defaultCountry: "KR", receiving: false },
  AED: { code: "AED", name: "UAE Dirham", symbol: "AED ", flag: "🇦🇪", region: "apac_me", defaultCountry: "AE", receiving: true },
  ILS: { code: "ILS", name: "Israeli New Shekel", symbol: "₪", flag: "🇮🇱", region: "apac_me", defaultCountry: "IL", receiving: false },
  ZAR: { code: "ZAR", name: "South African Rand", symbol: "R", flag: "🇿🇦", region: "africa", defaultCountry: "ZA", receiving: false },
  NGN: { code: "NGN", name: "Nigerian Naira", symbol: "₦", flag: "🇳🇬", region: "africa", defaultCountry: "NG", receiving: true },
  GHS: { code: "GHS", name: "Ghanaian Cedi", symbol: "GH₵", flag: "🇬🇭", region: "africa", defaultCountry: "GH", receiving: true },
  KES: { code: "KES", name: "Kenyan Shilling", symbol: "KSh ", flag: "🇰🇪", region: "africa", defaultCountry: "KE", receiving: true },
  TZS: { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh ", flag: "🇹🇿", region: "africa", defaultCountry: "TZ", receiving: true },
  UGX: { code: "UGX", name: "Ugandan Shilling", symbol: "USh ", flag: "🇺🇬", region: "africa", defaultCountry: "UG", receiving: false },
  MXN: { code: "MXN", name: "Mexican Peso", symbol: "MX$", flag: "🇲🇽", region: "americas", defaultCountry: "MX", receiving: true },
  BRL: { code: "BRL", name: "Brazilian Real", symbol: "R$", flag: "🇧🇷", region: "americas", defaultCountry: "BR", receiving: false },
  SEK: { code: "SEK", name: "Swedish Krona", symbol: "kr ", flag: "🇸🇪", region: "europe", defaultCountry: "SE", receiving: false },
  NOK: { code: "NOK", name: "Norwegian Krone", symbol: "kr ", flag: "🇳🇴", region: "europe", defaultCountry: "NO", receiving: false },
  DKK: { code: "DKK", name: "Danish Krone", symbol: "kr ", flag: "🇩🇰", region: "europe", defaultCountry: "DK", receiving: false },
};

const REGIONS = {
  africa: { key: "africa", label: "🌍 Africa", currencies: ["NGN", "GHS", "KES", "TZS", "UGX", "ZAR"] },
  americas: { key: "americas", label: "🌎 Americas", currencies: ["USD", "CAD", "MXN", "BRL"] },
  europe: { key: "europe", label: "🇪🇺 UK & Europe", currencies: ["GBP", "EUR", "CHF", "SEK", "NOK", "DKK"] },
  apac_me: { key: "apac_me", label: "🌏 Asia-Pacific & Middle East", currencies: ["CNY", "AED", "AUD", "SGD", "PHP", "HKD", "JPY", "NZD", "KRW", "THB", "ILS"] },
};

/**
 * Every official Nuvion payout rail + exact required fields + official min/max limits.
 * Keyed by unique railKey used in Telegram callbacks, DB records, and CSV payroll.
 */
const PAYOUT_RAILS = {
  // ── Africa ────────────────────────────────────────────────────────────────
  ngn_nip: {
    key: "ngn_nip",
    currency: "NGN",
    country: "NG",
    label: "Nigeria Bank Transfer (NIP)",
    paymentMethod: "bank-transfer",
    scheme: null, // inferred by Nuvion for NGN/NG
    settlement: "Instant",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code (e.g. 044), Account Number, Bank Name",
    example: "Chidinma Okafor, 044, 0690000031, Access Bank",
  },
  ghs_eft: {
    key: "ghs_eft",
    currency: "GHS",
    country: "GH",
    label: "Ghana Bank Transfer (EFT)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code, Account Number, Bank Name",
    example: "Kwame Mensah, 030100, 123456789012, GCB Bank",
  },
  ghs_momo: {
    key: "ghs_momo",
    currency: "GHS",
    country: "GH",
    label: "Ghana Mobile Money (MTN / Vodafone / Airtel)",
    paymentMethod: "momo-transfer",
    schemeOptions: ["mtn", "vodafone", "airtel"],
    settlement: "Instant",
    minAmount: 5,
    maxAmount: 25000,
    fields: ["account_holder_name", "scheme", "phone_number"],
    promptHint: "Recipient Name, Network (mtn / vodafone / airtel), Phone (+233...)",
    example: "Ama Boateng, mtn, +233241234567",
  },
  kes_eft: {
    key: "kes_eft",
    currency: "KES",
    country: "KE",
    label: "Kenya Bank Transfer (EFT)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code, Account Number, Bank Name",
    example: "Wanjiku Kamau, 01, 1102345678, KCB Bank",
  },
  kes_momo: {
    key: "kes_momo",
    currency: "KES",
    country: "KE",
    label: "Kenya Mobile Money (M-Pesa / Airtel / Telkom)",
    paymentMethod: "momo-transfer",
    schemeOptions: ["mpesa", "airtel", "telkom"],
    settlement: "Instant",
    minAmount: 20,
    maxAmount: 250000,
    fields: ["account_holder_name", "scheme", "phone_number"],
    promptHint: "Recipient Name, Network (mpesa / airtel / telkom), Phone (+254...)",
    example: "John Otieno, mpesa, +254712345678",
  },
  tzs_eft: {
    key: "tzs_eft",
    currency: "TZS",
    country: "TZ",
    label: "Tanzania Bank Transfer (EFT)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code, Account Number, Bank Name",
    example: "Amina Juma, 015, 0152345678900, CRDB Bank",
  },
  tzs_momo: {
    key: "tzs_momo",
    currency: "TZS",
    country: "TZ",
    label: "Tanzania Mobile Money (Vodacom / Airtel / Tigo / Halotel)",
    paymentMethod: "momo-transfer",
    schemeOptions: ["vodacom", "airtel", "tigo", "halotel"],
    settlement: "Instant",
    minAmount: 1000,
    maxAmount: 5000000,
    fields: ["account_holder_name", "scheme", "phone_number"],
    promptHint: "Recipient Name, Network (vodacom / airtel / tigo / halotel), Phone (+255...)",
    example: "Juma Bakari, vodacom, +255754123456",
  },
  ugx_eft: {
    key: "ugx_eft",
    currency: "UGX",
    country: "UG",
    label: "Uganda Bank Transfer (EFT)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, 6-Digit Bank Code, Account Number, Bank Name",
    example: "David Okello, 040147, 9030012345678, Stanbic Uganda",
  },
  zar_rtc: {
    key: "zar_rtc",
    currency: "ZAR",
    country: "ZA",
    label: "South Africa Real-Time Clearing (RTC)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank/Branch Code, Account Number, Bank Name",
    example: "Thabo Mbeki, 250655, 62123456789, FNB South Africa",
  },

  // ── Americas ──────────────────────────────────────────────────────────────
  usd_ach: {
    key: "usd_ach",
    currency: "USD",
    country: "US",
    label: "US Bank Transfer (ACH)",
    paymentMethod: "bank-transfer",
    scheme: "ach",
    settlement: "Same / next day",
    requiresBankAddress: true,
    fields: ["account_holder_name", "routing_number", "account_number", "bank_name", "bank_address_line1", "bank_address_city", "bank_address_state", "bank_address_postal_code"],
    promptHint: "Account Name, 9-Digit Routing #, Account #, Bank Name, Bank Street, City, State (2-letter), ZIP",
    example: "Danielle Brooks, 026009593, 987654321012, Bank of America, 100 Federal St, Boston, MA, 02110",
  },
  usd_wire: {
    key: "usd_wire",
    currency: "USD",
    country: "US",
    label: "US Domestic Wire",
    paymentMethod: "bank-transfer",
    scheme: "wire",
    settlement: "Same day",
    requiresBankAddress: true,
    fields: ["account_holder_name", "routing_number", "account_number", "bank_name", "bank_address_line1", "bank_address_city", "bank_address_state", "bank_address_postal_code"],
    promptHint: "Account Name, 9-Digit Routing #, Account #, Bank Name, Bank Street, City, State (2-letter), ZIP",
    example: "Michael Carter, 021000021, 123456789012, JPMorgan Chase, 270 Park Ave, New York, NY, 10017",
  },
  usd_rtp: {
    key: "usd_rtp",
    currency: "USD",
    country: "US",
    label: "US Real-Time Payment (RTP)",
    paymentMethod: "bank-transfer",
    scheme: "rtp",
    settlement: "Instant",
    requiresBankAddress: true,
    fields: ["account_holder_name", "routing_number", "account_number", "bank_name", "bank_address_line1", "bank_address_city", "bank_address_state", "bank_address_postal_code"],
    promptHint: "Account Name, 9-Digit Routing #, Account #, Bank Name, Bank Street, City, State (2-letter), ZIP",
    example: "Sarah Mitchell, 121000248, 112233445566, Wells Fargo, 420 Montgomery St, San Francisco, CA, 94104",
  },
  cad_interac_email: {
    key: "cad_interac_email",
    currency: "CAD",
    country: "CA",
    label: "Canada Interac e-Transfer (Email)",
    paymentMethod: "bank-transfer",
    scheme: "interac_email",
    settlement: "Instant",
    maxAmount: 25000,
    fields: ["account_holder_name", "email"],
    promptHint: "Recipient Full Name, Interac Email Address",
    example: "Olivia Bennett, olivia.bennett@example.com",
  },
  cad_interac_account: {
    key: "cad_interac_account",
    currency: "CAD",
    country: "CA",
    label: "Canada Interac (Direct Bank Account)",
    paymentMethod: "bank-transfer",
    scheme: "interac_account",
    settlement: "Instant",
    maxAmount: 25000,
    fields: ["account_holder_name", "bank_institution_number", "transit_number", "account_number", "bank_name"],
    promptHint: "Account Name, 3-Digit Institution #, 5-Digit Transit #, Account #, Bank Name",
    example: "Lucas Tremblay, 003, 12345, 7891234, Royal Bank of Canada",
  },
  cad_eft: {
    key: "cad_eft",
    currency: "CAD",
    country: "CA",
    label: "Canada Bank Transfer (EFT)",
    paymentMethod: "bank-transfer",
    scheme: "eft",
    settlement: "Same / next day",
    fields: ["account_holder_name", "bank_institution_number", "transit_number", "account_number", "bank_name"],
    promptHint: "Account Name, 3-Digit Institution #, 5-Digit Transit #, Account #, Bank Name",
    example: "Lucas Tremblay, 003, 12345, 7891234, Royal Bank of Canada",
  },
  mxn_clabe: {
    key: "mxn_clabe",
    currency: "MXN",
    country: "MX",
    label: "Mexico Bank Transfer (CLABE)",
    paymentMethod: "bank-transfer",
    scheme: "clabe",
    settlement: "Instant",
    fields: ["account_holder_name", "account_number"],
    promptHint: "Account Name, 18-Digit CLABE Number",
    example: "Camila Torres, 002180000123456789",
  },

  // ── UK & Europe ───────────────────────────────────────────────────────────
  gbp_fps: {
    key: "gbp_fps",
    currency: "GBP",
    country: "GB",
    label: "UK Faster Payments (FPS)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "sort_code", "account_number", "bank_name"],
    promptHint: "Account Name, 6-Digit Sort Code, 8-Digit Account Number, Bank Name",
    example: "Jane Smith, 040004, 12345678, Barclays",
  },
  eur_sepa: {
    key: "eur_sepa",
    currency: "EUR",
    country: null, // derived from IBAN prefix (e.g. DE, FR, NL, IE, ES, IT) or supplied country
    label: "Europe SEPA Transfer (EUR)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    fields: ["account_holder_name", "iban", "swift_bic", "bank_name"],
    promptHint: "Account Name, IBAN, SWIFT/BIC, Bank Name",
    example: "Michael Weber, DE89370400440532013000, COBADEFFXXX, Commerzbank",
  },

  // ── Asia-Pacific & Middle East ────────────────────────────────────────────
  cny_wire: {
    key: "cny_wire",
    currency: "CNY",
    country: "CN",
    label: "China Bank Wire (CNY)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same day",
    minAmount: 420,
    maxAmount: 35593243,
    fields: ["account_holder_name", "swift_bic", "account_number", "bank_name"],
    promptHint: "Account Name (Pinyin/English), SWIFT/BIC, Bank Account Number, Bank Name",
    example: "Zhang Wei, SYCBCNBYXXX, 6230810325651744, SHENGJING BANK CO.,LTD",
  },
  aed_local: {
    key: "aed_local",
    currency: "AED",
    country: "AE",
    label: "UAE Local Transfer (AED)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Same / next day",
    fields: ["account_holder_name", "iban", "swift_bic", "bank_name"],
    promptHint: "Account Name, 23-Char UAE IBAN, SWIFT/BIC, Bank Name",
    example: "Omar Al-Maktoum, AE070331234567890123456, EBILAEADXXX, Emirates NBD",
  },
  aud_becs: {
    key: "aud_becs",
    currency: "AUD",
    country: "AU",
    label: "Australia Bank Transfer (BECS)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "1–2 business days",
    fields: ["account_holder_name", "bank_code", "branch_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code (3 digits), Branch Code (3 digits), Account #, Bank Name",
    example: "Liam O'Connor, 062, 000, 12345678, Commonwealth Bank",
  },
  sgd_fast: {
    key: "sgd_fast",
    currency: "SGD",
    country: "SG",
    label: "Singapore FAST Transfer (SGD)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Instant",
    fields: ["account_holder_name", "swift_bic", "account_number", "bank_name"],
    promptHint: "Account Name, SWIFT/BIC, Account Number, Bank Name",
    example: "Wei Lin Tan, DBSSSGSGXXX, 0123456789, DBS Bank",
  },
  php_instapay: {
    key: "php_instapay",
    currency: "PHP",
    country: "PH",
    label: "Philippines InstaPay (Instant)",
    paymentMethod: "bank-transfer",
    scheme: "insta_pay",
    settlement: "Instant",
    minAmount: 60,
    maxAmount: 50000,
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code, Account Number, Bank Name",
    example: "Maria Santos, BNORPHMM, 001234567890, BDO Unibank",
  },
  php_pesonet: {
    key: "php_pesonet",
    currency: "PHP",
    country: "PH",
    label: "Philippines PESONet (High Limit)",
    paymentMethod: "bank-transfer",
    scheme: "pesonet",
    settlement: "Same day",
    minAmount: 60,
    maxAmount: 18495600,
    fields: ["account_holder_name", "bank_code", "account_number", "bank_name"],
    promptHint: "Account Name, Bank Code, Account Number, Bank Name",
    example: "Maria Santos, BNORPHMM, 001234567890, BDO Unibank",
  },
  hkd_chats: {
    key: "hkd_chats",
    currency: "HKD",
    country: "HK",
    label: "Hong Kong CHATS (HKD)",
    paymentMethod: "bank-transfer",
    scheme: null,
    settlement: "Instant",
    fields: ["account_holder_name", "bank_code", "branch_code", "account_number", "bank_name"],
    promptHint: "Account Name, 3-Digit Bank Code, 3-Digit Branch Code, Account #, Bank Name",
    example: "Wing Chan, 004, 123, 456789001, HSBC Hong Kong",
  },

  // ── Universal SWIFT Rails (Supports ALL 27 Nuvion Fiat Currencies!) ───────
  swift_iban: {
    key: "swift_iban",
    currency: "*",
    country: null,
    label: "International SWIFT Wire (IBAN)",
    paymentMethod: "bank-transfer",
    scheme: "swift",
    settlement: "1–3 business days",
    requiresBankAddress: true,
    fields: ["account_holder_name", "country", "swift_bic", "iban", "bank_name", "bank_address_line1", "bank_address_city", "bank_address_postal_code"],
    promptHint: "Account Name, 2-Letter Country (e.g. CH), SWIFT/BIC, IBAN, Bank Name, Bank Street, City, Postal Code",
    example: "Lukas Meyer, CH, UBSWCHZH80A, CH9300762011623852957, UBS Switzerland, Bahnhofstrasse 45, Zurich, 8001",
  },
  swift_acct: {
    key: "swift_acct",
    currency: "*",
    country: null,
    label: "International SWIFT Wire (Account Number)",
    paymentMethod: "bank-transfer",
    scheme: "swift",
    settlement: "1–3 business days",
    fields: ["account_holder_name", "country", "swift_bic", "account_number", "bank_name"],
    promptHint: "Account Name, 2-Letter Country (e.g. JP), SWIFT/BIC, Account Number, Bank Name",
    example: "Kenji Sato, JP, BOTKJPJTXXX, 0123456, MUFG Bank",
  },
};

/**
 * Return all available payout rail definitions for any of Nuvion's 27 fiat currencies.
 * Currencies with local rails list local options first + SWIFT fallback.
 * SWIFT-only currencies (JPY, CHF, NZD, BRL, KRW, THB, ILS, SEK, NOK, DKK) return SWIFT IBAN & Account No.
 */
function getRailsForCurrency(currency) {
  const code = String(currency || "").toUpperCase();
  if (!ALL_NUVION_FIAT_CURRENCIES.includes(code)) return [];

  const localRails = Object.values(PAYOUT_RAILS).filter((r) => r.currency === code);
  const info = CURRENCY_INFO[code];
  const swiftRails = [
    {
      ...PAYOUT_RAILS.swift_acct,
      currency: code,
      country: info?.defaultCountry || null,
      label: `${code} International SWIFT (Account #)`,
    },
    {
      ...PAYOUT_RAILS.swift_iban,
      currency: code,
      country: info?.defaultCountry || null,
      label: `${code} International SWIFT (IBAN)`,
    },
  ];
  return [...localRails, ...swiftRails];
}

function getRailByKey(railKey, currencyOverride = null) {
  const base = PAYOUT_RAILS[railKey];
  if (!base) return null;
  if (base.currency === "*" && currencyOverride) {
    const code = String(currencyOverride).toUpperCase();
    const info = CURRENCY_INFO[code];
    return {
      ...base,
      currency: code,
      country: info?.defaultCountry || null,
      label: `${code} ${base.label}`,
    };
  }
  return base;
}

function isSupportedFiatCurrency(currency) {
  return ALL_NUVION_FIAT_CURRENCIES.includes(String(currency || "").toUpperCase());
}

/**
 * Validate amount against official Nuvion rail min/max limits (in major units).
 */
function validateCorridorAmount(railKey, amountMajor, currency = null) {
  const amt = Number(amountMajor);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { valid: false, error: "Amount must be greater than zero." };
  }
  const rail = getRailByKey(railKey, currency);
  if (!rail) return { valid: false, error: `Unsupported payout rail: ${railKey}` };

  const code = (currency || rail.currency || "").toUpperCase();
  if (rail.minAmount !== undefined && amt < rail.minAmount) {
    return {
      valid: false,
      error: `Minimum amount for ${rail.label} is ${rail.minAmount.toLocaleString("en-US")} ${code}.`,
    };
  }
  if (rail.maxAmount !== undefined && amt > rail.maxAmount) {
    return {
      valid: false,
      error: `Maximum amount per transfer for ${rail.label} is ${rail.maxAmount.toLocaleString("en-US")} ${code}.`,
    };
  }
  return { valid: true };
}

function formatCurrencyMajor(currency, amountMajor) {
  const code = String(currency || "USD").toUpperCase();
  const info = CURRENCY_INFO[code];
  const sym = info?.symbol || `${code} `;
  const n = Number(amountMajor) || 0;
  if (code === "NGN" || code === "JPY" || code === "KRW" || code === "UGX" || code === "TZS") {
    return `${sym}${Math.round(n).toLocaleString("en-US")}`;
  }
  return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Parse a comma-separated Telegram input string according to a rail's `fields` definition.
 */
function parseRecipientInputForRail(rail, rawText) {
  const parts = String(rawText || "").split(",").map((s) => s.trim());
  const out = {};
  rail.fields.forEach((field, idx) => {
    out[field] = parts[idx] || "";
  });

  // For bank_name containing commas (e.g., "SHENGJING BANK CO.,LTD") when bank_name is the last field:
  if (rail.fields[rail.fields.length - 1] === "bank_name" && parts.length > rail.fields.length) {
    const rawParts = String(rawText || "").split(",");
    out.bank_name = rawParts.slice(rail.fields.length - 1).join(",").trim();
  }

  // Validate required fields present
  const missing = rail.fields.filter((f) => !out[f]);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing details (${missing.join(", ")}). Expected: ${rail.promptHint}`,
    };
  }

  // Rail-specific cleanups & checks
  if (rail.schemeOptions) {
    const chosen = String(out.scheme || "").toLowerCase().trim();
    if (!rail.schemeOptions.includes(chosen)) {
      return {
        ok: false,
        error: `Unsupported mobile money network "${out.scheme}". Use one of: ${rail.schemeOptions.join(", ")}.`,
      };
    }
    out.scheme = chosen;
  }

  if (out.phone_number) {
    const cleanPhone = out.phone_number.replace(/[\s\-()]/g, "");
    out.phone_number = cleanPhone.startsWith("+") ? cleanPhone : `+${cleanPhone}`;
  }
  if (out.iban) {
    out.iban = out.iban.replace(/\s+/g, "").toUpperCase();
  }
  if (out.swift_bic) {
    out.swift_bic = out.swift_bic.replace(/\s+/g, "").toUpperCase();
  }
  if (out.sort_code) {
    out.sort_code = out.sort_code.replace(/[^0-9]/g, "");
  }
  if (out.country) {
    out.country = out.country.trim().toUpperCase().slice(0, 2);
  }
  if (rail.key === "eur_sepa" && !out.country && out.iban && /^[A-Z]{2}/.test(out.iban)) {
    out.country = out.iban.slice(0, 2);
  }
  if (rail.key === "mxn_clabe") {
    out.account_number = out.account_number.replace(/\D/g, "");
    if (out.account_number.length !== 18) {
      return { ok: false, error: "Mexican CLABE must be exactly 18 digits." };
    }
  }
  if (rail.key === "aed_local" && out.iban && out.iban.length !== 23) {
    return { ok: false, error: "UAE IBAN must be 23 characters (starting with AE)." };
  }
  if (rail.key === "cad_interac_email" && (!out.email || !out.email.includes("@"))) {
    return { ok: false, error: "Please provide a valid Interac recipient email address." };
  }
  if ((rail.key === "cad_eft" || rail.key === "cad_interac_account")) {
    out.bank_institution_number = out.bank_institution_number.replace(/\D/g, "");
    out.transit_number = out.transit_number.replace(/\D/g, "");
    if (out.bank_institution_number.length !== 3 || out.transit_number.length !== 5) {
      return { ok: false, error: "Canada bank routing requires a 3-digit institution number and 5-digit transit number." };
    }
  }

  return { ok: true, details: out };
}

/**
 * Build schema-exact Nuvion POST /counterparties payload from parsed recipient details.
 */
function buildCounterpartyPayload(entityId, rail, details, recipientEmail = null) {
  const fullName = String(details.account_holder_name || "Recipient").trim();
  const parts = fullName.split(/\s+/);
  const firstName = parts[0] || "Recipient";
  const lastName = parts.slice(1).join(" ") || firstName;
  const country = (details.country || rail.country || CURRENCY_INFO[rail.currency]?.defaultCountry || "US").toUpperCase();
  const slug = fullName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "recipient";
  const email = (details.email || recipientEmail || `${slug}+${Date.now().toString(36)}@recipients.proxim.app`).trim().toLowerCase();

  return {
    entityId,
    type: "individual",
    nickname: `${fullName} (${rail.currency})`.slice(0, 60),
    profile: {
      first_name: firstName,
      last_name: lastName,
      relationship: "vendor",
      email,
      address: {
        line1: details.bank_address_line1 || "1 Main Street",
        city: details.bank_address_city || "City",
        state_or_province: details.bank_address_state || country,
        postal_code: details.bank_address_postal_code || "00000",
        country,
      },
    },
  };
}

/**
 * Build schema-exact Nuvion POST /payment-details payload from rail definition & parsed details.
 */
function buildPaymentDetailPayload(entityId, counterpartyId, rail, details) {
  const currency = String(rail.currency || details.currency || "USD").toUpperCase();
  const country = (details.country || rail.country || CURRENCY_INFO[currency]?.defaultCountry || "US").toUpperCase();

  const payload = {
    entityId,
    counterparty_id: counterpartyId,
    payment_method: rail.paymentMethod,
    currency,
    country,
    account_holder_name: String(details.account_holder_name || "").trim(),
  };

  if (rail.scheme) payload.scheme = rail.scheme;
  else if (details.scheme) payload.scheme = String(details.scheme).toLowerCase();

  if (rail.paymentMethod === "momo-transfer") {
    payload.phone_number = details.phone_number;
    return payload;
  }

  // Bank transfer routing fields per docs.nuvion.co/guides/send-a-payout
  if (details.account_number) payload.account_number = String(details.account_number).trim();
  if (details.iban) payload.iban = String(details.iban).trim().toUpperCase();
  if (details.sort_code) payload.sort_code = String(details.sort_code).trim();
  if (details.routing_number) payload.routing_number = String(details.routing_number).trim();
  if (details.swift_bic) payload.swift_bic = String(details.swift_bic).trim().toUpperCase();
  if (details.bank_code) payload.bank_code = String(details.bank_code).trim();
  if (details.branch_code) payload.branch_code = String(details.branch_code).trim();
  if (details.bank_institution_number) payload.bank_institution_number = String(details.bank_institution_number).trim();
  if (details.transit_number) payload.transit_number = String(details.transit_number).trim();
  if (details.bank_name) payload.bank_name = String(details.bank_name).trim();
  if (details.email && payload.scheme === "interac_email") payload.email = String(details.email).trim().toLowerCase();

  if (currency === "USD" && ["ach", "wire", "rtp"].includes(payload.scheme)) {
    payload.account_type = details.account_type || "checking";
    payload.bank_address = {
      line1: details.bank_address_line1 || "100 Main Street",
      city: details.bank_address_city || "New York",
      state: details.bank_address_state || "NY",
      postal_code: details.bank_address_postal_code || "10001",
      country: "US",
    };
  } else if (rail.requiresBankAddress || (payload.scheme === "swift" && payload.iban)) {
    payload.bank_address = {
      line1: details.bank_address_line1 || "1 Bank Plaza",
      city: details.bank_address_city || "City",
      state: details.bank_address_state || country,
      postal_code: details.bank_address_postal_code || "00000",
      country,
    };
  }

  return payload;
}

/**
 * Parse a Business Multi-Currency Global Payroll CSV into structured payout rows.
 * Supported headers (case-insensitive, flexible order):
 * name, currency, amount, rail (optional), country (optional), account_number,
 * bank_code, branch_code, routing_number, sort_code, swift_bic, iban,
 * bank_institution_number, transit_number, phone_number, scheme, email,
 * bank_name, bank_address_line1, bank_address_city, bank_address_state, bank_address_postal_code, narration
 */
function parseMultiCurrencyCsv(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 2) {
    throw new Error("CSV must contain a header row and at least one payroll recipient row.");
  }

  // RFC-4180 aware simple CSV line splitter (supports quoted fields with commas)
  const splitCsvLine = (line) => {
    const cols = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cols.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  const rows = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    const rec = {};
    headers.forEach((h, idx) => { rec[h] = vals[idx] || ""; });

    const name = rec.name || rec.account_holder_name || rec.recipient || rec.employee;
    const currency = String(rec.currency || "").toUpperCase();
    const amount = parseFloat(String(rec.amount || "").replace(/[^0-9.]/g, ""));

    if (!name || !isSupportedFiatCurrency(currency) || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${i + 1}: invalid name, unsupported currency "${currency}", or invalid amount.`);
      continue;
    }

    // Resolve rail automatically if omitted
    let railKey = (rec.rail || "").toLowerCase().trim();
    if (!railKey || !PAYOUT_RAILS[railKey]) {
      const candidates = getRailsForCurrency(currency);
      if (rec.phone_number && candidates.some((c) => c.paymentMethod === "momo-transfer")) {
        railKey = candidates.find((c) => c.paymentMethod === "momo-transfer").key;
      } else if (currency === "CAD" && rec.email && !rec.account_number) {
        railKey = "cad_interac_email";
      } else if (currency === "USD" && rec.scheme && PAYOUT_RAILS[`usd_${rec.scheme.toLowerCase()}`]) {
        railKey = `usd_${rec.scheme.toLowerCase()}`;
      } else if (currency === "PHP" && rec.scheme && rec.scheme.toLowerCase() === "pesonet") {
        railKey = "php_pesonet";
      } else if (candidates.length > 0) {
        // Default to primary local rail or SWIFT
        if (candidates[0].key === "swift_acct" && rec.iban && !rec.account_number) {
          railKey = "swift_iban";
        } else {
          railKey = candidates[0].key;
        }
      }
    }

    const rail = getRailByKey(railKey, currency);
    if (!rail) {
      errors.push(`Row ${i + 1} (${name}): could not determine payout rail for ${currency}.`);
      continue;
    }

    const limitCheck = validateCorridorAmount(rail.key, amount, currency);
    if (!limitCheck.valid) {
      errors.push(`Row ${i + 1} (${name}): ${limitCheck.error}`);
      continue;
    }

    rows.push({
      rowIndex: i,
      name,
      currency,
      amount,
      railKey: rail.key,
      rail,
      narration: rec.narration || rec.memo || `Payroll ${name}`,
      details: {
        account_holder_name: name,
        country: (rec.country || rail.country || CURRENCY_INFO[currency]?.defaultCountry || "").toUpperCase(),
        account_number: rec.account_number || "",
        iban: rec.iban || "",
        sort_code: rec.sort_code || "",
        routing_number: rec.routing_number || "",
        swift_bic: rec.swift_bic || rec.swift || "",
        bank_code: rec.bank_code || "",
        branch_code: rec.branch_code || "",
        bank_institution_number: rec.bank_institution_number || rec.institution_number || "",
        transit_number: rec.transit_number || "",
        phone_number: rec.phone_number || rec.phone || "",
        scheme: (rec.scheme || rail.scheme || "").toLowerCase(),
        email: rec.email || "",
        bank_name: rec.bank_name || "",
        bank_address_line1: rec.bank_address_line1 || rec.bank_street || "",
        bank_address_city: rec.bank_address_city || rec.bank_city || "",
        bank_address_state: rec.bank_address_state || rec.bank_state || "",
        bank_address_postal_code: rec.bank_address_postal_code || rec.bank_zip || "",
      },
    });
  }

  return { rows, errors };
}

/**
 * Estimate Nuvion's outbound payout rail fee in USD (`applicable_fee`) for a given corridor/rail
 * so Proxim captures and bridges `principal + Nuvion rail fee` upfront instead of failing on dispatch.
 */
function estimateNuvionRailFeeUsd(railKey, currency, principalUsd, targetAmountMajor = null, fxRate = null) {
  const code = String(currency || "").toUpperCase();
  const rKey = String(railKey || "").toLowerCase();
  const principal = Math.max(0, Number(principalUsd) || 0);
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // Derive effective local-per-USD rate (fallback to ~1 when unknown)
  let rateLocalPerUsd = Number(fxRate || 0);
  if (rateLocalPerUsd <= 0 && targetAmountMajor && principal > 0) {
    rateLocalPerUsd = Number(targetAmountMajor) / principal;
  }
  const toUsd = (localAmt, fallbackUsd) =>
    rateLocalPerUsd > 0 ? round2(localAmt / rateLocalPerUsd) : fallbackUsd;

  if (rKey.startsWith("swift_")) {
    const fee = round2(50.0 + principal * 0.005);
    return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (SWIFT Wire)` };
  }

  switch (code) {
    case "GBP": {
      const targetGbp = Number(targetAmountMajor || 0);
      const minUsd = toUsd(5.0, 6.7);
      const pctUsd = targetGbp > 400 ? round2(principal * 0.0125) : 0;
      const fee = Math.max(minUsd, pctUsd);
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (UK FPS £5.00 min)` };
    }
    case "EUR": {
      const fee = Math.max(toUsd(5.0, 5.5), round2(principal * 0.005));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (SEPA €5.00 min)` };
    }
    case "USD": {
      const fee = rKey === "usd_wire" ? Math.max(15.0, round2(principal * 0.005)) : 5.0;
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (${rKey === "usd_wire" ? "US Wire" : "US ACH/RTP"})` };
    }
    case "CAD": {
      const fee = Math.max(toUsd(5.0, 3.7), round2(principal * 0.005));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (CA$5.00 min)` };
    }
    case "NGN": {
      const ngnAmt = Number(targetAmountMajor || 0);
      const localFee = ngnAmt > 10000 ? 200 : 50;
      const fee = Math.max(0.15, toUsd(localFee, 0.25));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (NGN NIP ₦${localFee})` };
    }
    case "GHS": {
      const fee = Math.max(1.5, toUsd(25, 2.2));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (GHS Rail)` };
    }
    case "KES": {
      const fee = Math.max(2.5, toUsd(450, 3.5));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (KES Rail)` };
    }
    case "AED": {
      const fee = Math.max(2.5, toUsd(10, 2.75));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (AED Local)` };
    }
    case "ZAR": {
      const fee = Math.max(2.0, toUsd(40, 2.5));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (ZAR RTC/EFT)` };
    }
    case "CNY": {
      const fee = Math.max(6.5, toUsd(50, 7.0));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (CNY Local)` };
    }
    default: {
      const fee = Math.max(5.0, round2(principal * 0.005));
      return { nuvionRailFeeUsd: fee, feeLabel: `$${fee.toFixed(2)} (${code} Rail)` };
    }
  }
}

module.exports = {
  ALL_NUVION_FIAT_CURRENCIES,
  ALL_NUVION_RECEIVING_CURRENCIES,
  CURRENCY_INFO,
  REGIONS,
  PAYOUT_RAILS,
  getRailsForCurrency,
  getRailByKey,
  isSupportedFiatCurrency,
  validateCorridorAmount,
  formatCurrencyMajor,
  estimateNuvionRailFeeUsd,
  parseRecipientInputForRail,
  buildCounterpartyPayload,
  buildPaymentDetailPayload,
  parseMultiCurrencyCsv,
};
