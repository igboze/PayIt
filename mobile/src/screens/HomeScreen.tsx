import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SectionList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type { TransactionItem, UnifiedBalance } from "../api/types";
import { useApp } from "../state/AppContext";
import { BALANCE_GRADIENT, COLORS, DEPTH, HERO, RADIUS, SPACING, TYPE } from "../theme";
import {
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatRawTxAmount,
  formatUsdc,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";
import { groupByDay, SkeletonRows, TxDetailSheet, TxRow } from "../components/Activity";

export type HomeModalTarget =
  | "add"
  | "send"
  | "bills"
  | "cards"
  | "savings"
  | "swap"
  | "assistant"
  | "global"
  | "kyc"
  | "notifications";

type IoniconName = keyof typeof Ionicons.glyphMap;

// Canvas tile tones: [icon colour, tile background].
const TONES = {
  green: ["#047857", "rgba(16, 185, 129, 0.14)"],
  neutral: ["#3F4A45", "rgba(14, 21, 18, 0.06)"],
  violet: ["#6D28D9", "rgba(139, 92, 246, 0.12)"],
  amber: ["#B45309", "rgba(245, 158, 11, 0.14)"],
  teal: ["#0F766E", "rgba(20, 184, 166, 0.14)"],
  blue: ["#1D4ED8", "rgba(59, 130, 246, 0.12)"],
} as const;
const AVATAR_TONES = [
  ["#047857", "rgba(16, 185, 129, 0.14)"],
  ["#1D4ED8", "rgba(59, 130, 246, 0.12)"],
  ["#B45309", "rgba(245, 158, 11, 0.14)"],
  ["#6D28D9", "rgba(139, 92, 246, 0.12)"],
  ["#BE185D", "rgba(236, 72, 153, 0.12)"],
  ["#0F766E", "rgba(20, 184, 166, 0.14)"],
] as const;




function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function initialsOf(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "P";
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function Tile({ icon, tone, size = 44 }: { icon: IoniconName; tone: keyof typeof TONES; size?: number }) {
  const [fg, bg] = TONES[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size / 3), backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <Ionicons name={icon} size={Math.round(size / 2)} color={fg} />
    </View>
  );
}

/** Canvas balance card background: a diagonal green gradient, drawn as fading bands (no native gradient module). */
function GradientFill() {
  const bands = 14;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: bands }, (_, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: "-30%",
            width: "160%",
            top: `${(i * 100) / bands - 20}%`,
            height: `${100 / bands + 1}%`,
            backgroundColor: BALANCE_GRADIENT.from,
            opacity: Math.max(0, 1 - i / (bands - 3)),
            transform: [{ rotate: "-16deg" }],
          }}
        />
      ))}
      <View style={styles.cardGlow} />
    </View>
  );
}

