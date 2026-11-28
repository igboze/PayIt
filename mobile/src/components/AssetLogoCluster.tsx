// Overlapping official asset logo clusters ("mergers") for Home & feature cards.
// Pure React Native — zero native modules, ships instantly over OTA.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { COLORS, FONTS, createThemeStyles } from "../theme";
import { CurrencyLogo } from "./CurrencyLogo";
import { StockLogo } from "./StockLogo";

const HOME_STOCK_LOGOS = [
  {
    ticker: "AAPL",
    logoUrl: "https://assets.parqet.com/logos/symbol/AAPL?format=png",
    fallbackLogoUrl: "https://www.google.com/s2/favicons?domain=apple.com&sz=128",
  },
  {
    ticker: "NVDA",
    logoUrl: "https://assets.parqet.com/logos/symbol/NVDA?format=png",
    fallbackLogoUrl: "https://www.google.com/s2/favicons?domain=nvidia.com&sz=128",
  },
  {
    ticker: "TSLA",
    logoUrl: "https://assets.parqet.com/logos/symbol/TSLA?format=png",
    fallbackLogoUrl: "https://www.google.com/s2/favicons?domain=tesla.com&sz=128",
  },
  {
    ticker: "MSFT",
    logoUrl: "https://assets.parqet.com/logos/symbol/MSFT?format=png",
    fallbackLogoUrl: "https://www.google.com/s2/favicons?domain=microsoft.com&sz=128",
  },
];

const HOME_SAVINGS_ASSETS = ["USDC", "EURC", "MORPHO"] as const;

/**
 * Overlapping merger of top US stock logos (Apple, NVIDIA, Tesla, Microsoft) + count badge.
 */
export function StockLogoMerger({ size = 28, showCount = true }: { size?: number; showCount?: boolean }) {
  const overlap = Math.round(size * 0.34);
  return (
    <View style={styles.row}>
      {HOME_STOCK_LOGOS.map((item, idx) => (
        <View
          key={item.ticker}
          style={[
            styles.halo,
            {
              width: size + 4,
              height: size + 4,
              borderRadius: Math.round((size + 4) * 0.34),
              marginLeft: idx === 0 ? 0 : -overlap,
              zIndex: HOME_STOCK_LOGOS.length - idx,
            },
          ]}
        >
          <StockLogo
            ticker={item.ticker}
            logoUrl={item.logoUrl}
            fallbackLogoUrl={item.fallbackLogoUrl}
            size={size}
          />
        </View>
      ))}
      {showCount ? (
        <View style={[styles.countPill, { marginLeft: -Math.round(overlap * 0.6), zIndex: 0 }]}>
          <Text style={styles.countText}>+470</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Overlapping merger of savings asset logos (USDC, EURC, Morpho) + yield badge.
 */
export function SavingsLogoMerger({ size = 28, showBadge = true }: { size?: number; showBadge?: boolean }) {
  const overlap = Math.round(size * 0.32);
  return (
    <View style={styles.row}>
      {HOME_SAVINGS_ASSETS.map((code, idx) => (
        <View
          key={code}
          style={[
            styles.roundHalo,
            {
              width: size + 4,
              height: size + 4,
              borderRadius: (size + 4) / 2,
              marginLeft: idx === 0 ? 0 : -overlap,
              zIndex: HOME_SAVINGS_ASSETS.length - idx,
            },
          ]}
        >
          <CurrencyLogo code={code} size={size} />
        </View>
      ))}
      {showBadge ? (
        <View style={[styles.apyPill, { marginLeft: 6 }]}>
          <Text style={styles.apyText}>APY</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = createThemeStyles(() => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  halo: {
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.surface,
    shadowColor: "#0E1512",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  roundHalo: {
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.surface,
    shadowColor: "#0E1512",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  countPill: {
    backgroundColor: "rgba(29, 78, 216, 0.12)",
    borderWidth: 1.5,
    borderColor: COLORS.surface,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  countText: {
    fontFamily: FONTS.extrabold,
    fontSize: 10,
    color: "#1D4ED8",
  },
  apyPill: {
    backgroundColor: "rgba(15, 118, 110, 0.12)",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  apyText: {
    fontFamily: FONTS.extrabold,
    fontSize: 10,
    color: "#0F766E",
  },
}));
