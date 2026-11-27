import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageSourcePropType,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  SectionList,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
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
import { StockLogo } from "../components/StockLogo";
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
  | "business_invoices"
  | "business_payroll"
  | "business_expenses"
  | "business_links"
  | "business_profile"
  | "kyc"
  | "kyb"
  | "notifications"
  | "activity";


// Home shows only the newest few; "See all" opens the full Activity screen.
const HOME_ACTIVITY_COUNT = 5;
const BANNER_GAP = 10;

const BANNER_ART_ABROAD = require("../../assets/banners/banner_abroad.png");
const BANNER_ART_BUSINESS = require("../../assets/banners/banner_business.png");
const BANNER_ART_CARDS = require("../../assets/banners/banner_cards.png");
const BANNER_ART_SAVINGS = require("../../assets/banners/banner_savings.png");

type BannerLogoRef =
  | { kind: "currency"; code: string }
  | { kind: "brand"; ticker: string; domain: string };

type PromoBannerItem = {
  key: "abroad" | "business" | "cards" | "savings";
  badge: string;
  title: string;
  subtitle: string;
  cta: string;
  artifact: ImageSourcePropType;
  logos: BannerLogoRef[];
  bg: string;
  border: string;
  lip: string;
  haloBg: string;
  badgeBg: string;
  badgeColor: string;
  titleColor: string;
  subColor: string;
  ctaColor: string;
};

