// Official company logo badge for US stocks & ETFs.
// Loads the crisp official brand logo first (Parqet symbol PNG), falls back to the company's
// official website favicon, and finally falls back to a styled ticker emblem if offline.
import React, { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { COLORS, FONTS } from "../theme";

const TICKER_TINTS: Record<string, { bg: string; fg: string }> = {
  AAPL: { bg: "#111827", fg: "#FFFFFF" },
  NVDA: { bg: "#76B900", fg: "#FFFFFF" },
  TSLA: { bg: "#CC0000", fg: "#FFFFFF" },
  MSFT: { bg: "#0078D4", fg: "#FFFFFF" },
  AMZN: { bg: "#FF9900", fg: "#111827" },
  GOOGL: { bg: "#4285F4", fg: "#FFFFFF" },
  META: { bg: "#0668E1", fg: "#FFFFFF" },
  SPY: { bg: "#047857", fg: "#FFFFFF" },
  QQQ: { bg: "#1D4ED8", fg: "#FFFFFF" },
  NFLX: { bg: "#E50914", fg: "#FFFFFF" },
  COIN: { bg: "#0052FF", fg: "#FFFFFF" },
  AMD: { bg: "#111827", fg: "#FFFFFF" },
};

export function StockLogo({
  ticker,
  logoUrl,
  fallbackLogoUrl,
  size = 42,
}: {
  ticker: string;
  logoUrl?: string | null;
  fallbackLogoUrl?: string | null;
  size?: number;
}) {
  const clean = String(ticker || "").toUpperCase();
  const [stage, setStage] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    setStage(0);
  }, [clean, logoUrl, fallbackLogoUrl]);

  const activeUri = stage === 0 ? logoUrl : stage === 1 ? fallbackLogoUrl : null;
  const radius = Math.round(size * 0.28);

  if (activeUri) {
    return (
      <View style={[styles.frame, { width: size, height: size, borderRadius: radius }]}>
        <Image
          source={{ uri: activeUri }}
          style={{ width: Math.round(size * 0.78), height: Math.round(size * 0.78), borderRadius: Math.round(size * 0.16) }}
          resizeMode="contain"
          onError={() => {
            if (stage === 0 && fallbackLogoUrl) setStage(1);
            else setStage(2);
          }}
        />
      </View>
    );
  }

  const tint = TICKER_TINTS[clean] || { bg: COLORS.surfaceElevated, fg: COLORS.text };
  return (
    <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, backgroundColor: tint.bg }]}>
      <Text style={[styles.tickerText, { color: tint.fg, fontSize: Math.max(10, Math.round(size * 0.28)) }]} numberOfLines={1}>
        {clean.slice(0, 4)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tickerText: {
    fontFamily: FONTS.extrabold,
    letterSpacing: -0.3,
  },
});
