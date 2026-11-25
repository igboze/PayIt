import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { SavingsOverview } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, SPACING, FONTS } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatUsdc,
  Input,
  KeyValueRow,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";

export function SavingsScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, dataVersion, requestApproval } = useApp();
  const isBiz = activeAccount === "business";

  const [savings, setSavings] = useState<SavingsOverview | null>(null);
  const [saveAmt, setSaveAmt] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const handleDeposit = async () => {
    setError(null);
    setNotice(null);
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
      });
      setNotice(res.notice || "Deposited into Dollar Savings!");
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

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Dollar Savings"
        subtitle={`${isBiz ? "Business" : "Personal"} yield vault · Withdraw anytime`}
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
            <Card>
              <SectionHeader title={`${isBiz ? "Business" : "Personal"} savings`} />
              {savings?.position ? (
                <>
                  <Text style={styles.bigVal}>{formatUsdc(savings.position.principalUsdc)}</Text>
                  <KeyValueRow
                    label="Earned so far"
                    value={`+${formatUsdc(savings.position.accruedYieldUsdc, 4)}`}
                  />
                  <KeyValueRow
                    label="Rate when you saved"
                    value={(savings.position.apyAtDeposit ?? savings.position.apy) > 0
                      ? `${(savings.position.apyAtDeposit ?? savings.position.apy).toFixed(2)}% a year`
                      : "Variable"}
                  />
                  {savings.position.currentApy != null && savings.position.currentApy > 0 ? (
                    <KeyValueRow label="Rate today" value={`${savings.position.currentApy.toFixed(2)}% a year`} />
                  ) : null}
                  {savings.position.isAutoEarn ? <KeyValueRow label="Added by" value="Auto-save (idle balance)" /> : null}
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
                  subtitle="Earn on your dollars and move them back to your balance anytime."
                />
              )}
            </Card>

            {savings?.pools && savings.pools.length > 0 ? (
              <Card>
                <SectionHeader title="Rates today" />
                {savings.pools.map((p, i) => (
                  <KeyValueRow
                    key={`${p.name}-${i}`}
                    label={p.name}
                    value={p.apy > 0 ? `${p.apy.toFixed(2)}% a year` : "Active"}
                  />
                ))}
              </Card>
            ) : null}

            <Card>
              <SectionHeader title="Deposit into Savings" />
              <Input
                label="Amount (USD)"
                placeholder="e.g. 50"
                value={saveAmt}
                onChangeText={(t) => setSaveAmt(t.replace(/[^\d.]/g, ""))}
                keyboardType="decimal-pad"
                hint="Minimum $1.00. Approved with your passkey and PIN."
              />
              <Button title="Review & Deposit" onPress={handleDeposit} loading={submitting} />
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  bigVal: { color: COLORS.text, fontSize: 34, fontFamily: FONTS.extrabold, marginBottom: 10 },
});
