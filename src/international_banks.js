// src/international_banks.js
// Standard clearing bank codes, sort codes, and branch directories for international corridors
// where recipient banks demand bank codes (e.g. Ghana GHS, Tanzania TZS, Kenya KES, Uganda UGX, South Africa ZAR).
// Provides:
//   - directory lookups for mobile UI bank pickers
//   - fuzzy resolution from bank names so transfers never fail due to missing bank_code
//   - automatic bank code enrichment for Nuvion issuing/receiving accounts.

const INTERNATIONAL_BANKS = {
  GHS: [
    { code: "030100", name: "GCB Bank", aliases: ["gcb", "ghana commercial bank"] },
    { code: "130100", name: "Ecobank Ghana", aliases: ["ecobank", "ecobank ghana plc"] },
    { code: "040100", name: "Stanbic Bank Ghana", aliases: ["stanbic", "stanbic bank"] },
    { code: "020100", name: "Absa Bank Ghana", aliases: ["absa", "barclays", "barclays bank ghana"] },
    { code: "240100", name: "Fidelity Bank Ghana", aliases: ["fidelity", "fidelity bank"] },
    { code: "120100", name: "Zenith Bank Ghana", aliases: ["zenith", "zenith bank"] },
    { code: "010100", name: "Standard Chartered Bank Ghana", aliases: ["standard chartered", "stanchart", "scb"] },
    { code: "280100", name: "Access Bank Ghana", aliases: ["access", "access bank"] },
    { code: "140100", name: "CalBank", aliases: ["calbank", "cal bank"] },
    { code: "060100", name: "United Bank for Africa (UBA) Ghana", aliases: ["uba", "united bank for africa"] },
    { code: "340100", name: "Consolidated Bank Ghana (CBG)", aliases: ["cbg", "consolidated bank"] },
    { code: "330100", name: "First National Bank Ghana", aliases: ["fnb", "first national bank"] },
    { code: "080100", name: "Republic Bank Ghana", aliases: ["republic", "republic bank", "hfc"] },
    { code: "180100", name: "Prudential Bank Ghana", aliases: ["prudential", "prudential bank"] },
    { code: "090100", name: "Agricultural Development Bank (ADB)", aliases: ["adb", "agricultural development bank"] },
    { code: "190100", name: "Bank of Africa Ghana", aliases: ["boa", "bank of africa"] },
    { code: "110100", name: "FBNBank Ghana", aliases: ["fbn", "fbnbank", "first bank of nigeria"] },
    { code: "050100", name: "Societe Generale Ghana", aliases: ["sg", "societe generale"] },
  ],

  TZS: [
    { code: "015", name: "CRDB Bank", aliases: ["crdb", "crdb bank plc"] },
    { code: "012", name: "NMB Bank", aliases: ["nmb", "national microfinance bank", "nmb bank plc"] },
    { code: "011", name: "National Bank of Commerce (NBC)", aliases: ["nbc", "national bank of commerce"] },
    { code: "041", name: "Stanbic Bank Tanzania", aliases: ["stanbic", "stanbic tanzania"] },
    { code: "002", name: "Standard Chartered Tanzania", aliases: ["standard chartered", "stanchart"] },
    { code: "021", name: "Diamond Trust Bank (DTB) Tanzania", aliases: ["dtb", "diamond trust bank"] },
    { code: "017", name: "Exim Bank Tanzania", aliases: ["exim", "exim bank"] },
    { code: "026", name: "KCB Bank Tanzania", aliases: ["kcb", "kcb tanzania"] },
    { code: "051", name: "Equity Bank Tanzania", aliases: ["equity", "equity bank"] },
    { code: "008", name: "Absa Bank Tanzania", aliases: ["absa", "barclays tanzania", "absa tanzania"] },
    { code: "006", name: "Citibank Tanzania", aliases: ["citi", "citibank"] },
    { code: "028", name: "Azania Bank", aliases: ["azania", "azania bank"] },
    { code: "033", name: "I&M Bank Tanzania", aliases: ["i&m", "i and m", "inm"] },
    { code: "024", name: "Bank of Africa Tanzania", aliases: ["boa", "bank of africa"] },
    { code: "018", name: "TPB Bank (Tanzania Postal Bank)", aliases: ["tpb", "postal bank"] },
  ],

  KES: [
    { code: "01", name: "KCB Bank Kenya", aliases: ["kcb", "kenya commercial bank"] },
    { code: "68", name: "Equity Bank Kenya", aliases: ["equity", "equity bank"] },
    { code: "11", name: "Co-operative Bank of Kenya", aliases: ["co-op", "coop", "cooperative bank"] },
    { code: "02", name: "Standard Chartered Kenya", aliases: ["standard chartered", "stanchart"] },
    { code: "03", name: "Absa Bank Kenya", aliases: ["absa", "barclays kenya", "absa kenya"] },
    { code: "07", name: "NCBA Bank Kenya", aliases: ["ncba", "cba", "nic bank"] },
    { code: "31", name: "Stanbic Bank Kenya", aliases: ["stanbic", "cfc stanbic"] },
    { code: "63", name: "Diamond Trust Bank (DTB) Kenya", aliases: ["dtb", "diamond trust bank"] },
    { code: "57", name: "I&M Bank Kenya", aliases: ["i&m", "i and m", "inm bank"] },
    { code: "70", name: "Family Bank", aliases: ["family", "family bank"] },
    { code: "10", name: "Prime Bank Kenya", aliases: ["prime", "prime bank"] },
    { code: "12", name: "National Bank of Kenya (NBK)", aliases: ["nbk", "national bank"] },
    { code: "16", name: "Citibank Kenya", aliases: ["citi", "citibank"] },
    { code: "19", name: "Bank of Africa Kenya", aliases: ["boa", "bank of africa"] },
    { code: "26", name: "SBM Bank Kenya", aliases: ["sbm", "sbm bank"] },
    { code: "44", name: "Credit Bank", aliases: ["credit bank"] },
    { code: "66", name: "Sidian Bank", aliases: ["sidian", "k-rep"] },
  ],

  UGX: [
    { code: "040147", name: "Stanbic Bank Uganda", aliases: ["stanbic", "stanbic uganda"] },
    { code: "020100", name: "Centenary Bank", aliases: ["centenary", "cerudebe"] },
    { code: "010100", name: "Standard Chartered Uganda", aliases: ["standard chartered", "stanchart"] },
    { code: "030100", name: "Absa Bank Uganda", aliases: ["absa", "barclays uganda"] },
    { code: "060100", name: "DFCU Bank", aliases: ["dfcu", "dfcu bank"] },
    { code: "050100", name: "Bank of Baroda Uganda", aliases: ["baroda", "bank of baroda"] },
    { code: "140100", name: "Equity Bank Uganda", aliases: ["equity", "equity bank"] },
    { code: "150100", name: "KCB Bank Uganda", aliases: ["kcb", "kcb uganda"] },
    { code: "090100", name: "Diamond Trust Bank (DTB) Uganda", aliases: ["dtb", "diamond trust bank"] },
    { code: "210100", name: "PostBank Uganda", aliases: ["postbank", "post bank"] },
    { code: "110100", name: "Housing Finance Bank", aliases: ["hfb", "housing finance"] },
    { code: "080100", name: "I&M Bank Uganda (Orient)", aliases: ["orient", "i&m", "i and m"] },
    { code: "170100", name: "Cairo Bank Uganda", aliases: ["cairo", "cairo bank"] },
  ],

  ZAR: [
    { code: "250655", name: "First National Bank (FNB)", aliases: ["fnb", "first national bank", "firstrand"] },
    { code: "051001", name: "Standard Bank South Africa", aliases: ["standard bank", "sbsa"] },
    { code: "632005", name: "ABSA Bank South Africa", aliases: ["absa", "absa bank"] },
    { code: "198765", name: "Nedbank", aliases: ["nedbank", "nedcor"] },
    { code: "470010", name: "Capitec Bank", aliases: ["capitec", "capitec bank"] },
    { code: "580105", name: "Investec Bank", aliases: ["investec"] },
    { code: "679000", name: "Discovery Bank", aliases: ["discovery", "discovery bank"] },
    { code: "678910", name: "TymeBank", aliases: ["tyme", "tymebank"] },
    { code: "430000", name: "African Bank", aliases: ["african bank"] },
    { code: "462005", name: "Bidvest Bank", aliases: ["bidvest", "bidvest bank"] },
    { code: "450105", name: "Mercantile Bank", aliases: ["mercantile", "mercantile bank"] },
    { code: "683000", name: "Sasfin Bank", aliases: ["sasfin", "sasfin bank"] },
  ],
};

