import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
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
import { COLORS, RADIUS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatRawTxAmount,
  formatUsdc,
  KeyValueRow,
  SectionHeader,
  shortAddr,
  SuccessBanner,
} from "../components/UI";

export type HomeModalTarget = "add" | "send" | "bills" | "cards" | "savings" | "swap" | "assistant";

export function HomeScreen({ onNavigate }: { onNavigate: (target: HomeModalTarget) => void }) {
  const { user, activeAccount, dataVersion } = useApp();
  const [balance, setBalance] = useState<UnifiedBalance | null>(null);
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
        const [balRes, txRes] = await Promise.all([
          api.getBalances(activeAccount),
          api.getTransactions(25, activeAccount),
        ]);
        setBalance(balRes);
        setTransactions(txRes.transactions || []);
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
  const depositAddr = balance?.depositAddress || user?.activeDepositAddress || null;
  const arcUsdc = Number(balance?.arc?.usdc ?? 0);
  const arcEurc = Number(balance?.arc?.eurc ?? 0);
  const baseUsdc = Number(balance?.base?.usdc ?? 0);
  const solUsdc = Number(balance?.solana?.usdc ?? 0);
  const gwUsdc = Number(balance?.gateway?.usdc ?? 0);
  const pendingBridge = Number(balance?.pendingBridgeUsdc ?? 0);

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

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => loadData(true)}
          tintColor={COLORS.primary}
        />
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

      {/* Main Balance Card */}
      <Card style={[styles.balanceCard, isBiz ? styles.bizBalanceCard : undefined]}>
        <View style={styles.balTopRow}>
          <View>
            <Text style={[styles.acctBadge, { color: isBiz ? COLORS.business : COLORS.primary }]}>
              {isBiz ? "BUSINESS WALLET" : "PERSONAL WALLET"}
            </Text>
            <Text style={styles.senderSub}>
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
            <Text style={styles.balLoadingText}>Loading live on-chain balance…</Text>
          </View>
        ) : (
          <Text style={styles.totalAmount}>
            {balance ? formatUsdc(balance.totalUsdc) : "—"}
          </Text>
        )}

        <Text style={styles.totalLabel}>Unified USDC balance</Text>

        {balance ? (
          <View style={styles.chainRow}>
            <View style={styles.chainChip}>
              <Text style={styles.chainChipText}>Arc {formatUsdc(arcUsdc)}</Text>
            </View>
            {arcEurc > 0 ? (
              <View style={styles.chainChip}>
                <Text style={styles.chainChipText}>EURC €{arcEurc.toFixed(2)}</Text>
              </View>
            ) : null}
            {baseUsdc > 0 ? (
              <View style={styles.chainChip}>
                <Text style={styles.chainChipText}>Base {formatUsdc(baseUsdc)}</Text>
              </View>
            ) : null}
            {solUsdc > 0 ? (
              <View style={styles.chainChip}>
                <Text style={styles.chainChipText}>Solana {formatUsdc(solUsdc)}</Text>
              </View>
            ) : null}
            {gwUsdc > 0 ? (
              <View style={styles.chainChip}>
                <Text style={styles.chainChipText}>Gateway {formatUsdc(gwUsdc)}</Text>
              </View>
            ) : null}
            {pendingBridge > 0 ? (
              <View style={[styles.chainChip, { borderColor: COLORS.businessBorder }]}>
                <Text style={[styles.chainChipText, { color: COLORS.business }]}>
                  Bridging {formatUsdc(pendingBridge)}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {depositAddr ? (
          <Pressable
            onPress={() => copyText("Wallet address", depositAddr)}
            style={styles.addrRow}
          >
            <Text style={styles.addrText}>
              {isBiz ? "Business" : "Personal"} address: {shortAddr(depositAddr, 8, 6)}
            </Text>
            <Ionicons name="copy-outline" size={14} color={COLORS.primary} />
          </Pressable>
        ) : null}
      </Card>

      {/* Quick Actions */}
      <View style={styles.qaGrid}>
        {quickActions.map((qa) => (
          <Pressable
            key={qa.key}
            onPress={() => onNavigate(qa.key)}
            style={({ pressed }) => [styles.qaItem, pressed && { opacity: 0.78 }]}
          >
            <View style={styles.qaIconCircle}>
              <Ionicons name={qa.icon} size={22} color={COLORS.primary} />
            </View>
            <Text style={styles.qaLabel}>{qa.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Assistant CTA */}
      <Pressable
        onPress={() => onNavigate("assistant")}
        style={({ pressed }) => [styles.assistantBar, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.assistantIcon}>
          <Ionicons name="sparkles" size={18} color={COLORS.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.assistantTitle}>Ask Proxim Assistant</Text>
          <Text style={styles.assistantSub}>
            Check balances, look up contacts, or draft a payment for Passkey approval
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
      </Pressable>

      {/* Recent Activity */}
      <SectionHeader
        title={`${isBiz ? "Business" : "Personal"} Activity`}
        right={
          <Text style={styles.countText}>
            {transactions.length} {transactions.length === 1 ? "item" : "items"}
          </Text>
        }
      />

      <Card style={{ paddingVertical: 6 }}>
        {loading && transactions.length === 0 ? (
          <View style={styles.txLoading}>
            <ActivityIndicator color={COLORS.primary} />
          </View>
        ) : transactions.length === 0 ? (
          <EmptyState
            icon="wallet-outline"
            title="No transactions yet"
            subtitle={`Add money to your ${isBiz ? "Business" : "Personal"} wallet to get started.`}
          />
        ) : (
          transactions.map((tx, idx) => {
            const isCredit = /receive|deposit|onramp|claim|refund|credit/i.test(tx.type);
            return (
              <Pressable
                key={tx.id}
                onPress={() => {
                  setSelectedTx(tx);
                  setShowReceiptImg(false);
                }}
                style={({ pressed }) => [
                  styles.txRow,
                  idx < transactions.length - 1 && styles.txDivider,
                  pressed && { opacity: 0.75 },
                ]}
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
                    {tx.narration || tx.type.replace(/_/g, " ")}
                  </Text>
                  <Text style={styles.txMeta} numberOfLines={1}>
                    {tx.chain.toUpperCase()} · {tx.status}
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
              </Pressable>
            );
          })
        )}
      </Card>

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
                <KeyValueRow label="Type" value={selectedTx.type} />
                <KeyValueRow label="Status" value={selectedTx.status} />
                <KeyValueRow
                  label="Amount"
                  value={formatRawTxAmount(selectedTx.amount, selectedTx.decimals)}
                />
                <KeyValueRow label="Chain" value={selectedTx.chain} />
                {selectedTx.narration ? (
                  <KeyValueRow label="Note" value={selectedTx.narration} />
                ) : null}
                {selectedTx.txHash ? (
                  <KeyValueRow
                    label="Tx Hash"
                    value={shortAddr(selectedTx.txHash, 10, 8)}
                    onCopy={() => copyText("Tx hash", selectedTx.txHash!)}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: SPACING.md,
    paddingBottom: 32,
  },
  balanceCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.primaryBorder,
    padding: SPACING.lg,
  },
  bizBalanceCard: {
    borderColor: COLORS.businessBorder,
  },
  balTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  acctBadge: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
  },
  senderSub: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  kycChip: {
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: 10,
    paddingVertical: 4,
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
    paddingVertical: 14,
  },
  balLoadingText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  totalAmount: {
    color: COLORS.text,
    fontSize: 38,
    fontWeight: "800",
    letterSpacing: -1,
  },
  totalLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 14,
  },
  chainRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 14,
  },
  chainChip: {
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chainChipText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  addrRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  addrText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: "monospace",
  },
  qaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 12,
    marginBottom: SPACING.md,
  },
  qaItem: {
    width: "31%",
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 14,
    alignItems: "center",
    gap: 8,
  },
  qaIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  qaLabel: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "700",
  },
  assistantBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    marginBottom: SPACING.lg,
  },
  assistantIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  assistantTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  assistantSub: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  countText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  txLoading: {
    paddingVertical: 28,
    alignItems: "center",
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  txDivider: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  txIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  txTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  txMeta: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  txAmount: {
    fontSize: 14,
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
