import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { SwapPairRate } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING, FONTS } from "../theme";
import {
  Button,
  Card,
  ErrorBanner,
  Input,
  KeyValueRow,
  Pill,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";

export function SwapScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, requestApproval } = useApp();
  const isBiz = activeAccount === "business";

  const [pair, setPair] = useState<SwapPairRate | null>(null);
  const [swapDir, setSwapDir] = useState<"USDC_EURC" | "EURC_USDC">("USDC_EURC");
  const [swapAmt, setSwapAmt] = useState("");
  const [quote, setQuote] = useState<{ amountOut?: string; protocolFee?: string } | null>(null);
  const [loadingRates, setLoadingRates] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tokenIn: "USDC" | "EURC" = swapDir === "USDC_EURC" ? "USDC" : "EURC";
  const tokenOut: "USDC" | "EURC" = swapDir === "USDC_EURC" ? "EURC" : "USDC";

  const loadRates = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoadingRates(true);
    setError(null);
    try {
      const res = await api.getSwapRates();
      if (res.pair) {
        setPair(res.pair);
      } else {
        setPair(null);
      }
    } catch {
      // Do not block swapping if live rate banner temporarily fails — quote still works on demand
      setPair(null);
    } finally {
      setLoadingRates(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadRates(false);
  }, [loadRates]);

  const handleGetQuote = async () => {
    setError(null);
    setNotice(null);
    setQuote(null);
    const amt = Number(swapAmt);
    if (!Number.isFinite(amt) || amt < 1) {
      setError(`Enter at least 1 ${tokenIn} to get a live quote.`);
      return;
    }
    setQuoting(true);
    try {
      const res = await api.quoteSwap(tokenIn, tokenOut, amt);
      const q = (res.quote || {}) as { amountOut?: string; destinationAmount?: string; protocolFee?: string };
      setQuote({
        amountOut: String(q.amountOut || q.destinationAmount || ""),
        protocolFee: q.protocolFee ? String(q.protocolFee) : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get a live swap quote right now.");
    } finally {
      setQuoting(false);
    }
  };

  const handleExecuteSwap = async () => {
    setError(null);
    setNotice(null);
    const amt = Number(swapAmt);
    if (!Number.isFinite(amt) || amt < 1) {
      setError(`Enter at least 1 ${tokenIn} to swap.`);
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
      setNotice(res.notice || `Swapped ${amt} ${tokenIn} to ${tokenOut}!`);
      setSwapAmt("");
      setQuote(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSwapping(false);
    }
  };

  const activeRate = swapDir === "USDC_EURC" ? pair?.usdcToEurc : pair?.eurcToUsdc;
  const estPreview =
    activeRate && Number(swapAmt) >= 1 ? (Number(swapAmt) * activeRate).toFixed(4) : null;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Currency Swap"
        subtitle={`${isBiz ? "Business" : "Personal"} wallet · Instant USDC ↔ EURC`}
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

        <Card>
          <SectionHeader title="Live FX Rate" />
          {loadingRates ? (
            <View style={styles.rateLoading}>
              <ActivityIndicator size="small" color={COLORS.primary} />
              <Text style={styles.muted}>Getting the live rate…</Text>
            </View>
          ) : pair?.usdcToEurc ? (
            <>
              <KeyValueRow currency="USD" label="$1" value={`≈ €${pair.usdcToEurc.toFixed(4)}`} />
              <KeyValueRow currency="EUR" label="€1" value={`≈ $${(pair.eurcToUsdc || 0).toFixed(4)}`} />
              <KeyValueRow label="Swap Fee" value={`${pair.feePct}%`} />
            </>
          ) : (
            <Text style={styles.muted}>Enter an amount to see a live quote.</Text>
          )}
        </Card>

        <Card>
          <SectionHeader title="Convert Currency" />
          <View style={styles.pillRow}>
            <Pill
              label="Dollars → Euros"
              currency="USD"
              active={swapDir === "USDC_EURC"}
              onPress={() => {
                setSwapDir("USDC_EURC");
                setQuote(null);
              }}
            />
            <Pill
              label="Euros → Dollars"
              currency="EUR"
              active={swapDir === "EURC_USDC"}
              onPress={() => {
                setSwapDir("EURC_USDC");
                setQuote(null);
              }}
            />
          </View>

          <Input
            label={`You Send (${tokenIn})`}
            placeholder="e.g. 25"
            value={swapAmt}
            onChangeText={(t) => {
              setSwapAmt(t.replace(/[^\d.]/g, ""));
              setQuote(null);
            }}
            keyboardType="decimal-pad"
            hint={estPreview ? `Indicative output: ≈ ${estPreview} ${tokenOut} (before fee)` : `Minimum 1 ${tokenIn}`}
          />

          <Button
            title="Get Live Quote"
            variant="secondary"
            onPress={handleGetQuote}
            loading={quoting}
            style={{ marginBottom: 12 }}
          />

          {quote?.amountOut ? (
            <View style={styles.quoteBox}>
              <KeyValueRow label="You Receive" value={`${quote.amountOut} ${tokenOut}`} />
              {quote.protocolFee ? (
                <KeyValueRow label="Protocol Fee" value={`${quote.protocolFee} ${tokenOut}`} />
              ) : null}
            </View>
          ) : null}

          <Button title={`Review & Swap ${tokenIn} → ${tokenOut}`} onPress={handleExecuteSwap} loading={swapping} />
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  rateLoading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  muted: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 13 },
  pillRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  quoteBox: {
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 14,
  },
});