function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Returns list of banks for a specific currency (e.g. GHS, TZS, KES, UGX, ZAR).
 */
function getBanksForCurrency(currency) {
  const code = String(currency || "").toUpperCase();
  return INTERNATIONAL_BANKS[code] || [];
}

/**
 * Resolve bank code from explicit user input, or fuzzy search by bank name / aliases.
 * @param {string} currency - 3-letter currency code (GHS, TZS, KES, UGX, ZAR)
 * @param {string} [bankName] - Name of the bank entered by user
 * @param {string} [explicitBankCode] - Bank code if provided directly
 * @returns {{ code: string | null, name: string | null }}
 */
function resolveInternationalBank(currency, bankName = null, explicitBankCode = null) {
  const code = String(currency || "").toUpperCase();
  const banks = INTERNATIONAL_BANKS[code] || [];
  const cleanExplicit = String(explicitBankCode || "").trim();

  // 1. Direct code lookup if user provided one
  if (cleanExplicit) {
    const directMatch = banks.find((b) => b.code.toLowerCase() === cleanExplicit.toLowerCase());
    if (directMatch) return { code: directMatch.code, name: directMatch.name };
    return { code: cleanExplicit, name: bankName ? String(bankName).trim() : null };
  }

  // 2. Fuzzy match against bankName
  if (!bankName) return { code: null, name: null };
  const target = normalizeText(bankName);
  if (!target) return { code: null, name: null };

  // Exact/alias match
  for (const b of banks) {
    if (normalizeText(b.name) === target) return { code: b.code, name: b.name };
    if (b.aliases.some((a) => normalizeText(a) === target)) return { code: b.code, name: b.name };
  }

  // Substring match
  for (const b of banks) {
    const n = normalizeText(b.name);
    if (target.includes(n) || n.includes(target)) return { code: b.code, name: b.name };
    for (const a of b.aliases) {
      const na = normalizeText(a);
      if (na.length >= 3 && (target.includes(na) || na.includes(target))) {
        return { code: b.code, name: b.name };
      }
    }
  }

  return { code: null, name: String(bankName).trim() };
}

/**
 * Enrich virtual receiving account details with clearing bank code for display.
 */
function enrichReceivingBankCode(currency, bankName, existingCode = null) {
  if (existingCode && String(existingCode).trim()) return String(existingCode).trim();
  const res = resolveInternationalBank(currency, bankName);
  return res.code || null;
}

module.exports = {
  INTERNATIONAL_BANKS,
  getBanksForCurrency,
  resolveInternationalBank,
  enrichReceivingBankCode,
};
