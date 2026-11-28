import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type { SwapPairRate, UnifiedBalance } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TABULAR_NUMS, TYPE, createThemeStyles } from "../theme";
import {
  Button,
  Card,
  ErrorBanner,
  KeyValueRow,
  ScreenHeader,
  SkeletonCard,
  StatusBadge,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";

export function SwapScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, dataVersion, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";

  const [pair, setPair] = useState<SwapPairRate | null>(null);
  const [balance, setBalance] = useState<UnifiedBalance | null>(null);
  const [swapDir, setSwapDir] = useState<"USDC_EURC" | "EURC_USDC">("USDC_EURC");
  const [swapAmt, setSwapAmt] = useState("");
  const [quote, setQuote] = useState<{ amountOut?: string; protocolFee?: string } | null>(null);
  const [loadingRates, setLoadingRates] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const quoteReqId = useRef(0);

  const tokenIn: "USDC" | "EURC" = swapDir === "USDC_EURC" ? "USDC" : "EURC";
  const tokenOut: "USDC" | "EURC" = swapDir === "USDC_EURC" ? "EURC" : "USDC";
  const curIn = swapDir === "USDC_EURC" ? "USD" : "EUR";
  const curOut = swapDir === "USDC_EURC" ? "EUR" : "USD";
  const symIn = curIn === "USD" ? "$" : "€";
  const symOut = curOut === "USD" ? "$" : "€";

  const availableIn =
    swapDir === "USDC_EURC"
      ? Number(balance?.totalUsdc ?? 0)
      : Number(balance?.arc?.eurc ?? 0);

  const loadRates = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoadingRates(true);
      setError(null);
      try {
        const [rateRes, balRes] = await Promise.all([
          api.getSwapRates().catch(() => null),
          api.getBalances(activeAccount).catch(() => null),
        ]);
        setPair(rateRes?.pair || null);
        if (balRes) setBalance(balRes);
      } finally {
        setLoadingRates(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    loadRates(false);
  }, [loadRates, dataVersion]);

  // Live debounced auto-quote as the user types (no manual "Get Live Quote" button needed)
  useEffect(() => {
    const amt = Number(swapAmt);
    if (!Number.isFinite(amt) || amt < 1) {
      setQuote(null);
      setQuoting(false);
      return;
    }
    const id = ++quoteReqId.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.quoteSwap(tokenIn, tokenOut, amt);
        if (quoteReqId.current !== id) return;
        const q = (res.quote || {}) as { amountOut?: string; destinationAmount?: string; protocolFee?: string };
        setQuote({
          amountOut: String(q.amountOut || q.destinationAmount || ""),
          protocolFee: q.protocolFee ? String(q.protocolFee) : undefined,
        });
      } catch {
        if (quoteReqId.current === id) setQuote(null);
      } finally {
        if (quoteReqId.current === id) setQuoting(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [swapAmt, tokenIn, tokenOut]);

  const handleFlip = () => {
    setSwapDir((prev) => (prev === "USDC_EURC" ? "EURC_USDC" : "USDC_EURC"));
    setQuote(null);
    setError(null);
  };

  const handleSetMax = () => {
    if (!Number.isFinite(availableIn) || availableIn <= 0) return;
    const floored = Math.floor(availableIn * 100) / 100;
    setSwapAmt(floored > 0 ? String(floored) : "");
  };

  const handleExecuteSwap = async () => {
    setError(null);
    setNotice(null);
    const amt = Number(swapAmt);
    if (!Number.isFinite(amt) || amt < 1) {
      setError(`Enter at least ${symIn}1.00 to convert.`);
      return;
    }
    setSwapping(true);
    try {
      const res = await requestApproval("swap.execute", {
        accountType: activeAccount,
        tokenIn,
        tokenOut,
        amountIn: amt,
      });
      setNotice(res.notice || `Converted ${symIn}${amt.toFixed(2)} ${curIn} to ${curOut}.`);
      setSwapAmt("");
      setQuote(null);
      loadRates(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Conversion failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSwapping(false);
    }
  };

  const activeRate = swapDir === "USDC_EURC" ? pair?.usdcToEurc : pair?.eurcToUsdc;
  const numAmt = Number(swapAmt);
  const estPreview =
    activeRate && Number.isFinite(numAmt) && numAmt > 0 ? (numAmt * activeRate).toFixed(2) : null;
  const displayOut = quote?.amountOut
    ? Number(quote.amountOut).toFixed(2)
    : estPreview || "0.00";

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Convert Currency"
        subtitle={`${isBiz ? "Business" : "Personal"} · Instant USD ↔ EUR`}
        onBack={onBack}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => loadRates(true)} tintColor={COLORS.primary} />
        }
        keyboardShouldPersistTaps="handled"
      >
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {loadingRates && !pair && !balance ? (
          <SkeletonCard rows={3} />
        ) : (
          <>
            {/* Live FX pill header */}
            {activeRate ? (
              <View style={styles.ratePillRow}>
                <StatusBadge
                  icon="pulse"
                  tone="success"
                  label={`1 ${curIn} = ${activeRate.toFixed(4)} ${curOut}`}
                />
                <StatusBadge icon="flash" tone="neutral" label="Instant" />
              </View>
            ) : null}

            {/* Dual Converter Stack */}
            <View style={styles.converterStack}>
              {/* FROM box */}
              <View style={styles.legCard}>
                <View style={styles.legTop}>
                  <Text style={styles.legLabel}>You convert</Text>
                  <View style={styles.balRow}>
                    <Text style={styles.balHint}>
                      Balance: {balanceHidden ? "••••" : `${symIn}${availableIn.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </Text>
                    {availableIn >= 1 ? (
                      <PressableScale onPress={handleSetMax} haptic="selection" style={styles.maxPill}>
                        <Text style={styles.maxPillText}>Max</Text>
                      </PressableScale>
                    ) : null}
                  </View>
                </View>

                <View style={styles.legMain}>
                  <View style={styles.curBadge}>
                    <CurrencyLogo code={curIn} size={24} />
                    <Text style={styles.curCode}>{curIn}</Text>
                  </View>
                  <TextInput
                    style={styles.amountInput}
                    value={swapAmt}
                    onChangeText={(t) => {
                      const clean = t.replace(/[^\d.]/g, "");
                      const parts = clean.split(".");
                      setSwapAmt(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : clean);
                    }}
                    placeholder="0.00"
                    placeholderTextColor={COLORS.textMuted}
                    keyboardType="decimal-pad"
                    selectionColor={COLORS.primary}
                  />
                </View>
              </View>

              {/* Floating Flip Button */}
              <View style={styles.flipAnchor}>
                <PressableScale
                  onPress={handleFlip}
                  haptic="selection"
                  depth={0.92}
                  style={styles.flipBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Swap currency direction"
                >
                  <Ionicons name="swap-vertical" size={18} color={COLORS.primary} />
                </PressableScale>
              </View>

              {/* TO box */}
              <View style={[styles.legCard, styles.legCardOut]}>
                <View style={styles.legTop}>
                  <Text style={styles.legLabel}>You receive</Text>
                  {quoting ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <ActivityIndicator size="small" color={COLORS.primary} />
                      <Text style={styles.balHint}>Updating quote…</Text>
                    </View>
                  ) : quote?.amountOut ? (
                    <Text style={[styles.balHint, { color: COLORS.successText }]}>Live quote locked</Text>
                  ) : (
                    <Text style={styles.balHint}>Estimated</Text>
                  )}
                </View>

                <View style={styles.legMain}>
                  <View style={styles.curBadge}>
                    <CurrencyLogo code={curOut} size={24} />
                    <Text style={styles.curCode}>{curOut}</Text>
                  </View>
                  <Text
                    style={[
                      styles.amountOut,
                      (!swapAmt || numAmt <= 0) && { color: COLORS.textMuted },
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {symOut}
                    {displayOut}
                  </Text>
                </View>
              </View>
            </View>

            {/* Quick amount presets */}
            <View style={styles.presetRow}>
              {[10, 25, 50, 100, 250].map((v) => (
                <PressableScale
                  key={v}
                  onPress={() => setSwapAmt(String(v))}
                  haptic="selection"
                  style={[styles.presetChip, numAmt === v && styles.presetChipOn]}
                >
                  <Text style={[styles.presetText, numAmt === v && styles.presetTextOn]}>
                    {symIn}
                    {v}
                  </Text>
                </PressableScale>
              ))}
            </View>

            {/* Breakdown card */}
            <Card>
              <KeyValueRow
                currency={false}
                label="Exchange rate"
                value={activeRate ? `1 ${curIn} = ${activeRate.toFixed(4)} ${curOut}` : "Calculated at confirmation"}
              />
              <KeyValueRow
                currency={false}
                label="Conversion fee"
                value={
                  quote?.protocolFee
                    ? `${symOut}${Number(quote.protocolFee).toFixed(2)}`
                    : pair?.feePct != null
                      ? `${pair.feePct}%`
                      : "Included in quote"
                }
              />
              <KeyValueRow currency={false} label="Settlement" value="Instant" />
            </Card>

            <Button
              title={
                numAmt >= 1
                  ? `Convert ${symIn}${numAmt.toFixed(2)} ${curIn} → ${symOut}${displayOut} ${curOut}`
                  : `Convert ${curIn} → ${curOut}`
              }
              onPress={handleExecuteSwap}
              loading={swapping}
              disabled={!Number.isFinite(numAmt) || numAmt < 1}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = createThemeStyles(() => ({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  ratePillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  converterStack: {
    marginBottom: 12,
  },
  legCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: 16,
    gap: 12,
    ...DEPTH.card,
  },
  legCardOut: {
    marginTop: 6,
    backgroundColor: COLORS.surface,
  },
  legTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  legLabel: {
    ...TYPE.overline,
    fontSize: 10.5,
    color: COLORS.textMuted,
  },
  balRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  balHint: {
    ...TYPE.label,
    ...TABULAR_NUMS,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  maxPill: {
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  maxPillText: {
    fontFamily: FONTS.bold,
    fontSize: 11,
    color: COLORS.primary,
  },
  legMain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  curBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.page,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.pill,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 6,
  },
  curCode: {
    fontFamily: FONTS.extrabold,
    fontSize: 14,
    color: COLORS.text,
  },
  amountInput: {
    flex: 1,
    textAlign: "right",
    fontFamily: FONTS.extrabold,
    fontSize: 28,
    color: COLORS.text,
    ...TABULAR_NUMS,
    paddingVertical: 2,
  },
  amountOut: {
    flex: 1,
    textAlign: "right",
    fontFamily: FONTS.extrabold,
    fontSize: 28,
    color: COLORS.text,
    ...TABULAR_NUMS,
  },
  flipAnchor: {
    alignItems: "center",
    marginVertical: -16,
    zIndex: 4,
  },
  flipBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  presetRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 14,
  },
  presetChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
  },
  presetChipOn: {
    backgroundColor: COLORS.primaryMuted,
    borderColor: COLORS.primary,
  },
  presetText: {
    fontFamily: FONTS.bold,
    fontSize: 12,
    ...TABULAR_NUMS,
    color: COLORS.textSecondary,
  },
  presetTextOn: {
    color: COLORS.primary,
  },
}));
