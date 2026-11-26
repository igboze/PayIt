import React, { useEffect, useState } from "react";
import { Image, StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { COLORS, FONTS } from "../theme";

// Fiat currencies are shown with the issuing country's flag; EUR uses the EU flag.
const FIAT_COUNTRY: Record<string, string> = {
  USD: "us", NGN: "ng", GBP: "gb", EUR: "eu", CAD: "ca", AUD: "au", NZD: "nz", JPY: "jp",
  CNY: "cn", INR: "in", AED: "ae", SAR: "sa", QAR: "qa", KES: "ke", GHS: "gh", ZAR: "za",
  UGX: "ug", TZS: "tz", RWF: "rw", XOF: "sn", XAF: "cm", EGP: "eg", MAD: "ma", MXN: "mx",
  BRL: "br", ARS: "ar", COP: "co", CLP: "cl", PEN: "pe", CHF: "ch", SEK: "se", NOK: "no",
  DKK: "dk", PLN: "pl", CZK: "cz", HUF: "hu", RON: "ro", TRY: "tr", SGD: "sg", HKD: "hk",
  KRW: "kr", PHP: "ph", IDR: "id", MYR: "my", THB: "th", VND: "vn", PKR: "pk", BDT: "bd",
  ILS: "il",
};

// Verified official high-res token logos (used for savings assets, swaps, and crypto cards).
const VERIFIED_TOKEN_LOGOS: Record<string, string> = {
  USDC: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
  EURC: "https://assets.coingecko.com/coins/images/26045/small/euro-coin.png",
  USDT: "https://assets.coingecko.com/coins/images/325/small/Tether.png",
  MORPHO: "https://assets.coingecko.com/coins/images/29837/small/Morpho-token-icon.png",
  SOL: "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  ETH: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  BTC: "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  NEAR: "https://assets.coingecko.com/coins/images/10365/small/near.jpg",
};

// Token logos come from the same source the API uses (src/near.js TOKEN_LOGO_OVERRIDES).
const TOKEN_ALIASES: Record<string, string> = { WNEAR: "near", CBBTC: "btc", XBTC: "btc", POL: "matic" };

export function isFiat(code: string): boolean {
  return !!FIAT_COUNTRY[normalize(code)];
}

function normalize(code: string | null | undefined): string {
  return String(code || "").replace(/^\$/, "").trim().toUpperCase();
}

function flagEmoji(country: string): string {
  if (country === "eu") return "🇪🇺";
  return country.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

export function currencyLogoUrl(code: string): string | null {
  const c = normalize(code);
  if (VERIFIED_TOKEN_LOGOS[c]) return VERIFIED_TOKEN_LOGOS[c];
  const country = FIAT_COUNTRY[c];
  if (country) return `https://flagcdn.com/w80/${country}.png`;
  if (/^[A-Z0-9]{2,10}$/.test(c)) {
    return `https://assets.coincap.io/assets/icons/${(TOKEN_ALIASES[c] || c).toLowerCase()}@2x.png`;
  }
  return null;
}

/**
 * Round logo for a currency or token: a flag for fiat (NGN, USD, GBP…), the token's own
 * logo for crypto (USDC, EURC, SOL…). Pass `uri` when the API already gave a logo.
 * Falls back to the flag emoji, then to the code's letters, if the image can't load.
 */
export function CurrencyLogo({
  code,
  uri,
  size = 24,
  style,
}: {
  code: string;
  uri?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const c = normalize(code);
  const src = uri || currencyLogoUrl(c);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const box = { width: size, height: size, borderRadius: size / 2 };
  if (src && !failed) {
    return (
      <View style={[styles.frame, box, style]} accessibilityElementsHidden importantForAccessibility="no">
        <Image
          source={{ uri: src }}
          onError={() => setFailed(true)}
          style={[box, FIAT_COUNTRY[c] && !uri ? { width: size * 1.5, marginLeft: -size * 0.25 } : null]}
          resizeMode={FIAT_COUNTRY[c] && !uri ? "cover" : "contain"}
        />
      </View>
    );
  }
  const country = FIAT_COUNTRY[c];
  return (
    <View style={[styles.frame, styles.fallback, box, style]} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={{ fontSize: country ? size * 0.7 : Math.max(9, Math.round(size * 0.36)), color: COLORS.primary, fontFamily: FONTS.extrabold }}>
        {country ? flagEmoji(country) : c.slice(0, 3) || "?"}
      </Text>
    </View>
  );
}

/** Logo followed by the code (or a custom label): "[🇳🇬] NGN". */
export function CurrencyTag({
  code,
  label,
  uri,
  size = 18,
  color = COLORS.text,
}: {
  code: string;
  label?: string;
  uri?: string | null;
  size?: number;
  color?: string;
}) {
  return (
    <View style={styles.tag}>
      <CurrencyLogo code={code} uri={uri} size={size} />
      <Text style={[styles.tagText, { color, fontSize: Math.max(12, size * 0.8) }]}>{label ?? normalize(code)}</Text>
    </View>
  );
}

/** Finds the first currency/token code in a label like "Amount (USDC)". */
export function currencyInText(text: string | null | undefined): string | null {
  const m = String(text || "").match(/\b([A-Z]{3,5})\b/g) || [];
  for (const w of m) if (FIAT_COUNTRY[w] || KNOWN_TOKENS.has(w)) return w;
  return null;
}

const KNOWN_TOKENS = new Set(["USDC", "EURC", "USDT", "SOL", "NEAR", "ETH", "BTC", "STRK", "DAI", "BNB", "TRX", "TON", "SUI", "XRP"]);

const styles = StyleSheet.create({
  frame: { overflow: "hidden", backgroundColor: COLORS.surfaceElevated, alignItems: "center", justifyContent: "center" },
  fallback: { borderWidth: 1, borderColor: COLORS.primaryBorder, backgroundColor: COLORS.primaryMuted },
  tag: { flexDirection: "row", alignItems: "center", gap: 6 },
  tagText: { fontFamily: FONTS.semibold },
});
