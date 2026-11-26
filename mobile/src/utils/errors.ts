/**
 * Converts any thrown error, API response message, or native exception into a
 * clean, calm, user-facing message. Never leaks stack traces, HTTP codes,
 * developer instructions, provider/vendor names, or raw blockchain/SQL errors.
 */

const TECHNICAL_PATTERNS: Array<[RegExp, string]> = [
  // Passkey / biometric cancellation
  [/user.?cancel|cancelled|canceled|abort.*cred|dismissed/i, "Verification was cancelled."],
  // Passkey / Credential Manager native errors
  [
    /NoCredentialException|no.?credential|no passkey|not.?found.*credential/i,
    "No passkey was found on this device. Try signing in another way or setting up your passkey again.",
  ],
  [
    /CreateCredential|GetCredential|androidx\.credentials|ASAuthorization|WebAuthn|assetlinks|associated.?domain|APP_ANDROID_CERT|APP_ORIGINS|npx eas|passkey.*unavailable|not.?configured/i,
    "Couldn't verify your passkey right now. Make sure screen lock is enabled on your phone and try again.",
  ],
  // Network / connectivity / timeouts
  [
    /network request failed|failed to fetch|network.?error|abort.?error|timed?.?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|offline/i,
    "Couldn't connect to Proxim. Check your internet connection and try again.",
  ],
  // HTML / JSON parse errors from upstream gateways
  [
    /JSON Parse error|Unexpected token|Unexpected character|Unexpected end of JSON|SyntaxError/i,
    "Proxim is temporarily busy. Please try again in a moment.",
  ],
  // Raw HTTP 5xx / gateway errors
  [
    /Request failed \(5\d\d\)|HTTP 5\d\d|status code 5\d\d|Bad Gateway|Service Unavailable|Gateway Timeout/i,
    "Proxim is temporarily unavailable. Please try again in a moment.",
  ],
  // Raw HTTP 4xx fallback
  [/^Request failed \(\d+\)$/i, "Something went wrong. Please try again."],
  // Insufficient funds / gas / on-chain balance errors
  [
    /INSUFFICIENT_FUNDS|insufficient funds|intrinsic transaction cost|transfer amount exceeds|exceeds balance|not enough.*(usdc|sol|eth|gas|lamports)/i,
    "Your available balance is too low to complete this transaction.",
  ],
  // Generic blockchain / RPC / smart contract errors
  [
    /CALL_EXCEPTION|NONCE_EXPIRED|REPLACEMENT_UNDERPRICED|UNPREDICTABLE_GAS|execution reverted|missing revert data|JsonRpcProvider|could not coalesce|Simulation failed|blockhash|Transaction reverted|Relay quote failed|CCTP|bundler|paymaster|UserOp|ethers/i,
    "We couldn't complete this transaction right now. Your funds are safe — please try again shortly.",
  ],
  // Database / JS runtime / stack traces
  [
    /SqliteError|SQLITE_|TypeError:|ReferenceError:|RangeError:|Cannot read propert|undefined is not|null is not|is not a function|is not an object|stack trace|\bat\s+[A-Za-z0-9_$.]+\s*\(/i,
    "Something went wrong on our end. Please try again.",
  ],
  // Backend schema validation developer wording
  [
    /^Missing or invalid field:\s*(.+)$/i,
    "Please check the details you entered and try again.",
  ],
  [
    /X-Proxim-Account must be/i,
    "Please switch accounts and try again.",
  ],
];

const INTERNAL_JARGON_RE =
  /(?:0x[a-fA-F0-9]{24,}|https?:\/\/[^\s]+|code=[A-Z_]+|status=\d{3}|Railway|Alchemy|Paj\b|PAJ\b|Circle\b|1Click|NEAR Intents|ExponentImagePicker|TurboModule|NativeModules)/i;

export function isCancelledError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /cancel|dismissed/i.test(raw);
}

export function toUserError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message?: unknown }).message || "")
          : "";

  let msg = raw.trim();
  if (!msg) return fallback;

  // Strip leading JS error class prefixes like "Error: " or "ApiError: "
  msg = msg.replace(/^(?:[A-Za-z]*Error|Exception):\s*/i, "").trim();

  // Keep only the first line so multi-line stack traces never render
  if (msg.includes("\n")) {
    const firstLine = msg.split("\n")[0].trim();
    if (firstLine) msg = firstLine;
  }

  for (const [pattern, friendly] of TECHNICAL_PATTERNS) {
    if (pattern.test(msg)) return friendly;
  }

  // Always replace internal partner brand names
  msg = msg.replace(/nuvion/gi, "Global Neobank");

  // If the string still contains raw addresses, URLs, error codes, or is suspiciously long JSON/code
  if (
    INTERNAL_JARGON_RE.test(msg) ||
    msg.startsWith("{") ||
    msg.startsWith("[") ||
    msg.startsWith("<") ||
    msg.length > 220
  ) {
    return fallback;
  }

  return msg;
}
