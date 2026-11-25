import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import type { TransactionItem, UnifiedBalance } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, RADIUS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatRawTxAmount,
  formatUsdc,
  KeyValueRow,
  SectionHeader,
  shortAddr,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";

export type HomeModalTarget =
  | "add"
  | "send"
  | "bills"
  | "cards"
  | "savings"
  | "swap"
  | "assistant"
  | "global"
  | "kyc";

function friendlyTxKind(rawType: string): string {
  const t = String(rawType || "").toLowerCase();
  if (/deposit|onramp|receive|credit|claim|refund/.test(t)) return "Deposit";
  if (/offramp|withdraw|payout|cashout/.test(t)) return "Withdrawal";
  if (/bill/.test(t)) return "Bill Payment";
  if (/card/.test(t)) return "Card";
  if (/swap/.test(t)) return "Swap";
  if (/saving|yield/.test(t)) return "Savings";
  if (/transfer|p2p|send/.test(t)) return "Transfer";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Transaction";
}

export function HomeScreen({ onNavigate }: { onNavigate: (target: HomeModalTarget) => void }) {
  const { user, activeAccount, dataVersion } = useApp();
  const [balance, setBalance] = useState<UnifiedBalance | null>(null);
  const [fallbackNgnRate, setFallbackNgnRate] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<TransactionItem | null>(null);
  const [showReceiptImg, setShowReceiptImg] = useState(false);

  const loadData = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [balRes, txRes, rateRes] = await Promise.all([
          api.getBalances(activeAccount),
          api.getTransactions(40, activeAccount),
          api.getBankRates().catch(() => null),
        ]);
        setBalance(balRes);
        setTransactions(txRes.transactions || []);
        const rate = balRes.usdToNgnRate || rateRes?.offRampRate || rateRes?.onRampRate || null;
        if (rate) setFallbackNgnRate(rate);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load live wallet data.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    loadData(false);
  }, [loadData, dataVersion]);

  const isBiz = activeAccount === "business";
  const ngnAccount = balance?.ngnAccount || user?.ngnAccount || null;
  const isVerified = Number(user?.kycTier ?? 0) >= 1;
  const eurcBal = Number(balance?.arc?.eurc ?? 0);
  const pendingBridge = Number(balance?.pendingBridgeUsdc ?? 0);
  const totalUsdNum = Number(balance?.totalUsdc ?? 0);
  const liveNgnRate = balance?.usdToNgnRate || fallbackNgnRate || null;
  const totalNgnVal =
    balance && typeof balance.totalNgn === "number"
      ? balance.totalNgn
      : balance && liveNgnRate && Number.isFinite(totalUsdNum)
        ? Math.round(totalUsdNum * liveNgnRate)
        : null;

  const copyText = async (label: string, val: string) => {
    await Clipboard.setStringAsync(val);
    setCopiedMsg(`${label} copied`);
    setTimeout(() => setCopiedMsg(null), 2200);
  };

  const quickActions: Array<{
    key: HomeModalTarget;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }> = [
    { key: "add", label: "Add money", icon: "add-circle-outline" },
    { key: "send", label: "Send", icon: "paper-plane-outline" },
    { key: "bills", label: "Bills", icon: "receipt-outline" },
    { key: "cards", label: "Cards", icon: "card-outline" },
    { key: "savings", label: "Savings", icon: "trending-up-outline" },
    { key: "swap", label: "Swap", icon: "swap-horizontal-outline" },
  ];

  const accessToken = getAccessToken();

  const renderTxItem = ({ item: tx, index }: { item: TransactionItem; index: number }) => {
    const isCredit = /receive|deposit|onramp|claim|refund|credit/i.test(tx.type);
    const kindLabel = friendlyTxKind(tx.type);
    return (
      <PressableScale
        onPress={() => {
          setSelectedTx(tx);
          setShowReceiptImg(false);
        }}
        depth={0.98}
        style={[styles.txRow, index < transactions.length - 1 && styles.txDivider]}
      >
        <View
          style={[
            styles.txIcon,
            { backgroundColor: isCredit ? COLORS.primaryMuted : COLORS.surfaceElevated },
          ]}
        >
          <Ionicons
            name={isCredit ? "arrow-down" : "arrow-up"}
            size={16}
            color={isCredit ? COLORS.primary : COLORS.text}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.txTitle} numberOfLines={1}>
            {tx.narration || kindLabel}
          </Text>
          <Text style={styles.txMeta} numberOfLines={1}>
            {kindLabel} · {tx.status}
            {tx.createdAt ? ` · ${tx.createdAt.slice(0, 16)}` : ""}
          </Text>
        </View>
        <Text
          style={[
            styles.txAmount,
            { color: isCredit ? COLORS.primary : COLORS.text },
          ]}
        >
          {isCredit ? "+" : "-"}
          {formatRawTxAmount(tx.amount, tx.decimals)}
        </Text>
      </PressableScale>
    );
  };

  return (
    <View style={styles.container}>
      {/* Fixed Upper Section — never scrolls when browsing Activity */}
      <View style={styles.topFixed}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

        <Card style={[styles.balanceCard, isBiz && styles.bizBalanceCard]}>
          <View style={styles.balTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.acctBadge, { color: isBiz ? COLORS.business : COLORS.primary }]}>
                {isBiz ? "BUSINESS BALANCE" : "PERSONAL BALANCE"}
              </Text>
              <Text style={styles.senderSub} numberOfLines={1}>
                {isBiz
                  ? user?.bizSenderName || "Business Account"
                  : user?.senderName || (user?.username ? `@${user.username}` : "Proxim Account")}
              </Text>
            </View>
            <View style={styles.kycChip}>
              <Text style={styles.kycChipText}>Tier {user?.kycTier ?? 0}</Text>
            </View>
          </View>

          {loading && !balance ? (
            <View style={styles.balLoading}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.balLoadingText}>Loading live balance…</Text>
            </View>
          ) : (
            <View style={styles.balanceStack}>
              <View style={styles.amountRow}>
                <View style={styles.primaryBalRow}>
                  <CurrencyLogo code="USD" size={22} />
                  <Text style={styles.totalAmount}>
                    {balance ? formatUsdc(balance.totalUsdc) : "—"}
                  </Text>
                  <Text style={styles.currencyCode}>USD</Text>
                </View>
                {eurcBal > 0 ? (
                  <View style={styles.extraChip}>
                    <Text style={styles.extraChipText}>€{eurcBal.toFixed(2)} EURC</Text>
                  </View>
                ) : null}
                {pendingBridge > 0 ? (
                  <View style={[styles.extraChip, { borderColor: COLORS.businessBorder }]}>
                    <Text style={[styles.extraChipText, { color: COLORS.business }]}>
                      Pending {formatUsdc(pendingBridge)}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.ngnBalanceRow}>
                <View style={styles.ngnBalanceLeft}>
                  <CurrencyLogo code="NGN" size={18} />
                  <Text style={styles.ngnBalanceValue}>
                    {totalNgnVal !== null ? formatNgn(totalNgnVal) : "₦—"}
                  </Text>
                  <Text style={styles.ngnBalanceCode}>NGN</Text>
                </View>
                {liveNgnRate ? (
                  <Text style={styles.fxRatePill}>
                    $1 = ₦{Math.round(liveNgnRate).toLocaleString("en-NG")}
                  </Text>
                ) : null}
              </View>
            </View>
          )}

          {/* Verified NGN Account Number (replaces Web3 address on balance card) */}
          {ngnAccount?.accountNumber ? (
            <PressableScale
              onPress={() => copyText("NGN account number", ngnAccount.accountNumber)}
              style={styles.ngnRow}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <CurrencyLogo code="NGN" size={16} />
                  <Text style={styles.ngnLabel}>
                  NGN Account{ngnAccount.bankName ? ` · ${ngnAccount.bankName}` : ""}
                  </Text>
                </View>
                <Text style={styles.ngnNumber}>{ngnAccount.accountNumber}</Text>
              </View>
              <View style={styles.copyBadge}>
                <Ionicons name="copy-outline" size={14} color={COLORS.primary} />
                <Text style={styles.copyBadgeText}>Copy</Text>
              </View>
            </PressableScale>
          ) : isVerified ? (
            <PressableScale onPress={() => onNavigate("global")} style={styles.ngnRow}>
              <CurrencyLogo code="NGN" size={18} style={{ marginRight: 8 }} />
              <Text style={[styles.ngnCta, { flex: 1 }]}>Get your dedicated NGN account number</Text>
              <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
            </PressableScale>
          ) : (
            <PressableScale onPress={() => onNavigate("kyc")} style={styles.ngnRow}>
              <CurrencyLogo code="NGN" size={18} style={{ marginRight: 8 }} />
              <Text style={[styles.ngnCta, { flex: 1 }]}>Verify ID to unlock your NGN account number</Text>
              <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
            </PressableScale>
          )}
        </Card>

        {/* Quick Actions */}
        <View style={styles.qaGrid}>
          {quickActions.map((qa) => (
            <PressableScale
              key={qa.key}
              onPress={() => onNavigate(qa.key)}
              depth={0.92}
              style={styles.qaItem}
            >
              <View style={styles.qaIconCircle}>
                <Ionicons name={qa.icon} size={20} color={COLORS.primary} />
              </View>
              <Text style={styles.qaLabel}>{qa.label}</Text>
            </PressableScale>
          ))}
        </View>

        {/* Compact Assistant CTA */}
        <PressableScale
          onPress={() => onNavigate("assistant")}
          depth={0.98}
          style={styles.assistantBar}
        >
          <View style={styles.assistantIcon}>
            <Ionicons name="sparkles" size={16} color={COLORS.primary} />
          </View>
          <Text style={styles.assistantTitle} numberOfLines={1}>
            Ask Proxim Assistant
          </Text>
          <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
        </PressableScale>
      </View>

      {/* Independently Scrollable Activity Segment */}
      <View style={styles.activitySection}>
        <SectionHeader
          title={`${isBiz ? "Business" : "Personal"} Activity`}
          right={
            <Text style={styles.countText}>
              {transactions.length} {transactions.length === 1 ? "item" : "items"}
            </Text>
          }
        />

        <View style={styles.activityCard}>
          {loading && transactions.length === 0 ? (
            <View style={styles.txLoading}>
              <ActivityIndicator color={COLORS.primary} />
            </View>
          ) : (
            <FlatList
              data={transactions}
              keyExtractor={(item) => String(item.id)}
              renderItem={renderTxItem}
              showsVerticalScrollIndicator={true}
              contentContainerStyle={
                transactions.length === 0 ? { flexGrow: 1, justifyContent: "center" } : styles.txListContent
              }
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => loadData(true)}
                  tintColor={COLORS.primary}
                />
              }
              ListEmptyComponent={
                <EmptyState
                  icon="wallet-outline"
                  title="No transactions yet"
                  subtitle={`Deposit funds into your ${isBiz ? "Business" : "Personal"} balance to get started.`}
                />
              }
            />
          )}
        </View>
      </View>

      {/* Transaction Detail & Receipt Modal */}
      <Modal
        visible={Boolean(selectedTx)}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedTx(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Transaction Receipt</Text>
            {selectedTx ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <KeyValueRow label="ID" value={`#${selectedTx.id}`} />
                <KeyValueRow label="Account" value={selectedTx.accountType} />
                <KeyValueRow label="Type" value={friendlyTxKind(selectedTx.type)} />
                <KeyValueRow label="Status" value={selectedTx.status} />
                <KeyValueRow
                  label="Amount"
                  value={formatRawTxAmount(selectedTx.amount, selectedTx.decimals)}
                />
                {selectedTx.narration ? (
                  <KeyValueRow label="Note" value={selectedTx.narration} />
                ) : null}
                {selectedTx.txHash ? (
                  <KeyValueRow
                    label="Reference"
                    value={shortAddr(selectedTx.txHash, 10, 8)}
                    onCopy={() => copyText("Reference", selectedTx.txHash!)}
                  />
                ) : null}
                {selectedTx.createdAt ? (
                  <KeyValueRow label="Date" value={selectedTx.createdAt} />
                ) : null}

                {showReceiptImg && accessToken ? (
                  <View style={styles.receiptBox}>
                    <Image
                      source={{
                        uri: api.getReceiptUrl(selectedTx.id),
                        headers: {
                          Authorization: `Bearer ${accessToken}`,
                          "X-Proxim-Account": activeAccount,
                        },
                      }}
                      style={styles.receiptImg}
                      resizeMode="contain"
                    />
                  </View>
                ) : (
                  <Button
                    title="Load Official Receipt Slip (PNG)"
                    variant="secondary"
                    onPress={() => setShowReceiptImg(true)}
                    style={{ marginTop: 14 }}
                  />
                )}
              </ScrollView>
            ) : null}
            <Button
              title="Close"
              variant="ghost"
              onPress={() => setSelectedTx(null)}
              style={{ marginTop: 10 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
  },
  topFixed: {
    flexShrink: 0,
  },
  balanceCard: {
    ...DEPTH.card,
    shadowOpacity: 0.5,
    shadowRadius: 24,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.primaryBorder,
    padding: SPACING.md,
    marginBottom: 10,
  },
  bizBalanceCard: {
    borderColor: COLORS.businessBorder,
  },
  balTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  acctBadge: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  senderSub: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  kycChip: {
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: RADIUS.pill,
  },
  kycChipText: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: "700",
  },
  balLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  balLoadingText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  balanceStack: {
    marginBottom: 10,
    gap: 6,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  primaryBalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  totalAmount: {
    color: COLORS.text,
    fontSize: 31,
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  currencyCode: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  ngnBalanceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  ngnBalanceLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  ngnBalanceValue: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  ngnBalanceCode: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2,
  },
  fxRatePill: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  extraChip: {
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  extraChipText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  ngnRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  ngnLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  ngnNumber: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginTop: 1,
  },
  ngnCta: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  copyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: COLORS.primaryMuted,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: RADIUS.pill,
  },
  copyBadgeText: {
    color: COLORS.primary,
    fontSize: 11,
    fontWeight: "700",
  },
  qaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 8,
    marginBottom: 10,
  },
  qaItem: {
    width: "31.5%",
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    alignItems: "center",
    gap: 5,
  },
  qaIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    ...DEPTH.raised,
  },
  qaLabel: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: "700",
  },
  assistantBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 10,
  },
  assistantIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  assistantTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  activitySection: {
    flex: 1,
    minHeight: 160,
    paddingBottom: 8,
  },
  activityCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  txListContent: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
  },
  countText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  txLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
  },
  txDivider: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  txIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  txTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  txMeta: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  txAmount: {
    fontSize: 13,
    fontWeight: "700",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1,
    borderColor: COLORS.borderStrong,
    padding: SPACING.lg,
    maxHeight: "88%",
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 12,
  },
  receiptBox: {
    marginTop: 14,
    borderRadius: RADIUS.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  receiptImg: {
    width: "100%",
    height: 360,
  },
});
