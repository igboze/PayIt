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
import type { BusinessHomeResponse, TransactionItem, UnifiedBalance } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, HERO, RADIUS, SPACING, TYPE } from "../theme";
import {
  Button,
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatRawTxAmount,
  formatUsdc,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { SavingsLogoMerger, StockLogoMerger } from "../components/AssetLogoCluster";
import { PressableScale } from "../components/Touch";
import { UserAvatar } from "../components/Avatar";
import { BILL_CATEGORIES, BillCat, BillCategoryTile } from "../components/bills";
import { groupByDay, SkeletonRows, TxDetailSheet, TxRow } from "../components/Activity";

export type HomeModalTarget =
  | "add"
  | "send"
  | "bills"
  | "cards"
  | "savings"
  | "stocks"
  | "swap"
  | "assistant"
  | "global"
  | "business"
  | "kyc"
  | "kyb"
  | "notifications"
  | "activity";


// Home shows only the newest few; "See all" opens the full Activity screen.
const HOME_ACTIVITY_COUNT = 5;

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

export function HomeScreen({
  onNavigate,
  onOpenProfile,
  onOpenBill,
  unread = 0,
}: {
  onNavigate: (target: HomeModalTarget) => void;
  onOpenProfile?: () => void;
  onOpenBill?: (category: BillCat) => void;
  unread?: number;
}) {
  const {
    user,
    activeAccount,
    dataVersion,
    switchAccount,
    switchingAccount,
    requestApproval,
    balanceHidden: hidden,
    toggleBalanceHidden,
  } = useApp();
  const [balance, setBalance] = useState<UnifiedBalance | null>(null);
  const [bizHome, setBizHome] = useState<BusinessHomeResponse | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<TransactionItem | null>(null);
  const [fallbackNgnRate, setFallbackNgnRate] = useState<number | null>(null);

  const loadData = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [balRes, txRes, rateRes, bizRes] = await Promise.all([
          api.getBalances(activeAccount),
          api.getTransactions(40, activeAccount),
          api.getBankRates().catch(() => null),
          activeAccount === "business" ? api.getBusinessHome().catch(() => null) : Promise.resolve(null),
        ]);
        setBalance(balRes);
        setTransactions(txRes.transactions || []);
        setBizHome(bizRes);
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

  // Immediately clear stale account data when switching between Personal & Business
  useEffect(() => {
    setBalance(null);
    setTransactions([]);
    setBizHome(null);
  }, [activeAccount]);

  useEffect(() => {
    loadData(false);
  }, [loadData, dataVersion]);

  const isBiz = activeAccount === "business";
  const ngnAccount = balance?.ngnAccount || (user?.activeContext === activeAccount ? user?.ngnAccount : null) || null;
  const isVerified = isBiz
    ? Number(user?.businessKycTier ?? 0) >= 1
    : Number(user?.personalKycTier ?? user?.kycTier ?? 0) >= 1;
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
    ? bizHome?.profile?.businessName || user?.bizSenderName || "Business Account"
    : (user?.senderName || "").split(/\s+/)[0] || (user?.username ? `@${user.username}` : "there");

  const copyText = async (label: string, val: string) => {
    await Clipboard.setStringAsync(val);
    setCopiedMsg(`${label} copied`);
    setTimeout(() => setCopiedMsg(null), 2200);
  };

  const handleSelectAccount = (target: "personal" | "business") => {
    if (!user || switchingAccount || target === activeAccount) return;
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

  // Which currency the big number shows; the other one sits underneath.
  const [showCur, setShowCur] = useState<"NGN" | "USD">("NGN");
  const curTabs: Array<"NGN" | "USD"> = ["NGN", "USD"];
  const mainText =
    showCur === "NGN" && totalNgn !== null ? formatNgn(totalNgn) : balance ? formatUsdc(balance.totalUsdc) : "—";
  const subText =
    showCur === "NGN"
      ? balance
        ? `≈ ${formatUsdc(balance.totalUsdc)}`
        : ""
      : totalNgn !== null
        ? `≈ ${formatNgn(totalNgn)}`
        : "";
  // Two-weight number: whole part large, decimals smaller and softer.
  const dot = mainText.lastIndexOf(".");
  const whole = dot > 0 ? mainText.slice(0, dot) : mainText;
  const cents = dot > 0 ? mainText.slice(dot) : "";

  const header = (
    <View style={styles.topSection}>
      <View style={[styles.hero, isBiz && styles.heroBiz]}>
        {/* Greeting row */}
        <View style={styles.greetRow}>
          <PressableScale onPress={onOpenProfile} depth={0.94} accessibilityLabel="Open profile">
            <UserAvatar size={42} name={isBiz ? displayName : null} />
          </PressableScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.greetSub}>
              {isBiz ? "BUSINESS WORKSPACE" : greeting()}
            </Text>
            <Text style={styles.greetName} numberOfLines={1}>
              {displayName}
            </Text>
          </View>
          <PressableScale onPress={() => onNavigate("assistant")} depth={0.92} style={[styles.iconBtn, isBiz && styles.iconBtnBiz]} accessibilityLabel="Ask Proxim">
            <Ionicons name="sparkles" size={20} color={HERO.accent} />
          </PressableScale>
          <PressableScale
            onPress={() => onNavigate("notifications")}
            depth={0.92}
            style={[styles.iconBtn, isBiz && styles.iconBtnBiz]}
            accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
          >
            <Ionicons name="notifications-outline" size={20} color={HERO.text} />
            {unread > 0 ? <View style={styles.unreadDot} /> : null}
          </PressableScale>
        </View>

        {/* Explicit 2-pill Personal / Business switch + currency switch */}
        <View style={styles.switchRow}>
          <View style={[styles.heroSeg, isBiz && styles.heroSegBiz]}>
            <PressableScale
              onPress={() => handleSelectAccount("personal")}
              haptic="selection"
              style={[styles.heroSegBtn, !isBiz && styles.heroSegBtnOn]}
              accessibilityLabel="Switch to Personal account"
            >
              <Ionicons name="person" size={12} color={!isBiz ? COLORS.primary : HERO.textSecondary} />
              <Text style={[styles.heroSegText, !isBiz && styles.heroSegTextOn]}>Personal</Text>
            </PressableScale>
            <PressableScale
              onPress={() => handleSelectAccount("business")}
              haptic="selection"
              style={[styles.heroSegBtn, isBiz && styles.heroSegBtnBizOn]}
              accessibilityLabel="Switch to Business account"
            >
              <Ionicons name="briefcase" size={12} color={isBiz ? COLORS.onGold : HERO.textSecondary} />
              <Text style={[styles.heroSegText, isBiz && styles.heroSegTextBizOn]}>
                {user?.hasBusinessAccount ? "Business" : "+ Business"}
              </Text>
            </PressableScale>
            {switchingAccount ? <ActivityIndicator size="small" color={HERO.accent} style={{ marginLeft: 4 }} /> : null}
          </View>
          <View style={{ flex: 1 }} />
          {curTabs.map((code) => {
            const on = code === showCur;
            return (
              <PressableScale
                key={code}
                onPress={() => setShowCur(code)}
                haptic="selection"
                style={[styles.curChip, isBiz && styles.curChipBiz, on && styles.curChipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Show balance in ${code}`}
              >
                <CurrencyLogo code={code} size={18} />
                <Text style={[styles.curChipText, on && styles.curChipTextOn]}>{code}</Text>
              </PressableScale>
            );
          })}
        </View>

        {loading && !balance ? (
          <View style={styles.balLoading}>
            <ActivityIndicator color={HERO.accent} />
            <Text style={styles.balLoadingText}>Loading your balance…</Text>
          </View>
        ) : (
          <View style={styles.amountRow}>
            <Text style={styles.totalAmount} numberOfLines={1} adjustsFontSizeToFit>
              {hidden ? (showCur === "NGN" ? "₦••••" : "$••••") : whole}
              {!hidden && cents ? <Text style={styles.totalCents}>{cents}</Text> : null}
            </Text>
            <PressableScale
              onPress={toggleBalanceHidden}
              haptic="selection"
              style={styles.eyeBtn}
              accessibilityLabel={hidden ? "Show balance" : "Hide balance"}
            >
              <Ionicons name={hidden ? "eye-off-outline" : "eye-outline"} size={20} color={HERO.textSecondary} />
            </PressableScale>
          </View>
        )}
        {balance ? (
          <Text style={styles.subLine}>
            {hidden ? "Balance hidden" : subText}
            {ngnRate ? `  ·  $1 = ₦${Math.round(ngnRate).toLocaleString("en-NG")}` : ""}
          </Text>
        ) : null}
        {!hidden && (eurcBal > 0 || pendingBridge > 0) ? (
          <Text style={styles.extraLine}>
            {[eurcBal > 0 ? `Includes €${eurcBal.toFixed(2)} in EURC` : null, pendingBridge > 0 ? `${formatUsdc(pendingBridge)} arriving` : null]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}

        {/* Naira receiving account */}
        {ngnAccount?.accountNumber ? (
          <View style={styles.ngnRow}>
            <CurrencyLogo code="NGN" size={22} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.ngnLabel} numberOfLines={1}>
                Naira account{ngnAccount.bankName ? ` · ${ngnAccount.bankName}` : ""}
              </Text>
              <Text style={styles.ngnNumber}>{ngnAccount.accountNumber}</Text>
            </View>
            <PressableScale
              onPress={() => copyText("Account number", ngnAccount.accountNumber)}
              haptic="selection"
              style={styles.copyPill}
              accessibilityRole="button"
              accessibilityLabel="Copy account number"
            >
              <Ionicons name="copy-outline" size={14} color={COLORS.onGold} />
              <Text style={styles.copyPillText}>Copy</Text>
            </PressableScale>
          </View>
        ) : (
          <PressableScale onPress={() => onNavigate(isVerified ? "global" : isBiz ? "kyb" : "kyc")} depth={0.98} style={[styles.ngnRow, isBiz && styles.ngnRowBiz]}>
            <CurrencyLogo code="NGN" size={22} />
            <Text style={[styles.ngnCta, { flex: 1 }]}>
              {isVerified
                ? isBiz
                  ? "Open your company global bank accounts"
                  : "Get your naira account number"
                : isBiz
                  ? "Verify your business (KYB) for company accounts"
                  : "Verify your ID (KYC) to get a naira account"}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={HERO.accent} />
          </PressableScale>
        )}

        {/* The two main actions live on the header, where the thumb is */}
        <View style={styles.qaRow}>
          <PressableScale
            onPress={() => onNavigate("add")}
            depth={0.95}
            haptic="medium"
            style={[styles.qaWide, styles.qaGold]}
            accessibilityRole="button"
            accessibilityLabel="Add money"
          >
            <Ionicons name="add" size={22} color={COLORS.onGold} />
            <Text style={[styles.qaWideLabel, { color: COLORS.onGold }]}>Add money</Text>
          </PressableScale>
          <PressableScale
            onPress={() => onNavigate("send")}
            depth={0.95}
            haptic="light"
            style={[styles.qaWide, styles.qaWhite]}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <Ionicons name="arrow-up" size={22} color={COLORS.primary} style={{ transform: [{ rotate: "45deg" }] }} />
            <Text style={styles.qaWideLabel}>Send</Text>
          </PressableScale>
        </View>
      </View>

      <View style={styles.below}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

        {isBiz ? (
          <>
            {/* Business Cash Flow & Unpaid Invoices summary (matching Telegram bot Business menu) */}
            <View style={styles.bizSummaryCard}>
              <View style={styles.bizSummaryHead}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="briefcase" size={16} color={COLORS.business} />
                  <Text style={styles.bizSummaryTitle}>This Month · Cash Flow</Text>
                </View>
                <PressableScale onPress={() => onNavigate(isVerified ? "global" : "kyb")} style={styles.bizTierBadge}>
                  <Text style={styles.bizTierBadgeText}>{isVerified ? "KYB Tier 1 ✅" : "Verify KYB →"}</Text>
                </PressableScale>
              </View>
              <View style={styles.bizMetricsRow}>
                <View style={styles.bizMetric}>
                  <Text style={styles.bizMetricLabel}>Income</Text>
                  <Text style={[styles.bizMetricVal, { color: COLORS.success }]}>
                    {hidden ? "••••" : formatUsdc(bizHome?.summary?.monthIncomeUsd ?? 0)}
                  </Text>
                </View>
                <View style={styles.bizMetric}>
                  <Text style={styles.bizMetricLabel}>Expenses</Text>
                  <Text style={styles.bizMetricVal}>
                    {hidden ? "••••" : formatUsdc(bizHome?.summary?.monthExpensesUsd ?? 0)}
                  </Text>
                </View>
                <View style={styles.bizMetric}>
                  <Text style={styles.bizMetricLabel}>Unpaid Inv.</Text>
                  <Text style={styles.bizMetricVal}>
                    {bizHome?.summary?.pendingInvoiceCount ?? 0}
                  </Text>
                </View>
              </View>
            </View>

            {/* Dedicated Business Operations Grid (mirrors Telegram Bot Business Menu) */}
            <Text style={styles.activityTitle}>Business tools</Text>
            <View style={styles.bizGrid}>
              <PressableScale onPress={() => onNavigate("business")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="document-text-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Invoices</Text>
                <Text style={styles.rowSub}>Create &amp; bill clients</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="people-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Pay Team</Text>
                <Text style={styles.rowSub}>27-currency CSV payroll</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="receipt-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Expenses</Text>
                <Text style={styles.rowSub}>Track monthly spend</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="link-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Payment Links</Text>
                <Text style={styles.rowSub}>Share checkout URLs</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("global")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="globe-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Global Accounts</Text>
                <Text style={styles.rowSub}>USD, GBP, EUR &amp; more</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("cards")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="card-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Team USD Cards</Text>
                <Text style={styles.rowSub}>Virtual company cards</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("savings")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="trending-up-outline" size={22} color={COLORS.success} />
                <Text style={styles.rowTitle}>Treasury Yield</Text>
                <Text style={styles.rowSub}>Business savings</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("bills")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="flash-outline" size={22} color={COLORS.primary} />
                <Text style={styles.rowTitle}>Pay Bills</Text>
                <Text style={styles.rowSub}>Utilities &amp; office</Text>
              </PressableScale>
            </View>
          </>
        ) : (
          <>
            {/* Grow your money (Personal) */}
            <Text style={styles.activityTitle}>Grow your money</Text>
            <View style={styles.growRow}>
              <PressableScale onPress={() => onNavigate("savings")} depth={0.97} style={styles.featureCard}>
                <SavingsLogoMerger size={26} showBadge={false} />
                <View style={{ gap: 2 }}>
                  <Text style={styles.rowTitle}>Savings</Text>
                  <Text style={styles.rowSub}>Earn daily, withdraw anytime</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("stocks")} depth={0.97} style={styles.featureCard}>
                <StockLogoMerger size={26} />
                <View style={{ gap: 2 }}>
                  <Text style={styles.rowTitle}>US Stocks & ETFs</Text>
                  <Text style={styles.rowSub}>Start from $1</Text>
                </View>
              </PressableScale>
            </View>

            {/* Pay bills: one tap per bill type */}
            <Text style={styles.activityTitle}>Pay bills</Text>
            <View style={styles.billGrid}>
              {BILL_CATEGORIES.map((c) => (
                <BillCategoryTile key={c.key} cat={c} onPress={() => onOpenBill?.(c.key)} />
              ))}
            </View>
          </>
        )}

        <View style={styles.activityHead}>
          <Text style={styles.activityTitle}>Recent activity</Text>
          {transactions.length > 0 ? (
            <PressableScale onPress={() => onNavigate("activity")} haptic="selection" style={styles.seeAll} accessibilityRole="button">
              <Text style={styles.seeAllText}>See all</Text>
              <Ionicons name="chevron-forward" size={16} color={COLORS.goldDark} />
            </PressableScale>
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <SectionList
        sections={loading && transactions.length === 0 ? [] : groupByDay(transactions.slice(0, HOME_ACTIVITY_COUNT))}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <TxRow tx={item} onPress={() => setSelectedTx(item)} />}
        renderSectionHeader={({ section }) => <Text style={styles.dayHeader}>{section.title}</Text>}
        stickySectionHeadersEnabled={false}
        ListFooterComponent={
          transactions.length > HOME_ACTIVITY_COUNT ? (
            <Button
              title={`View all activity (${transactions.length})`}
              variant="secondary"
              onPress={() => onNavigate("activity")}
              style={{ marginTop: 14 }}
            />
          ) : undefined
        }
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
    backgroundColor: COLORS.page,
  },
  listContent: {
    paddingHorizontal: SPACING.md,
    paddingTop: 0,
    paddingBottom: 24,
  },
  topSection: {
    marginBottom: 8,
  },
  // Edge-to-edge Proxim Forest header: the balance owns the top of the screen.
  hero: {
    marginHorizontal: -SPACING.md,
    paddingHorizontal: SPACING.md + 4,
    paddingTop: 8,
    paddingBottom: 22,
    backgroundColor: COLORS.forest,
    borderBottomLeftRadius: RADIUS.xl,
    borderBottomRightRadius: RADIUS.xl,
    gap: 6,
    ...DEPTH.forest,
  },
  heroBiz: {
    backgroundColor: "#1B160C",
    borderBottomWidth: 2,
    borderBottomColor: COLORS.goldDark,
  },
  iconBtnBiz: {
    backgroundColor: "#2C2415",
    borderColor: "#4A3B1E",
  },
  heroSeg: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: HERO.chip,
    borderWidth: 1,
    borderColor: HERO.border,
    borderRadius: RADIUS.pill,
    padding: 3,
    gap: 3,
  },
  heroSegBiz: {
    backgroundColor: "#2C2415",
    borderColor: "#4A3B1E",
  },
  heroSegBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RADIUS.pill,
  },
  heroSegBtnOn: {
    backgroundColor: COLORS.white,
  },
  heroSegBtnBizOn: {
    backgroundColor: COLORS.gold,
  },
  heroSegText: {
    ...TYPE.label,
    fontSize: 12,
    color: HERO.textSecondary,
  },
  heroSegTextOn: {
    color: COLORS.primary,
    fontFamily: TYPE.title.fontFamily,
  },
  heroSegTextBizOn: {
    color: COLORS.onGold,
    fontFamily: TYPE.title.fontFamily,
  },
  curChipBiz: {
    backgroundColor: "#2C2415",
    borderColor: "#4A3B1E",
  },
  ngnRowBiz: {
    backgroundColor: "#2C2415",
    borderColor: "#4A3B1E",
  },
  bizSummaryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: 14,
    gap: 10,
    ...DEPTH.card,
    borderColor: COLORS.businessBorder,
  },
  bizSummaryHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bizSummaryTitle: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
  },
  bizTierBadge: {
    backgroundColor: COLORS.businessMuted,
    borderWidth: 1,
    borderColor: COLORS.businessBorder,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  bizTierBadgeText: {
    ...TYPE.label,
    fontSize: 11,
    color: COLORS.business,
    fontFamily: TYPE.title.fontFamily,
  },
  bizMetricsRow: {
    flexDirection: "row",
    gap: 8,
  },
  bizMetric: {
    flex: 1,
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.sm,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bizMetricLabel: {
    ...TYPE.label,
    fontSize: 11,
    color: COLORS.textSecondary,
  },
  bizMetricVal: {
    ...TYPE.bodyStrong,
    fontSize: 15,
    color: COLORS.text,
    marginTop: 2,
  },
  bizGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  bizTile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: 13,
    gap: 4,
    ...DEPTH.card,
  },
  below: {
    gap: 14,
    paddingTop: 18,
  },
  greetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  greetSub: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  greetName: {
    ...TYPE.headline,
    color: HERO.text,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: HERO.chip,
    borderWidth: 1,
    borderColor: HERO.border,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    position: "absolute",
    top: 9,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: COLORS.danger,
    borderWidth: 1.5,
    borderColor: COLORS.forest,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  acctLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 6,
    paddingRight: 6,
    minHeight: 36,
  },
  acctLabel: {
    ...TYPE.overline,
    color: HERO.textSecondary,
  },
  curChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 5,
    paddingRight: 11,
    height: 32,
    borderRadius: RADIUS.pill,
    backgroundColor: HERO.chip,
    borderWidth: 1,
    borderColor: HERO.border,
  },
  curChipOn: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.white,
  },
  curChipText: {
    ...TYPE.label,
    fontFamily: TYPE.overline.fontFamily,
    color: HERO.textSecondary,
  },
  curChipTextOn: {
    color: COLORS.forest,
  },
  balLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 56,
  },
  balLoadingText: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  totalAmount: {
    ...TYPE.xl,
    color: HERO.text,
    flexShrink: 1,
  },
  totalCents: {
    fontSize: 26,
    color: HERO.textSecondary,
  },
  subLine: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  eyeBtn: {
    padding: 8,
  },
  extraLine: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  ngnRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: HERO.inset,
    borderWidth: 1,
    borderColor: HERO.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: 12,
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
  copyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.gold,
  },
  copyPillText: {
    ...TYPE.label,
    fontFamily: TYPE.title.fontFamily,
    color: COLORS.onGold,
  },
  qaRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  qaWide: {
    flex: 1,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: RADIUS.md,
  },
  qaGold: {
    backgroundColor: COLORS.gold,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.goldDark,
  },
  qaWhite: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 3,
    borderBottomColor: "#C9D3CE",
  },
  qaWideLabel: {
    ...TYPE.bodyStrong,
    fontFamily: TYPE.xl.fontFamily,
    fontSize: 16,
    color: COLORS.primary,
  },
  growRow: {
    flexDirection: "row",
    gap: 10,
  },
  featureCard: {
    flex: 1,
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
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  billGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  activityHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  activityTitle: {
    ...TYPE.headline,
    fontFamily: TYPE.xl.fontFamily,
    color: COLORS.text,
    marginBottom: -4,
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
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    ...DEPTH.card,
  },
  seeAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  seeAllText: {
    ...TYPE.bodyStrong,
    color: COLORS.goldDark,
  },
});