export function HomeScreen({
  onNavigate,
  onOpenProfile,
  unread = 0,
}: {
  onNavigate: (target: HomeModalTarget) => void;
  onOpenProfile?: () => void;
  unread?: number;
}) {
  const { user, activeAccount, dataVersion, switchAccount, switchingAccount, requestApproval } = useApp();
  const [balance, setBalance] = useState<UnifiedBalance | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<TransactionItem | null>(null);
  const [hidden, setHidden] = useState(false);
  const [fallbackNgnRate, setFallbackNgnRate] = useState<number | null>(null);

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
  const ngnRate = balance?.usdToNgnRate || fallbackNgnRate || null;
  const totalNgn =
    balance && typeof balance.totalNgn === "number"
      ? balance.totalNgn
      : balance && ngnRate && Number.isFinite(totalUsdNum)
        ? Math.round(totalUsdNum * ngnRate)
        : null;
  const displayName = isBiz
    ? user?.bizSenderName || "Business"
    : (user?.senderName || "").split(/\s+/)[0] || (user?.username ? `@${user.username}` : "there");
  const avatarText = initialsOf(isBiz ? user?.bizSenderName || "Business" : user?.senderName || user?.username || "Proxim");
  const [avFg, avBg] = AVATAR_TONES[[...avatarText].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_TONES.length];

  const copyText = async (label: string, val: string) => {
    await Clipboard.setStringAsync(val);
    setCopiedMsg(`${label} copied`);
    setTimeout(() => setCopiedMsg(null), 2200);
  };

  const toggleAccount = () => {
    if (!user || switchingAccount) return;
    const target = isBiz ? "personal" : "business";
    if (target === "business" && !user.hasBusinessAccount) {
      Alert.alert("Create a business account", "Set up a separate business balance next to your personal one?", [
        { text: "Not now", style: "cancel" },
        {
          text: "Set it up",
          onPress: async () => {
            try {
              await requestApproval("business.setup", {});
              await switchAccount("business");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not set up the business account.");
            }
          },
        },
      ]);
      return;
    }
    switchAccount(target).catch((err) => setError(err instanceof Error ? err.message : "Could not switch account."));
  };

  const quickActions: Array<{ key: HomeModalTarget; label: string; icon: IoniconName; primary?: boolean; rotate?: boolean }> = [
    { key: "add", label: "Add money", icon: "add", primary: true },
    { key: "send", label: "Send", icon: "arrow-up", rotate: true },
    { key: "bills", label: "Bills", icon: "receipt-outline" },
    { key: "cards", label: "Cards", icon: "card-outline" },
  ];


  const header = (
    <View style={styles.topSection}>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

      {/* Greeting row */}
      <View style={styles.greetRow}>
        <PressableScale onPress={onOpenProfile} depth={0.94} style={[styles.avatar, { backgroundColor: avBg }]}>
          <Text style={[styles.avatarText, { color: avFg }]}>{avatarText}</Text>
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.greetSub}>{greeting()}</Text>
          <Text style={styles.greetName} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <PressableScale onPress={() => onNavigate("assistant")} depth={0.92} style={styles.iconBtn} accessibilityLabel="Ask Proxim">
          <Ionicons name="sparkles" size={22} color={COLORS.primary} />
        </PressableScale>
        <PressableScale
          onPress={() => onNavigate("notifications")}
          depth={0.92}
          style={styles.iconBtn}
          accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Ionicons name="notifications-outline" size={22} color={COLORS.text} />
          {unread > 0 ? <View style={styles.unreadDot} /> : null}
        </PressableScale>
      </View>

      {/* Balance card */}
      <View style={[styles.balanceCard, isBiz && { borderColor: COLORS.businessBorder }]}>
        <GradientFill />
        <PressableScale onPress={toggleAccount} depth={0.97} haptic="selection" style={styles.acctLabelRow}>
          <Text style={[styles.acctLabel, isBiz && { color: "#F5B83D" }]}>
            {isBiz ? "Business account" : "Personal account"}
          </Text>
          {switchingAccount ? (
            <ActivityIndicator size="small" color={HERO.textSecondary} />
          ) : (
            <Ionicons name="chevron-forward" size={14} color={HERO.textSecondary} />
          )}
        </PressableScale>

        {loading && !balance ? (
          <View style={styles.balLoading}>
            <ActivityIndicator color={HERO.accent} />
            <Text style={styles.balLoadingText}>Loading your balance…</Text>
          </View>
        ) : (
          <View style={styles.amountRow}>
            <Text style={styles.totalAmount} numberOfLines={1} adjustsFontSizeToFit>
              {hidden ? "$••••" : balance ? formatUsdc(balance.totalUsdc) : "—"}
            </Text>
            <PressableScale
              onPress={() => setHidden((h) => !h)}
              haptic="selection"
              style={styles.eyeBtn}
              accessibilityLabel={hidden ? "Show balance" : "Hide balance"}
            >
              <Ionicons name={hidden ? "eye-off-outline" : "eye-outline"} size={20} color={HERO.textSecondary} />
            </PressableScale>
          </View>
        )}

        {balance ? (
          <View style={styles.ngnValueRow}>
            <View style={styles.ngnValueLeft}>
              <CurrencyLogo code="NGN" size={20} />
              <Text style={styles.ngnValue}>{hidden ? "₦••••" : totalNgn !== null ? formatNgn(totalNgn) : "₦—"}</Text>
            </View>
            {ngnRate ? <Text style={styles.rateText}>$1 = ₦{Math.round(ngnRate).toLocaleString("en-NG")}</Text> : null}
          </View>
        ) : null}

        <View style={styles.chip}>
          <Ionicons name="globe-outline" size={14} color={HERO.accent} />
          <Text style={styles.chipText}>One balance, spend anywhere</Text>
        </View>
        {!hidden && (eurcBal > 0 || pendingBridge > 0) ? (
          <Text style={styles.extraLine}>
            {[eurcBal > 0 ? `Includes €${eurcBal.toFixed(2)} in EURC` : null, pendingBridge > 0 ? `${formatUsdc(pendingBridge)} arriving` : null]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}

        {/* Naira receiving account */}
        {ngnAccount?.accountNumber ? (
          <PressableScale onPress={() => copyText("Account number", ngnAccount.accountNumber)} depth={0.98} style={styles.ngnRow}>
            <CurrencyLogo code="NGN" size={22} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.ngnLabel} numberOfLines={1}>
                Naira account{ngnAccount.bankName ? ` · ${ngnAccount.bankName}` : ""}
              </Text>
              <Text style={styles.ngnNumber}>{ngnAccount.accountNumber}</Text>
            </View>
            <Ionicons name="copy-outline" size={18} color={HERO.accent} />
          </PressableScale>
        ) : (
          <PressableScale onPress={() => onNavigate(isVerified ? "global" : "kyc")} depth={0.98} style={styles.ngnRow}>
            <CurrencyLogo code="NGN" size={22} />
            <Text style={[styles.ngnCta, { flex: 1 }]}>
              {isVerified ? "Get your naira account number" : "Verify your ID to get a naira account"}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={HERO.accent} />
          </PressableScale>
        )}
      </View>

      {/* Quick actions */}
      <View style={styles.qaRow}>
        {quickActions.map((qa) => (
          <PressableScale
            key={qa.key}
            onPress={() => onNavigate(qa.key)}
            depth={0.92}
            haptic={qa.primary ? "medium" : "light"}
            style={styles.qaItem}
          >
            <View style={[styles.qaTile, qa.primary ? styles.qaTilePrimary : null]}>
              <Ionicons
                name={qa.icon}
                size={24}
                color={qa.primary ? COLORS.onPrimary : COLORS.primary}
                style={qa.rotate ? { transform: [{ rotate: "45deg" }] } : undefined}
              />
            </View>
            <Text style={styles.qaLabel}>{qa.label}</Text>
          </PressableScale>
        ))}
      </View>

      {/* Savings */}
      <PressableScale onPress={() => onNavigate("savings")} depth={0.98} style={styles.rowCard}>
        <Tile icon="server-outline" tone="teal" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle}>Savings</Text>
          <Text style={styles.rowSub}>Earn on your dollars · withdraw anytime</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
      </PressableScale>

      <View style={styles.activityHead}>
        <Text style={styles.activityTitle}>Recent activity</Text>
        {transactions.length ? (
          <Text style={styles.activityCount}>
            {transactions.length} {transactions.length === 1 ? "item" : "items"}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <SectionList
        sections={loading && transactions.length === 0 ? [] : groupByDay(transactions)}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <TxRow tx={item} onPress={() => setSelectedTx(item)} />}
        renderSectionHeader={({ section }) => <Text style={styles.dayHeader}>{section.title}</Text>}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={styles.txGap} />}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} tintColor={COLORS.primary} />}
        ListEmptyComponent={
          loading ? (
            <SkeletonRows />
          ) : (
            <View style={styles.emptyCard}>
              <EmptyState icon="time-outline" title="No activity yet" subtitle="Money you add, send or receive shows up here." />
            </View>
          )
        }
      />

      <TxDetailSheet tx={selectedTx} activeAccount={activeAccount} onClose={() => setSelectedTx(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  listContent: {
    paddingHorizontal: SPACING.md,
    paddingTop: 12,
    paddingBottom: 24,
  },
  topSection: {
    gap: 18,
    marginBottom: 12,
  },
  greetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    ...TYPE.bodyStrong,
  },
  greetSub: {
    ...TYPE.label,
    color: COLORS.textMuted,
  },
  greetName: {
    ...TYPE.headline,
    color: COLORS.text,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    ...DEPTH.raised,
  },
  unreadDot: {
    position: "absolute",
    top: 10,
    right: 11,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: COLORS.danger,
    borderWidth: 1.5,
    borderColor: COLORS.surface,
  },
  balanceCard: {
    position: "relative",
    overflow: "hidden",
    borderRadius: RADIUS.xl,
    paddingTop: 20,
    paddingHorizontal: 22,
    paddingBottom: 22,
    backgroundColor: BALANCE_GRADIENT.to,
    borderWidth: 1,
    borderColor: BALANCE_GRADIENT.border,
    gap: 6,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.6,
    shadowRadius: 26,
    elevation: 12,
  },
  cardGlow: {
    position: "absolute",
    right: -60,
    top: -80,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  acctLabelRow: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  acctLabel: {
    ...TYPE.overline,
    color: HERO.textSecondary,
  },
  balLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 52,
  },
  balLoadingText: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  totalAmount: {
    ...TYPE.xl,
    color: HERO.text,
    flexShrink: 1,
  },
  ngnValueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  ngnValueLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  ngnValue: {
    ...TYPE.title,
    color: HERO.text,
  },
  rateText: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  eyeBtn: {
    padding: 6,
  },
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: HERO.chip,
    borderRadius: RADIUS.pill,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  chipText: {
    ...TYPE.label,
    color: HERO.text,
  },
  extraLine: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  ngnRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: HERO.inset,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  ngnLabel: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  ngnNumber: {
    ...TYPE.bodyStrong,
    color: HERO.text,
    letterSpacing: 1,
  },
  ngnCta: {
    ...TYPE.label,
    color: HERO.accent,
  },
  qaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  qaItem: {
    width: 76,
    alignItems: "center",
    gap: 8,
  },
  qaTile: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    ...DEPTH.raised,
  },
  qaTilePrimary: {
    backgroundColor: COLORS.primary,
    ...DEPTH.glow,
  },
  qaLabel: {
    ...TYPE.label,
    color: COLORS.text,
  },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  rowTitle: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
  },
  rowSub: {
    ...TYPE.label,
    color: COLORS.textSecondary,
  },
  activityHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  activityTitle: {
    ...TYPE.headline,
    color: COLORS.text,
  },
  activityCount: {
    ...TYPE.label,
    color: COLORS.textMuted,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  dayHeader: {
    ...TYPE.overline,
    color: COLORS.textMuted,
    marginTop: 10,
    marginBottom: 8,
  },
  txGap: {
    height: 6,
  },
  txTitle: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
  },
  txMeta: {
    ...TYPE.label,
    color: COLORS.textSecondary,
  },
  txAmount: {
    ...TYPE.bodyStrong,
  },
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    padding: SPACING.lg,
    paddingTop: 10,
    maxHeight: "88%",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
    marginBottom: 14,
  },
  modalTitle: {
    ...TYPE.title,
    color: COLORS.text,
    marginBottom: 8,
  },
  receiptBox: {
    marginTop: 16,
    borderRadius: RADIUS.md,
    overflow: "hidden",
    backgroundColor: COLORS.page,
  },
  receiptImg: {
    width: "100%",
    height: 360,
  },
});
