import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
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
import { useTheme } from "../state/ThemeContext";
import { COLORS, DEPTH, FONTS, HERO, RADIUS, SPACING, TABULAR_NUMS, TYPE, createThemeStyles } from "../theme";
import {
  Button,
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatUsdc,
  StatusBadge,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { SavingsLogoMerger, StockLogoMerger } from "../components/AssetLogoCluster";
import { PressableScale } from "../components/Touch";
import { UserAvatar } from "../components/Avatar";
import { BILL_CATEGORIES, BillCat } from "../components/bills";
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
  | "business_invoices"
  | "business_payroll"
  | "business_expenses"
  | "business_links"
  | "business_profile"
  | "kyc"
  | "kyb"
  | "notifications"
  | "activity";

const HOME_ACTIVITY_COUNT = 6;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
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
    refreshMe,
    switchAccount,
    switchingAccount,
    requestApproval,
    balanceHidden: hidden,
    toggleBalanceHidden,
  } = useApp();
  useTheme();

  const [savingSettlement, setSavingSettlement] = useState(false);
  const [dismissedNudge, setDismissedNudge] = useState(false);
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
        if (isRefresh) {
          refreshMe().catch(() => {});
        }
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
    [activeAccount, refreshMe]
  );

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
  const dot = mainText.lastIndexOf(".");
  const whole = dot > 0 ? mainText.slice(0, dot) : mainText;
  const cents = dot > 0 ? mainText.slice(dot) : "";

  const heroActions: Array<{
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    primary?: boolean;
    bright?: boolean;
    rotate?: boolean;
    onPress: () => void;
  }> = isBiz
    ? [
        { key: "add", label: "Add", icon: "add", primary: true, onPress: () => onNavigate("add") },
        { key: "send", label: "Send", icon: "arrow-up", bright: true, rotate: true, onPress: () => onNavigate("send") },
        { key: "inv", label: "Invoices", icon: "document-text-outline", onPress: () => onNavigate("business_invoices") },
        { key: "pay", label: "Payroll", icon: "people-outline", onPress: () => onNavigate("business_payroll") },
      ]
    : [
        { key: "add", label: "Add", icon: "add", primary: true, onPress: () => onNavigate("add") },
        { key: "send", label: "Send", icon: "arrow-up", bright: true, rotate: true, onPress: () => onNavigate("send") },
        { key: "swap", label: "Swap", icon: "swap-horizontal", onPress: () => onNavigate("swap") },
        { key: "bills", label: "Bills", icon: "flash-outline", onPress: () => onNavigate("bills") },
      ];

  const showSettlementPrompt =
    ((user?.kycTier ?? 0) >= 1 || (user?.personalKycTier ?? 0) >= 1 || (user?.businessKycTier ?? 0) >= 1) &&
    !user?.depositSettlementChosen;

  // Single contextual next-best-action card (replaces noisy 4-slide ad carousel)
  const contextualCard = !showSettlementPrompt && !dismissedNudge ? (
    !isVerified ? (
      <PressableScale onPress={() => onNavigate(isBiz ? "kyb" : "kyc")} depth={0.98} style={styles.nudgeCard}>
        <View style={styles.nudgeIcon}>
          <Ionicons name="shield-checkmark-outline" size={20} color={COLORS.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.nudgeOverline}>{isBiz ? "COMPANY VERIFICATION" : "UNLOCK GLOBAL BANKING"}</Text>
          <Text style={styles.nudgeTitle} numberOfLines={1}>
            {isBiz ? "Verify KYB for USD, GBP & EUR accounts" : "Verify ID for USD, GBP, EUR & Cards"}
          </Text>
          <Text style={styles.nudgeSub} numberOfLines={1}>
            Receive in 10 currencies & spend globally with virtual USD cards
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
      </PressableScale>
    ) : !isBiz ? (
      <View style={styles.quickStripRow}>
        <PressableScale onPress={() => onNavigate("global")} depth={0.97} style={styles.quickStripChip}>
          <Ionicons name="globe-outline" size={15} color={COLORS.primary} />
          <Text style={styles.quickStripText} numberOfLines={1}>Global Accounts</Text>
        </PressableScale>
        <PressableScale onPress={() => onNavigate("cards")} depth={0.97} style={styles.quickStripChip}>
          <Ionicons name="card-outline" size={15} color={COLORS.primary} />
          <Text style={styles.quickStripText} numberOfLines={1}>USD Cards</Text>
        </PressableScale>
        <PressableScale onPress={() => handleSelectAccount("business")} depth={0.97} style={styles.quickStripChip}>
          <Ionicons name="briefcase-outline" size={15} color={COLORS.business} />
          <Text style={styles.quickStripText} numberOfLines={1}>Business</Text>
        </PressableScale>
      </View>
    ) : null
  ) : null;

  const header = (
    <View style={styles.topSection}>
      <View style={[styles.hero, isBiz && styles.heroBiz]}>
        {/* Top bar: Avatar + Greeting + AI + Notifications */}
        <View style={styles.greetRow}>
          <PressableScale onPress={onOpenProfile} depth={0.94} accessibilityLabel="Open profile">
            <UserAvatar size={36} name={isBiz ? displayName : null} />
          </PressableScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.greetSub}>{isBiz ? "BUSINESS WORKSPACE" : greeting()}</Text>
            <Text style={styles.greetName} numberOfLines={1}>{displayName}</Text>
          </View>
          <PressableScale
            onPress={() => onNavigate("assistant")}
            depth={0.92}
            style={[styles.iconBtn, isBiz && styles.iconBtnBiz]}
            accessibilityLabel="Ask Proxim"
          >
            <Ionicons name="sparkles" size={16} color={HERO.accent} />
          </PressableScale>
          <PressableScale
            onPress={() => onNavigate("notifications")}
            depth={0.92}
            style={[styles.iconBtn, isBiz && styles.iconBtnBiz]}
            accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
          >
            <Ionicons name="notifications-outline" size={17} color={HERO.text} />
            {unread > 0 ? <View style={styles.unreadDot} /> : null}
          </PressableScale>
        </View>

        {/* Account switcher + currency view toggle */}
        <View style={styles.switchRow}>
          <View style={[styles.heroSeg, isBiz && styles.heroSegBiz]}>
            <PressableScale
              onPress={() => handleSelectAccount("personal")}
              haptic="selection"
              style={[styles.heroSegBtn, !isBiz && styles.heroSegBtnOn]}
              accessibilityLabel="Switch to Personal account"
            >
              <Ionicons name="person" size={11} color={!isBiz ? "#001A13" : HERO.textSecondary} />
              <Text style={[styles.heroSegText, !isBiz && styles.heroSegTextOn]}>Personal</Text>
            </PressableScale>
            <PressableScale
              onPress={() => handleSelectAccount("business")}
              haptic="selection"
              style={[styles.heroSegBtn, isBiz && styles.heroSegBtnBizOn]}
              accessibilityLabel="Switch to Business account"
            >
              <Ionicons name="briefcase" size={11} color={isBiz ? COLORS.onGold : HERO.textSecondary} />
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
                <CurrencyLogo code={code} size={14} />
                <Text style={[styles.curChipText, on && styles.curChipTextOn]}>{code}</Text>
              </PressableScale>
            );
          })}
        </View>

        {/* Primary Total Balance */}
        {loading && !balance ? (
          <View style={styles.balLoading}>
            <ActivityIndicator color={HERO.accent} size="small" />
            <Text style={styles.balLoadingText}>Loading balance…</Text>
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
              <Ionicons name={hidden ? "eye-off-outline" : "eye-outline"} size={18} color={HERO.textSecondary} />
            </PressableScale>
          </View>
        )}

        {balance ? (
          <Text style={styles.subLine}>
            {hidden ? "Balance hidden" : subText}
            {ngnRate
              ? `  ·  $1 = ₦${Number(ngnRate).toLocaleString("en-NG", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
              : ""}
          </Text>
        ) : null}

        {/* Interactive multi-currency pockets */}
        {!hidden && (balance?.fiatBalances?.length ?? 0) > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 6 }}
            contentContainerStyle={{ gap: 6 }}
          >
            {(balance?.fiatBalances || []).map((p) => (
              <PressableScale
                key={`${p.currency}-${p.accountId}`}
                onPress={() => onNavigate("global")}
                depth={0.96}
                style={styles.pocketPill}
              >
                <CurrencyLogo code={p.currency} size={14} />
                <Text style={styles.pocketText}>
                  {p.currency === "NGN"
                    ? `₦${Math.round(p.available).toLocaleString("en-NG")}`
                    : `${p.symbol}${p.available.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`}
                </Text>
              </PressableScale>
            ))}
          </ScrollView>
        ) : null}

        {!hidden && (eurcBal > 0 || pendingBridge > 0) ? (
          <Text style={styles.extraLine}>
            {[
              eurcBal > 0 ? `Includes €${eurcBal.toFixed(2)} in EUR` : null,
              pendingBridge > 0 ? `${formatUsdc(pendingBridge)} arriving` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}

        {/* Naira receiving account strip */}
        {ngnAccount?.accountNumber ? (
          <View style={[styles.ngnRow, isBiz && styles.ngnRowBiz]}>
            <CurrencyLogo code="NGN" size={18} />
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
              <Ionicons name="copy-outline" size={12} color={COLORS.onGold} />
              <Text style={styles.copyPillText}>Copy</Text>
            </PressableScale>
          </View>
        ) : (
          <PressableScale
            onPress={() => onNavigate(isVerified ? "global" : isBiz ? "kyb" : "kyc")}
            depth={0.98}
            style={[styles.ngnRow, isBiz && styles.ngnRowBiz]}
          >
            <CurrencyLogo code="NGN" size={18} />
            <Text style={[styles.ngnCta, { flex: 1 }]} numberOfLines={1}>
              {isVerified
                ? isBiz
                  ? "Open your company global bank accounts"
                  : "Get your naira account number"
                : isBiz
                  ? "Verify KYB to unlock company global accounts"
                  : "Verify ID to unlock global accounts & cards"}
            </Text>
            <Ionicons name="chevron-forward" size={15} color={HERO.accent} />
          </PressableScale>
        )}

        {/* 4-Action Institutional Rail */}
        <View style={styles.actionRail}>
          {heroActions.map((act) => (
            <PressableScale
              key={act.key}
              onPress={act.onPress}
              depth={0.94}
              haptic={act.primary ? "medium" : "light"}
              style={styles.actionSlot}
              accessibilityRole="button"
              accessibilityLabel={act.label}
            >
              <View
                style={[
                  styles.actionIconBox,
                  act.primary && styles.actionIconPrimary,
                  act.bright && styles.actionIconBright,
                  !act.primary && !act.bright && isBiz && styles.actionIconBiz,
                ]}
              >
                <Ionicons
                  name={act.icon}
                  size={20}
                  color={act.primary ? COLORS.onGold : act.bright ? "#001A13" : HERO.text}
                  style={act.rotate ? { transform: [{ rotate: "45deg" }] } : undefined}
                />
              </View>
              <Text style={styles.actionLabel}>{act.label}</Text>
            </PressableScale>
          ))}
        </View>
      </View>

      <View style={styles.below}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

        {showSettlementPrompt ? (
          <View style={styles.settlementCard}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="checkmark-circle" size={15} color={HERO.accent} />
              <Text style={styles.settlementOverline}>VERIFIED · DEPOSIT SETTLEMENT</Text>
            </View>
            <Text style={styles.settlementTitle}>How should incoming bank deposits settle?</Text>
            <Text style={styles.settlementSub}>
              Keep deposits in their local currency (NGN, GBP, EUR, USD…) or auto-convert to USD — 0% fee either way.
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              <PressableScale
                onPress={async () => {
                  if (savingSettlement) return;
                  setSavingSettlement(true);
                  setError(null);
                  try {
                    await api.updateProfile({ depositSettlementMode: "local" });
                    await refreshMe();
                    setCopiedMsg("Saved: Deposits remain in local currencies.");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not save preference.");
                  } finally {
                    setSavingSettlement(false);
                  }
                }}
                style={styles.settlementPrimaryBtn}
              >
                <Text style={styles.settlementPrimaryText}>Hold Local Currency</Text>
              </PressableScale>
              <PressableScale
                onPress={async () => {
                  if (savingSettlement) return;
                  setSavingSettlement(true);
                  setError(null);
                  try {
                    await api.updateProfile({ depositSettlementMode: "usdc" });
                    await refreshMe();
                    setCopiedMsg("Saved: Deposits auto-convert to USD.");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not save preference.");
                  } finally {
                    setSavingSettlement(false);
                  }
                }}
                style={styles.settlementGhostBtn}
              >
                <Text style={styles.settlementGhostText}>Auto-Convert USD</Text>
              </PressableScale>
            </View>
          </View>
        ) : null}

        {isBiz ? (
          <>
            {/* Business Cash Flow KPI card */}
            <View style={styles.bizSummaryCard}>
              <View style={styles.bizSummaryHead}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="briefcase" size={15} color={COLORS.business} />
                  <Text style={styles.bizSummaryTitle}>This Month · Cash Flow</Text>
                </View>
                <PressableScale onPress={() => onNavigate(isVerified ? "global" : "kyb")}>
                  <StatusBadge
                    label={isVerified ? "Verified" : "Verify KYB"}
                    icon={isVerified ? "checkmark-circle" : "shield-outline"}
                    tone={isVerified ? "success" : "business"}
                  />
                </PressableScale>
              </View>
              <View style={styles.bizMetricsRow}>
                <View style={styles.bizMetric}>
                  <Text style={styles.bizMetricLabel}>Income</Text>
                  <Text style={[styles.bizMetricVal, { color: COLORS.successText }]}>
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
                  <Text style={styles.bizMetricVal}>{bizHome?.summary?.pendingInvoiceCount ?? 0}</Text>
                </View>
              </View>
            </View>

            {contextualCard}

            <Text style={styles.sectionLabel}>Business tools</Text>
            <View style={styles.bizGrid}>
              {(
                [
                  ["business_invoices", "document-text-outline", "Invoices", "Bill clients globally", COLORS.business],
                  ["business_payroll", "people-outline", "Pay Team", "27-currency payroll", COLORS.business],
                  ["business_expenses", "receipt-outline", "Expenses", "Track team spend", COLORS.business],
                  ["business_links", "link-outline", "Payment Links", "Share checkout URLs", COLORS.business],
                  ["global", "globe-outline", "Global Accounts", "USD, GBP, EUR & more", COLORS.business],
                  ["cards", "card-outline", "Team Cards", "Virtual USD cards", COLORS.business],
                  ["business_profile", "storefront-outline", "Company Profile", "Branding & reserve", COLORS.business],
                  ["savings", "trending-up-outline", "Treasury Yield", "Daily USD yield", COLORS.successText],
                ] as Array<[HomeModalTarget, keyof typeof Ionicons.glyphMap, string, string, string]>
              ).map(([target, icon, title, sub, color]) => (
                <PressableScale key={target} onPress={() => onNavigate(target)} depth={0.97} style={styles.bizTile}>
                  <View style={styles.bizTileIcon}>
                    <Ionicons name={icon} size={18} color={color} />
                  </View>
                  <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>
                </PressableScale>
              ))}
            </View>
          </>
        ) : (
          <>
            {/* Compact Grow Wealth Strip: Savings & US Stocks */}
            <View style={styles.growRow}>
              <PressableScale onPress={() => onNavigate("savings")} depth={0.97} style={styles.featureCard}>
                <View style={styles.featureCardTop}>
                  <SavingsLogoMerger size={18} showBadge={false} />
                  <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
                </View>
                <View>
                  <Text style={styles.featureTitle} numberOfLines={1}>Dollar Savings</Text>
                  <Text style={styles.featureSub} numberOfLines={1}>Daily yield · anytime</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("stocks")} depth={0.97} style={styles.featureCard}>
                <View style={styles.featureCardTop}>
                  <StockLogoMerger size={18} showCount={false} />
                  <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
                </View>
                <View>
                  <Text style={styles.featureTitle} numberOfLines={1}>US Stocks &amp; ETFs</Text>
                  <Text style={styles.featureSub} numberOfLines={1}>470+ stocks from $1</Text>
                </View>
              </PressableScale>
            </View>

            {contextualCard}

            {/* Single-row quick bill shortcuts (keeps Activity high above the fold) */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.billStrip}
            >
              {BILL_CATEGORIES.map((c) => (
                <PressableScale
                  key={c.key}
                  onPress={() => onOpenBill?.(c.key)}
                  depth={0.95}
                  style={styles.billChip}
                >
                  <View style={[styles.billChipIcon, { backgroundColor: c.bg }]}>
                    <Ionicons name={c.icon} size={13} color={c.fg} />
                  </View>
                  <Text style={styles.billChipText}>{c.label}</Text>
                </PressableScale>
              ))}
            </ScrollView>
          </>
        )}

        <View style={styles.activityHead}>
          <Text style={styles.sectionLabel}>Recent activity</Text>
          {transactions.length > 0 ? (
            <PressableScale onPress={() => onNavigate("activity")} haptic="selection" style={styles.seeAll} accessibilityRole="button">
              <Text style={styles.seeAllText}>See all</Text>
              <Ionicons name="chevron-forward" size={15} color={COLORS.goldDark} />
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
              style={{ marginTop: 12 }}
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
            <SkeletonRows count={4} />
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

const styles = createThemeStyles(() => ({
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
    marginBottom: 4,
  },
  hero: {
    marginHorizontal: -SPACING.md,
    paddingHorizontal: SPACING.md + 2,
    paddingTop: 6,
    paddingBottom: 14,
    backgroundColor: COLORS.forest,
    borderBottomLeftRadius: RADIUS.xl,
    borderBottomRightRadius: RADIUS.xl,
    gap: 5,
    ...DEPTH.forest,
  },
  heroBiz: {
    backgroundColor: "#0F172A",
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  iconBtnBiz: {
    backgroundColor: "#1E293B",
    borderColor: "#334155",
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
    backgroundColor: "#1E293B",
    borderColor: "#334155",
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
    color: "#001A13",
    fontFamily: FONTS.bold,
  },
  heroSegTextBizOn: {
    color: COLORS.onGold,
    fontFamily: FONTS.bold,
  },
  curChipBiz: {
    backgroundColor: "#1E293B",
    borderColor: "#334155",
  },
  ngnRowBiz: {
    backgroundColor: "#1E293B",
    borderColor: "#334155",
  },
  greetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  greetSub: {
    ...TYPE.overline,
    fontSize: 10,
    color: HERO.textSecondary,
  },
  greetName: {
    ...TYPE.bodyStrong,
    fontSize: 15,
    color: HERO.text,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: HERO.chip,
    borderWidth: 1,
    borderColor: HERO.border,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    position: "absolute",
    top: 6,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.danger,
    borderWidth: 1.5,
    borderColor: COLORS.forest,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  curChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 4,
    paddingRight: 8,
    height: 28,
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
    fontSize: 11,
    fontFamily: FONTS.bold,
    color: HERO.textSecondary,
  },
  curChipTextOn: {
    color: "#001A13",
  },
  balLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 40,
  },
  balLoadingText: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  totalAmount: {
    ...TYPE.xl,
    fontSize: 32,
    lineHeight: 38,
    color: HERO.text,
    flexShrink: 1,
  },
  totalCents: {
    fontSize: 20,
    color: HERO.textSecondary,
  },
  subLine: {
    ...TYPE.label,
    ...TABULAR_NUMS,
    fontSize: 12,
    color: HERO.textSecondary,
  },
  eyeBtn: {
    padding: 4,
  },
  pocketPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
  pocketText: {
    ...TABULAR_NUMS,
    fontSize: 12,
    fontFamily: FONTS.bold,
    color: HERO.text,
  },
  extraLine: {
    ...TYPE.label,
    ...TABULAR_NUMS,
    fontSize: 11.5,
    color: HERO.textSecondary,
  },
  ngnRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: HERO.inset,
    borderWidth: 1,
    borderColor: HERO.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  ngnLabel: {
    ...TYPE.label,
    fontSize: 11,
    color: HERO.textSecondary,
  },
  ngnNumber: {
    ...TYPE.bodyStrong,
    ...TABULAR_NUMS,
    fontSize: 13.5,
    color: HERO.text,
    letterSpacing: 0.7,
  },
  ngnCta: {
    ...TYPE.label,
    fontSize: 12,
    color: HERO.accent,
  },
  copyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.gold,
  },
  copyPillText: {
    ...TYPE.label,
    fontSize: 11,
    fontFamily: FONTS.bold,
    color: COLORS.onGold,
  },
  actionRail: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 10,
  },
  actionSlot: {
    flex: 1,
    alignItems: "center",
    gap: 5,
  },
  actionIconBox: {
    width: "100%",
    height: 44,
    borderRadius: RADIUS.md,
    backgroundColor: HERO.chip,
    borderWidth: 1,
    borderColor: HERO.border,
    alignItems: "center",
    justifyContent: "center",
  },
  actionIconPrimary: {
    backgroundColor: COLORS.gold,
    borderColor: COLORS.gold,
  },
  actionIconBright: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.white,
  },
  actionIconBiz: {
    backgroundColor: "#1E293B",
    borderColor: "#334155",
  },
  actionLabel: {
    fontFamily: FONTS.semibold,
    fontSize: 11.5,
    color: HERO.text,
  },
  below: {
    gap: 10,
    paddingTop: 12,
  },
  settlementCard: {
    backgroundColor: COLORS.forest,
    borderRadius: RADIUS.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: HERO.border,
    gap: 6,
  },
  settlementOverline: {
    fontSize: 10.5,
    fontFamily: FONTS.extrabold,
    letterSpacing: 0.7,
    color: HERO.accent,
  },
  settlementTitle: {
    fontSize: 15.5,
    fontFamily: FONTS.bold,
    color: COLORS.white,
  },
  settlementSub: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: FONTS.regular,
    color: HERO.textSecondary,
  },
  settlementPrimaryBtn: {
    flex: 1,
    backgroundColor: COLORS.gold,
    borderRadius: RADIUS.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  settlementPrimaryText: {
    fontSize: 12.5,
    fontFamily: FONTS.bold,
    color: COLORS.onGold,
  },
  settlementGhostBtn: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: RADIUS.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  settlementGhostText: {
    fontSize: 12.5,
    fontFamily: FONTS.semibold,
    color: COLORS.white,
  },
  nudgeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
    borderColor: COLORS.primaryBorder,
  },
  nudgeIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  nudgeOverline: {
    fontFamily: FONTS.extrabold,
    fontSize: 9.5,
    letterSpacing: 0.6,
    color: COLORS.goldDark,
  },
  nudgeTitle: {
    ...TYPE.bodyStrong,
    fontSize: 13.5,
    color: COLORS.text,
  },
  nudgeSub: {
    ...TYPE.label,
    fontSize: 11.5,
    color: COLORS.textSecondary,
  },
  quickStripRow: {
    flexDirection: "row",
    gap: 8,
  },
  quickStripChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  quickStripText: {
    fontFamily: FONTS.bold,
    fontSize: 11.5,
    color: COLORS.text,
  },
  growRow: {
    flexDirection: "row",
    gap: 8,
  },
  featureCard: {
    flex: 1,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  featureCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  featureTitle: {
    ...TYPE.bodyStrong,
    fontSize: 13.5,
    color: COLORS.text,
  },
  featureSub: {
    ...TYPE.label,
    fontSize: 11.5,
    color: COLORS.textSecondary,
  },
  billStrip: {
    gap: 8,
    paddingVertical: 2,
  },
  billChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  billChipIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  billChipText: {
    fontFamily: FONTS.semibold,
    fontSize: 12,
    color: COLORS.text,
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
    ...TABULAR_NUMS,
    fontSize: 15,
    color: COLORS.text,
    marginTop: 2,
  },
  bizGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  bizTile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: 12,
    gap: 4,
    ...DEPTH.card,
  },
  bizTileIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  rowTitle: {
    ...TYPE.bodyStrong,
    fontSize: 13.5,
    color: COLORS.text,
  },
  rowSub: {
    ...TYPE.label,
    fontSize: 11.5,
    color: COLORS.textSecondary,
  },
  activityHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  sectionLabel: {
    ...TYPE.headline,
    fontFamily: FONTS.extrabold,
    fontSize: 15.5,
    color: COLORS.text,
  },
  dayHeader: {
    ...TYPE.overline,
    color: COLORS.textMuted,
    marginTop: 10,
    marginBottom: 6,
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
    minHeight: 36,
    paddingHorizontal: 6,
  },
  seeAllText: {
    ...TYPE.label,
    fontFamily: FONTS.bold,
    color: COLORS.goldDark,
  },
}));