// Each banner showcases a distinct primary color from Proxim's Forest & Gold brand palette.
const PROMO_BANNERS: PromoBannerItem[] = [
  {
    key: "abroad",
    badge: "27+ CURRENCIES",
    title: "Send money abroad",
    subtitle: "UK, US, EU, Ghana & Kenya",
    cta: "Send now",
    artifact: BANNER_ART_ABROAD,
    logos: [
      { kind: "currency", code: "USD" },
      { kind: "currency", code: "GBP" },
      { kind: "currency", code: "EUR" },
      { kind: "currency", code: "GHS" },
      { kind: "currency", code: "KES" },
    ],
    bg: COLORS.forest, // Primary: Proxim Forest (#002018)
    border: COLORS.forest700,
    lip: COLORS.primaryDark,
    haloBg: "rgba(0, 176, 96, 0.18)",
    badgeBg: "rgba(224, 168, 46, 0.22)",
    badgeColor: COLORS.gold,
    titleColor: COLORS.white,
    subColor: HERO.textSecondary,
    ctaColor: COLORS.gold,
  },
  {
    key: "business",
    badge: "PROXIM BUSINESS",
    title: "Proxim Business Account",
    subtitle: "Invoices, links & global payroll",
    cta: "Explore Business",
    artifact: BANNER_ART_BUSINESS,
    logos: [
      { kind: "currency", code: "USD" },
      { kind: "currency", code: "GBP" },
      { kind: "currency", code: "EUR" },
      { kind: "currency", code: "NGN" },
    ],
    bg: COLORS.gold, // Primary: Proxim Gold (#E0A82E)
    border: "#C9921F",
    lip: COLORS.goldDark,
    haloBg: "rgba(255, 255, 255, 0.26)",
    badgeBg: "rgba(0, 32, 24, 0.14)",
    badgeColor: COLORS.forest,
    titleColor: COLORS.forest,
    subColor: "#3A2C0A",
    ctaColor: COLORS.forest,
  },
  {
    key: "cards",
    badge: "VIRTUAL USD CARDS",
    title: "Spend globally online",
    subtitle: "Netflix, Apple, Amazon & Ads",
    cta: "Get a card",
    artifact: BANNER_ART_CARDS,
    logos: [
      { kind: "brand", ticker: "NFLX", domain: "netflix.com" },
      { kind: "brand", ticker: "AAPL", domain: "apple.com" },
      { kind: "brand", ticker: "AMZN", domain: "amazon.com" },
      { kind: "brand", ticker: "META", domain: "meta.com" },
      { kind: "currency", code: "USD" },
    ],
    bg: COLORS.goldSoft, // Primary: Proxim Warm Champagne (#F6E7BF)
    border: COLORS.businessBorder,
    lip: "#C8A455",
    haloBg: "rgba(255, 255, 255, 0.55)",
    badgeBg: "rgba(0, 32, 24, 0.10)",
    badgeColor: COLORS.forest,
    titleColor: COLORS.forest,
    subColor: COLORS.textSecondary,
    ctaColor: COLORS.goldDark,
  },
  {
    key: "savings",
    badge: "AUTO-EARN YIELD",
    title: "Grow dollars daily",
    subtitle: "Earn on USDC & EURC anytime",
    cta: "Start saving",
    artifact: BANNER_ART_SAVINGS,
    logos: [
      { kind: "currency", code: "USDC" },
      { kind: "currency", code: "EURC" },
      { kind: "currency", code: "MORPHO" },
    ],
    bg: COLORS.success, // Primary: Proxim Emerald (#007840)
    border: COLORS.brandGreen,
    lip: "#004D29",
    haloBg: "rgba(246, 231, 191, 0.20)",
    badgeBg: "rgba(0, 32, 24, 0.26)",
    badgeColor: COLORS.goldSoft,
    titleColor: COLORS.white,
    subColor: "#D3F3E2",
    ctaColor: COLORS.goldSoft,
  },
];

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
  const { width: windowWidth } = useWindowDimensions();
  const bannerWidth = Math.max(250, Math.min(360, windowWidth - SPACING.md * 2 - 20));
  const bannerScrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const [activeBanner, setActiveBanner] = useState(0);
  const bannerDraggingRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (bannerDraggingRef.current) return;
      setActiveBanner((prev) => {
        const next = (prev + 1) % PROMO_BANNERS.length;
        bannerScrollRef.current?.scrollTo({ x: next * (bannerWidth + BANNER_GAP), animated: true });
        return next;
      });
    }, 6000);
    return () => clearInterval(timer);
  }, [bannerWidth]);

  const handleBannerScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    const idx = Math.max(0, Math.min(PROMO_BANNERS.length - 1, Math.round(x / (bannerWidth + BANNER_GAP))));
    setActiveBanner(idx);
  };

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

  const handleBannerPress = (key: PromoBannerItem["key"]) => {
    if (key === "abroad") {
      onNavigate("send");
    } else if (key === "business") {
      if (isBiz) onNavigate("business_profile");
      else handleSelectAccount("business");
    } else if (key === "cards") {
      onNavigate("cards");
    } else if (key === "savings") {
      onNavigate("savings");
    }
  };

  const promoBannerSection = (
    <View style={styles.promoSection}>
      <ScrollView
        ref={bannerScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={bannerWidth + BANNER_GAP}
        snapToAlignment="start"
        decelerationRate="fast"
        contentContainerStyle={styles.promoTrack}
        onScrollBeginDrag={() => {
          bannerDraggingRef.current = true;
        }}
        onScrollEndDrag={() => {
          bannerDraggingRef.current = false;
        }}
        onMomentumScrollEnd={(e) => {
          bannerDraggingRef.current = false;
          handleBannerScrollEnd(e);
        }}
      >
        {PROMO_BANNERS.map((b) => {
          const ctaLabel =
            b.key === "business"
              ? isBiz
                ? "Company profile"
                : user?.hasBusinessAccount
                  ? "Switch to Business"
                  : "Open Business"
              : b.cta;
          return (
            <PressableScale
              key={b.key}
              onPress={() => handleBannerPress(b.key)}
              depth={0.97}
              style={[
                styles.promoCard,
                {
                  width: bannerWidth,
                  backgroundColor: b.bg,
                  borderColor: b.border,
                  borderBottomColor: b.lip,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${b.title}. ${ctaLabel}`}
            >
              <View style={styles.promoLeft}>
                <View style={styles.promoMetaRow}>
                  <View style={[styles.promoBadge, { backgroundColor: b.badgeBg }]}>
                    <Text style={[styles.promoBadgeText, { color: b.badgeColor }]}>{b.badge}</Text>
                  </View>
                  <View style={styles.promoLogoCluster}>
                    {b.logos.map((logo, idx) => (
                      <View
                        key={logo.kind === "currency" ? logo.code : logo.ticker}
                        style={[
                          styles.promoLogoRing,
                          {
                            borderColor: b.bg,
                            marginLeft: idx === 0 ? 0 : -5,
                            zIndex: b.logos.length - idx,
                          },
                        ]}
                      >
                        {logo.kind === "currency" ? (
                          <CurrencyLogo code={logo.code} size={15} />
                        ) : (
                          <StockLogo
                            ticker={logo.ticker}
                            logoUrl={`https://assets.parqet.com/logos/symbol/${logo.ticker}?format=png`}
                            fallbackLogoUrl={`https://www.google.com/s2/favicons?domain=${logo.domain}&sz=128`}
                            size={15}
                          />
                        )}
                      </View>
                    ))}
                  </View>
                </View>

                <Text style={[styles.promoTitle, { color: b.titleColor }]} numberOfLines={1}>
                  {b.title}
                </Text>
                <View style={styles.promoBottomRow}>
                  <Text style={[styles.promoSub, { color: b.subColor }]} numberOfLines={1}>
                    {b.subtitle}
                  </Text>
                  <View style={styles.promoCtaRow}>
                    <Text style={[styles.promoCtaText, { color: b.ctaColor }]}>{ctaLabel}</Text>
                    <Ionicons name="arrow-forward" size={12} color={b.ctaColor} />
                  </View>
                </View>
              </View>

              <View style={styles.promoArtWrap}>
                <View style={[styles.promoArtHalo, { backgroundColor: b.haloBg }]} />
                <Image source={b.artifact} style={styles.promoArtImg} resizeMode="contain" />
              </View>
            </PressableScale>
          );
        })}
      </ScrollView>
      <View style={styles.promoDots}>
        {PROMO_BANNERS.map((b, i) => (
          <View
            key={b.key}
            style={[styles.promoDot, i === activeBanner && styles.promoDotActive]}
          />
        ))}
      </View>
    </View>
  );

  const header = (
    <View style={styles.topSection}>
      <View style={[styles.hero, isBiz && styles.heroBiz]}>
        {/* Greeting row */}
        <View style={styles.greetRow}>
          <PressableScale onPress={onOpenProfile} depth={0.94} accessibilityLabel="Open profile">
            <UserAvatar size={34} name={isBiz ? displayName : null} />
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
            <Ionicons name="sparkles" size={17} color={HERO.accent} />
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

        {/* Explicit 2-pill Personal / Business switch + currency switch */}
        <View style={styles.switchRow}>
          <View style={[styles.heroSeg, isBiz && styles.heroSegBiz]}>
            <PressableScale
              onPress={() => handleSelectAccount("personal")}
              haptic="selection"
              style={[styles.heroSegBtn, !isBiz && styles.heroSegBtnOn]}
              accessibilityLabel="Switch to Personal account"
            >
              <Ionicons name="person" size={11} color={!isBiz ? COLORS.primary : HERO.textSecondary} />
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
                <CurrencyLogo code={code} size={15} />
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
              <Ionicons name={hidden ? "eye-off-outline" : "eye-outline"} size={18} color={HERO.textSecondary} />
            </PressableScale>
          </View>
        )}
        {balance ? (
          <Text style={styles.subLine}>
            {hidden ? "Balance hidden" : subText}
            {ngnRate ? `  ·  $1 = ₦${Math.round(ngnRate).toLocaleString("en-NG")}` : ""}
          </Text>
        ) : null}
        {!hidden && (balance?.fiatBalances?.length ?? 0) > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 8 }}
            contentContainerStyle={{ gap: 6 }}
          >
            {(balance?.fiatBalances || []).map((p) => (
              <View
                key={`${p.currency}-${p.accountId}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.12)",
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.16)",
                }}
              >
                <CurrencyLogo code={p.currency} size={14} />
                <Text style={{ fontSize: 12, fontWeight: "700", color: HERO.text }}>
                  {p.currency === "NGN"
                    ? `₦${Math.round(p.available).toLocaleString("en-NG")}`
                    : `${p.symbol}${p.available.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </Text>
              </View>
            ))}
          </ScrollView>
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
              <Ionicons name="copy-outline" size={13} color={COLORS.onGold} />
              <Text style={styles.copyPillText}>Copy</Text>
            </PressableScale>
          </View>
        ) : (
          <PressableScale onPress={() => onNavigate(isVerified ? "global" : isBiz ? "kyb" : "kyc")} depth={0.98} style={[styles.ngnRow, isBiz && styles.ngnRowBiz]}>
            <CurrencyLogo code="NGN" size={18} />
            <Text style={[styles.ngnCta, { flex: 1 }]} numberOfLines={1}>
              {isVerified
                ? isBiz
                  ? "Open your company global bank accounts"
                  : "Get your naira account number"
                : isBiz
                  ? "Verify KYB to unlock company global accounts"
                  : "Verify KYC to unlock global accounts & cards"}
            </Text>
            <Ionicons name="chevron-forward" size={15} color={HERO.accent} />
          </PressableScale>
        )}

        {/* Compact Add money + Send action buttons */}
        <View style={styles.qaRow}>
          <PressableScale
            onPress={() => onNavigate("add")}
            depth={0.95}
            haptic="medium"
            style={[styles.qaWide, styles.qaGold]}
            accessibilityRole="button"
            accessibilityLabel="Add money"
          >
            <Ionicons name="add" size={18} color={COLORS.onGold} />
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
            <Ionicons name="arrow-up" size={18} color={COLORS.primary} style={{ transform: [{ rotate: "45deg" }] }} />
            <Text style={styles.qaWideLabel}>Send</Text>
          </PressableScale>
        </View>
      </View>

      <View style={styles.below}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={copiedMsg} onDismiss={() => setCopiedMsg(null)} />

        {isBiz ? (
          <>
            {/* Business Cash Flow & Unpaid Invoices summary */}
            <View style={styles.bizSummaryCard}>
              <View style={styles.bizSummaryHead}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="briefcase" size={16} color={COLORS.business} />
                  <Text style={styles.bizSummaryTitle}>This Month · Cash Flow</Text>
                </View>
                <PressableScale onPress={() => onNavigate(isVerified ? "global" : "kyb")} style={styles.bizTierBadge}>
                  <Text style={styles.bizTierBadgeText}>{isVerified ? "VERIFIED ✅" : "Verify KYB →"}</Text>
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

            {/* Floating feature & announcement banner carousel */}
            {promoBannerSection}

            {/* Dedicated Business Operations Grid */}
            <Text style={styles.activityTitle}>Business tools</Text>
            <View style={styles.bizGrid}>
              <PressableScale onPress={() => onNavigate("business_invoices")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="document-text-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Invoices</Text>
                <Text style={styles.rowSub}>Create &amp; bill clients</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business_payroll")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="people-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Pay Team</Text>
                <Text style={styles.rowSub}>27-currency CSV payroll</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business_expenses")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="receipt-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Expenses</Text>
                <Text style={styles.rowSub}>Track monthly spend</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("business_links")} depth={0.97} style={styles.bizTile}>
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
              <PressableScale onPress={() => onNavigate("business_profile")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="storefront-outline" size={22} color={COLORS.business} />
                <Text style={styles.rowTitle}>Company Profile</Text>
                <Text style={styles.rowSub}>Logo, address &amp; reserve</Text>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("swap")} depth={0.97} style={styles.bizTile}>
                <Ionicons name="swap-horizontal-outline" size={22} color={COLORS.primary} />
                <Text style={styles.rowTitle}>Swap USD ↔ EUR</Text>
                <Text style={styles.rowSub}>Instant FX conversion</Text>
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
            {/* Compact Savings & US Stocks tiles right below the balance box */}
            <View style={styles.growRow}>
              <PressableScale onPress={() => onNavigate("savings")} depth={0.97} style={styles.featureCard}>
                <View style={styles.featureCardTop}>
                  <SavingsLogoMerger size={18} showBadge={false} />
                  <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
                </View>
                <View style={{ gap: 0 }}>
                  <Text style={styles.featureTitle} numberOfLines={1}>Savings</Text>
                  <Text style={styles.featureSub} numberOfLines={1}>Daily yield · anytime</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onNavigate("stocks")} depth={0.97} style={styles.featureCard}>
                <View style={styles.featureCardTop}>
                  <StockLogoMerger size={18} showCount={false} />
                  <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
                </View>
                <View style={{ gap: 0 }}>
                  <Text style={styles.featureTitle} numberOfLines={1}>US Stocks &amp; ETFs</Text>
                  <Text style={styles.featureSub} numberOfLines={1}>470+ stocks from $1</Text>
                </View>
              </PressableScale>
            </View>

            {/* Floating feature & announcement banner carousel */}
            {promoBannerSection}

            {/* Instant Currency Swap */}
            <PressableScale onPress={() => onNavigate("swap")} depth={0.98} style={styles.swapRowCard}>
              <View style={styles.swapIconTile}>
                <Ionicons name="swap-horizontal" size={20} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>Swap USD ↔ EUR</Text>
                <Text style={styles.rowSub}>Convert between USDC and EURC instantly</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
            </PressableScale>

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
  // Compact edge-to-edge Proxim Forest header so Savings, Stocks & Banners sit higher above the fold.
  hero: {
    marginHorizontal: -SPACING.md,
    paddingHorizontal: SPACING.md + 2,
    paddingTop: 4,
    paddingBottom: 12,
    backgroundColor: COLORS.forest,
    borderBottomLeftRadius: RADIUS.lg,
    borderBottomRightRadius: RADIUS.lg,
    gap: 4,
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
  swapRowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  swapIconTile: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  below: {
    gap: 10,
    paddingTop: 10,
  },
  greetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  greetSub: {
    ...TYPE.label,
    fontSize: 11,
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
  acctLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 4,
    paddingRight: 6,
    minHeight: 30,
  },
  acctLabel: {
    ...TYPE.overline,
    color: HERO.textSecondary,
  },
  curChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 4,
    paddingRight: 9,
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
    height: 38,
  },
  balLoadingText: {
    ...TYPE.label,
    color: HERO.textSecondary,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  totalAmount: {
    ...TYPE.xl,
    fontSize: 28,
    lineHeight: 34,
    color: HERO.text,
    flexShrink: 1,
  },
  totalCents: {
    fontSize: 18,
    color: HERO.textSecondary,
  },
  subLine: {
    ...TYPE.label,
    fontSize: 12,
    color: HERO.textSecondary,
  },
  eyeBtn: {
    padding: 4,
  },
  extraLine: {
    ...TYPE.label,
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
    paddingVertical: 6,
  },
  ngnLabel: {
    ...TYPE.label,
    fontSize: 11,
    color: HERO.textSecondary,
  },
  ngnNumber: {
    ...TYPE.bodyStrong,
    fontSize: 13.5,
    color: HERO.text,
    letterSpacing: 0.8,
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
    height: 28,
    paddingHorizontal: 10,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.gold,
  },
  copyPillText: {
    ...TYPE.label,
    fontSize: 11.5,
    fontFamily: TYPE.title.fontFamily,
    color: COLORS.onGold,
  },
  qaRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  qaWide: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: RADIUS.md,
  },
  qaGold: {
    backgroundColor: COLORS.gold,
    borderBottomWidth: 2,
    borderBottomColor: COLORS.goldDark,
  },
  qaWhite: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 2,
    borderBottomColor: "#C9D3CE",
  },
  qaWideLabel: {
    ...TYPE.bodyStrong,
    fontFamily: TYPE.xl.fontFamily,
    fontSize: 14,
    color: COLORS.primary,
  },
  growRow: {
    flexDirection: "row",
    gap: 8,
  },
  featureCard: {
    flex: 1,
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: RADIUS.md,
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
    fontSize: 13,
    lineHeight: 16,
    color: COLORS.text,
  },
  featureSub: {
    ...TYPE.label,
    fontSize: 11,
    lineHeight: 14,
    color: COLORS.textSecondary,
  },
  promoSection: {
    gap: 6,
  },
  promoTrack: {
    gap: BANNER_GAP,
    paddingVertical: 2,
    paddingRight: 4,
  },
  promoCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderBottomWidth: 3,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 9,
    minHeight: 84,
    shadowColor: "#13110C",
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  promoLeft: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  promoMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  promoBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
  },
  promoBadgeText: {
    ...TYPE.overline,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.5,
  },
  promoLogoCluster: {
    flexDirection: "row",
    alignItems: "center",
  },
  promoLogoRing: {
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: COLORS.white,
    overflow: "hidden",
  },
  promoTitle: {
    ...TYPE.bodyStrong,
    fontSize: 14,
    lineHeight: 17,
  },
  promoBottomRow: {
    gap: 2,
  },
  promoSub: {
    ...TYPE.label,
    fontSize: 11,
    lineHeight: 14,
  },
  promoCtaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 1,
  },
  promoCtaText: {
    ...TYPE.bodyStrong,
    fontSize: 11.5,
    lineHeight: 14,
  },
  promoArtWrap: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
  },
  promoArtHalo: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  promoArtImg: {
    width: 68,
    height: 68,
  },
  promoDots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  promoDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.border,
  },
  promoDotActive: {
    width: 16,
    backgroundColor: COLORS.primary,
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
