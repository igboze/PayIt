import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type { SavingsOverview } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ForestHero,
  formatUsdc,
  Input,
  KeyValueRow,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { SavingsLogoMerger } from "../components/AssetLogoCluster";
import { PressableScale } from "../components/Touch";

function formatCompactTvl(tvl?: number): string | null {
  const n = Number(tvl || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M TVL`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K TVL`;
  return `$${Math.round(n)} TVL`;
}

export function SavingsScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, dataVersion, refreshMe, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";

  const [savings, setSavings] = useState<SavingsOverview | null>(null);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [saveAmt, setSaveAmt] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [togglingAutoSave, setTogglingAutoSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSavings = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.getSavings(activeAccount);
        setSavings(res);
        setSelectedVault((prev) => {
          const pools = res.pools || [];
          if (prev && pools.some((p) => p.vaultAddress && p.vaultAddress.toLowerCase() === prev.toLowerCase())) {
            return prev;
          }
          const top = pools.find((p) => p.isHighestApy && p.vaultAddress) || pools.find((p) => p.vaultAddress);
          return top?.vaultAddress || null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load savings right now.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    loadSavings(false);
  }, [loadSavings, dataVersion]);

  const pools = savings?.pools || [];
  const activePool =
    pools.find((p) => p.vaultAddress && selectedVault && p.vaultAddress.toLowerCase() === selectedVault.toLowerCase()) ||
    null;

  const handleDeposit = async () => {
    setError(null);
    setNotice(null);
    if (!activePool || !activePool.vaultAddress) {
      setError("Select a savings type above before depositing.");
      return;
    }
    const amount = Number(saveAmt);
    if (!Number.isFinite(amount) || amount < 1) {
      setError("Enter a deposit amount of at least $1.00 USDC.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await requestApproval("savings.deposit", {
        accountType: activeAccount,
        amountUsdc: amount,
        vaultAddress: activePool.vaultAddress,
      });
      setNotice(res.notice || `Deposited into ${activePool.name}!`);
      setSaveAmt("");
      loadSavings(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Savings deposit failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await requestApproval("savings.withdraw", { accountType: activeAccount });
      setNotice(res.notice || "Withdrew savings back to your balance!");
      loadSavings(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Savings withdrawal failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const applyAutoSaveToggle = async (nextVal: boolean) => {
    setError(null);
    setNotice(null);
    setTogglingAutoSave(true);
    try {
      await api.updateProfile({ autoEarnEnabled: nextVal });
      await refreshMe();
      setSavings((prev) => (prev ? { ...prev, autoEarnEnabled: nextVal } : prev));
      setNotice(
        nextVal
          ? "Auto-Save is now ON. Eligible idle balances will convert to USD at live FX rates and earn daily yield."
          : "Auto-Save is now OFF. Your funds will stay in your balances without auto-converting."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update Auto-Save right now.");
    } finally {
      setTogglingAutoSave(false);
    }
  };

  const handleToggleAutoSave = (nextVal: boolean) => {
    if (!nextVal) {
      applyAutoSaveToggle(false);
      return;
    }
    Alert.alert(
      "Turn On USD Auto-Save?",
      "Dollar Savings is in USD and live FX rates apply.\n\nWhen your savings period is due, any idle local currency balances (NGN, GBP, EUR, etc.) will automatically convert to USD at the live FX rate (0% conversion fee) and move into the highest-APY Dollar Savings vault. You can withdraw or turn this off anytime.",
      [
        { text: "Not now", style: "cancel" },
        { text: "I Understand, Turn On", onPress: () => applyAutoSaveToggle(true) },
      ]
    );
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Dollar Savings"
        subtitle={`${isBiz ? "Business" : "Personal"} yield vaults · Withdraw anytime`}
        onBack={onBack}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => loadSavings(true)} tintColor={COLORS.primary} />
        }
        keyboardShouldPersistTaps="handled"
      >
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {loading && !savings ? (
          <View style={{ paddingVertical: 36, alignItems: "center" }}>
            <ActivityIndicator color={COLORS.primary} />
          </View>
        ) : (
          <>
            {/* Active savings position */}
            {savings?.position ? (
              <ForestHero
                overline={`${isBiz ? "Business" : "Personal"} savings`}
                amount={balanceHidden ? "$••••" : formatUsdc(savings.position.principalUsdc)}
                sub={balanceHidden ? "Balance hidden" : `+${formatUsdc(savings.position.accruedYieldUsdc, 4)} earned so far`}
              >
                <View style={styles.rateChip}>
                  <Ionicons name="trending-up" size={13} color={COLORS.onGold} />
                  <Text style={styles.rateChipText}>
                    {(savings.position.currentApy ?? savings.position.apyAtDeposit ?? savings.position.apy) > 0
                      ? `${(savings.position.currentApy ?? savings.position.apyAtDeposit ?? savings.position.apy).toFixed(2)}% APY · Variable`
                      : "Variable rate"}
                  </Text>
                </View>
              </ForestHero>
            ) : null}
            <Card>
              {savings?.position ? (
                <>
                  {savings.position.vaultName ? (
                    <KeyValueRow label="Savings vault" value={savings.position.vaultName} />
                  ) : null}
                  {savings.position.currentApy != null && savings.position.currentApy > 0 ? (
                    <KeyValueRow label="Current vault rate" value={`${savings.position.currentApy.toFixed(2)}% APY`} />
                  ) : null}
                  {savings.position.isAutoEarn ? (
                    <KeyValueRow label="Added by" value="Auto-save (highest APY)" />
                  ) : null}
                  <Button
                    title="Move all to balance"
                    variant="secondary"
                    onPress={handleWithdraw}
                    loading={submitting}
                    style={{ marginTop: 14 }}
                  />
                </>
              ) : (
                <EmptyState
                  icon="trending-up-outline"
                  title="No active savings yet"
                  subtitle="Choose a savings vault below to start earning interest. Withdraw anytime with zero lockups."
                />
              )}
            </Card>

            {/* Auto-Save interactive toggle banner */}
            <View style={styles.autoSaveBanner}>
              <View style={{ paddingTop: 2 }}>
                <SavingsLogoMerger size={24} showBadge={false} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.autoSaveTitle}>
                  Auto-Save {savings?.autoEarnEnabled ? "is ON" : "is OFF"}
                </Text>
                <Text style={styles.autoSaveSub}>
                  {savings?.autoEarnEnabled
                    ? "Idle balances automatically convert to USD at live FX rates and earn in the highest-APY vault."
                    : "Dollar Savings is in USD and live FX rates apply. Turn on to automatically save idle balances."}
                </Text>
              </View>
              <Switch
                value={Boolean(savings?.autoEarnEnabled)}
                onValueChange={handleToggleAutoSave}
                disabled={togglingAutoSave}
                trackColor={{ true: COLORS.primary, false: COLORS.borderStrong }}
              />
            </View>

            {/* Step 1: Selectable savings vault cards */}
            {pools.length > 0 ? (
              <Card>
                <SectionHeader title="1. Choose your savings type" />
                <Text style={styles.selectHint}>
                  Tap the vault you want to deposit into. Rates and earnings shown are net of service fees.
                </Text>
                <View style={{ gap: 10 }}>
                  {pools.map((p, i) => {
                    const isSelected = Boolean(
                      p.vaultAddress && selectedVault && p.vaultAddress.toLowerCase() === selectedVault.toLowerCase()
                    );
                    const tvlLabel = formatCompactTvl(p.tvlUsd);
                    return (
                      <PressableScale
                        key={`${p.vaultAddress || p.name}-${i}`}
                        onPress={() => p.vaultAddress && setSelectedVault(p.vaultAddress)}
                        haptic="selection"
                        depth={0.98}
                        style={[styles.poolCard, isSelected && styles.poolCardSelected]}
                      >
                        <CurrencyLogo code={p.symbol || "USDC"} size={36} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={styles.poolTitleRow}>
                            <Text style={styles.poolName} numberOfLines={1}>
                              {p.name}
                            </Text>
                          </View>
                          <View style={styles.poolMetaRow}>
                            <Text style={styles.poolMeta}>
                              {p.symbol}
                              {tvlLabel ? ` · ${tvlLabel}` : ""}
                            </Text>
                            {p.isHighestApy ? (
                              <View style={styles.topBadge}>
                                <Text style={styles.topBadgeText}>Highest APY · Auto-Save</Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                        <View style={{ alignItems: "flex-end", gap: 4 }}>
                          <Text style={styles.poolApy}>{p.apy > 0 ? `${p.apy.toFixed(2)}%` : "Active"}</Text>
                          <Text style={styles.poolApySub}>APY</Text>
                        </View>
                        <View style={[styles.radio, isSelected && styles.radioOn]}>
                          {isSelected ? <Ionicons name="checkmark" size={14} color={COLORS.onPrimary} /> : null}
                        </View>
                      </PressableScale>
                    );
                  })}
                </View>
              </Card>
            ) : null}

            {/* Step 2: Deposit amount */}
            <Card>
              <SectionHeader title="2. Deposit into Savings" />
              {activePool ? (
                <View style={styles.chosenSummary}>
                  <Text style={styles.chosenLabel}>Selected vault</Text>
                  <Text style={styles.chosenVal}>
                    {activePool.name} ({activePool.apy.toFixed(2)}% APY)
                  </Text>
                </View>
              ) : null}
              <Input
                label="Amount (USD)"
                placeholder="e.g. 50"
                value={saveAmt}
                onChangeText={(t) => setSaveAmt(t.replace(/[^\d.]/g, ""))}
                keyboardType="decimal-pad"
                hint="Minimum $1.00. Withdraw anytime with zero lockups."
              />
              <Button
                title={activePool ? `Deposit into ${activePool.name}` : "Select a vault above"}
                onPress={handleDeposit}
                loading={submitting}
                disabled={!activePool}
              />
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40, gap: 12 },
  rateChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: COLORS.gold,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rateChipText: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.onGold },
  autoSaveBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    borderRadius: RADIUS.md,
    padding: 12,
  },
  autoSaveTitle: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.primaryDark },
  autoSaveSub: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, marginTop: 2, lineHeight: 17 },
  selectHint: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, marginBottom: 10 },
  poolCard: {
    ...DEPTH.raised,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.page,
  },
  poolCardSelected: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    backgroundColor: COLORS.deep,
  },
  poolTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  poolName: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text, flexShrink: 1 },
  poolMetaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 },
  poolMeta: { fontFamily: FONTS.medium, fontSize: 11, color: COLORS.textSecondary },
  topBadge: {
    backgroundColor: COLORS.primaryMuted,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  topBadgeText: { fontFamily: FONTS.bold, fontSize: 10, color: COLORS.primaryDark },
  poolApy: { fontFamily: FONTS.extrabold, fontSize: 15, color: COLORS.primaryDark },
  poolApySub: { fontFamily: FONTS.medium, fontSize: 10, color: COLORS.textMuted, marginTop: -4 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chosenSummary: {
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    padding: 10,
    marginBottom: 12,
  },
  chosenLabel: { fontFamily: FONTS.semibold, fontSize: 11, color: COLORS.textMuted, textTransform: "uppercase" },
  chosenVal: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.text, marginTop: 2 },
});
