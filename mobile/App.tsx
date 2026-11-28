import React, { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Image, Linking, StyleSheet, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { AppProvider, useApp } from "./src/state/AppContext";
import { ThemeProvider, useTheme } from "./src/state/ThemeContext";
import { ApprovalSheet } from "./src/components/ApprovalSheet";
import { AccountSwitcherBar } from "./src/components/AccountSwitcherBar";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { HomeScreen, type HomeModalTarget } from "./src/screens/HomeScreen";
import { AddMoneyScreen } from "./src/screens/AddMoneyScreen";
import { SendScreen } from "./src/screens/SendScreen";
import { BillsScreen, type BillCat } from "./src/screens/BillsScreen";
import { CardsScreen } from "./src/screens/CardsScreen";
import { AccountsScreen, type AccountsSection, type BizSubTab } from "./src/screens/AccountsScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { AssistantScreen } from "./src/screens/AssistantScreen";
import { SavingsScreen } from "./src/screens/SavingsScreen";
import { StocksScreen } from "./src/screens/StocksScreen";
import { SwapScreen } from "./src/screens/SwapScreen";
import { COLORS, FONTS, createThemeStyles } from "./src/theme";
import { PressableScale } from "./src/components/Touch";
import { KeyboardSafe } from "./src/components/UI";
import { AppErrorBoundary } from "./src/crashReporter";
import { getNotifications } from "./src/nativeModules";
import { UpdatingScreen } from "./src/components/UpdatingScreen";
import { useAutoOtaUpdates } from "./src/hooks/useAutoOtaUpdates";
import { usePushRegistration } from "./src/hooks/usePushRegistration";
import { useInbox } from "./src/hooks/useInbox";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { LockScreen } from "./src/screens/LockScreen";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";

type MainTab = "home" | "accounts" | "cards" | "profile";
type OverlayScreen = "add" | "send" | "bills" | "savings" | "stocks" | "swap" | "assistant" | "notifications" | "activity" | null;

function MainShell() {
  const { user, activeAccount, bootstrapping, bumpDataVersion, locked } = useApp();
  const { isDark } = useTheme();
  const isBiz = activeAccount === "business";
  const insets = useSafeAreaInsets();
  const ota = useAutoOtaUpdates();
  usePushRegistration(Boolean(user) && !locked);
  const inbox = useInbox(Boolean(user) && !locked, bumpDataVersion);

  const [tab, setTab] = useState<MainTab>("home");
  const [accountsSection, setAccountsSection] = useState<AccountsSection>("accounts");
  const [bizSubTab, setBizSubTab] = useState<BizSubTab>("invoices");
  const [profileSection, setProfileSection] = useState<"general" | "kyc">("general");
  const [profileVerifyMode, setProfileVerifyMode] = useState<"kyc" | "kyb" | null>(null);
  const [overlay, setOverlay] = useState<OverlayScreen>(null);
  const [deepLinkCode, setDeepLinkCode] = useState("");
  const [deepClaimToken, setDeepClaimToken] = useState("");
  const [billCategory, setBillCategory] = useState<BillCat>("airtime");
  const [applyingUpdate, setApplyingUpdate] = useState(false);

  // Tapping a Proxim notification in the phone tray opens the Notifications screen.
  const signedInAndUnlocked = Boolean(user) && !locked;
  useEffect(() => {
    if (!signedInAndUnlocked) return;
    let sub: { remove: () => void } | null = null;
    try {
      const N = getNotifications();
      sub = N ? N.addNotificationResponseReceivedListener(() => setOverlay("notifications")) : null;
    } catch (_) {
      sub = null; // older builds without the native module
    }
    return () => {
      try {
        if (sub && typeof sub.remove === "function") sub.remove();
      } catch (_) {
        // listener already gone
      }
    };
  }, [signedInAndUnlocked]);

  // Android Back: close the open screen, then return to Home; only Home leaves the app.
  // Screens with their own steps (Send) register handlers later, so theirs run first.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!user || locked) return false;
      if (overlay) {
        if (overlay === "send") setDeepClaimToken("");
        setOverlay(null);
        return true;
      }
      if (tab !== "home") {
        setTab("home");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [user, locked, overlay, tab]);

  useEffect(() => {
    const handleUrl = (rawUrl: string | null | undefined) => {
      if (!rawUrl) return;
      const linkMatch = rawUrl.match(/\/link\/([A-Za-z0-9]{6,16})/i);
      if (linkMatch) {
        setDeepLinkCode(linkMatch[1]);
        return;
      }
      const claimMatch = rawUrl.match(/(?:claim[_-]?|gift\/)([A-Za-z0-9_-]{8,80})/i);
      if (claimMatch) {
        setDeepClaimToken(claimMatch[1]);
        setOverlay("send");
        return;
      }
      if (/kyc-uploaded/i.test(rawUrl)) {
        setOverlay(null);
        setProfileSection("kyc");
        setTab("profile");
      }
    };
    Linking.getInitialURL().then(handleUrl).catch(() => { });
    const sub = Linking.addEventListener("url", (ev) => handleUrl(ev.url));
    // If Android killed & restarted the Activity while the user was picking a KYC/KYB document in Chrome,
    // automatically restore straight back to Profile -> Verify ID so their upload & draft are immediately visible.
    SecureStore.getItemAsync("proxim_kyc_pending_upload_v1")
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ts && Date.now() - Number(parsed.ts) < 15 * 60 * 1000) {
          setOverlay(null);
          setProfileSection("kyc");
          setProfileVerifyMode(String(parsed.slot || "").startsWith("kyb_") ? "kyb" : "kyc");
          setTab("profile");
        }
      })
      .catch(() => { });
    return () => sub.remove();
  }, []);

  if (bootstrapping) {
    return (
      <View style={styles.splash}>
        <Image source={require("./assets/icon.png")} style={styles.splashLogo} resizeMode="contain" />
      </View>
    );
  }

  if (!user) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
        {ota.updateReady ? (
          <SafeAreaView edges={["top"]} style={{ backgroundColor: COLORS.primary }}>
            <PressableScale onPress={() => setApplyingUpdate(true)} style={styles.otaBanner}>
              <Ionicons name="cloud-download-outline" size={16} color={COLORS.onPrimary} />
              <Text style={styles.otaBannerText}>New Proxim update ready · Tap to apply</Text>
              <Ionicons name="refresh" size={15} color={COLORS.onPrimary} />
            </PressableScale>
          </SafeAreaView>
        ) : null}
        <OnboardingScreen initialLinkCode={deepLinkCode} />
      </View>
    );
  }

  if (applyingUpdate) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <UpdatingScreen apply={ota.applyNow} onCancel={() => setApplyingUpdate(false)} />
      </SafeAreaView>
    );
  }

  const lockOverlay = locked ? (
    <View style={styles.lockOverlay}>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <LockScreen />
        </KeyboardSafe>
      </SafeAreaView>
    </View>
  ) : null;

  const handleHomeNav = (target: HomeModalTarget) => {
    if (
      target === "add" ||
      target === "send" ||
      target === "bills" ||
      target === "savings" ||
      target === "stocks" ||
      target === "swap" ||
      target === "assistant" ||
      target === "notifications" ||
      target === "activity"
    ) {
      setOverlay(target);
    } else if (target === "cards") {
      setTab("cards");
    } else if (target === "global") {
      setAccountsSection("global");
      setTab("accounts");
    } else if (target === "business") {
      setBizSubTab("invoices");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "business_invoices") {
      setBizSubTab("invoices");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "business_payroll") {
      setBizSubTab("payroll");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "business_expenses") {
      setBizSubTab("expenses");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "business_links") {
      setBizSubTab("links");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "business_profile") {
      setBizSubTab("profile");
      setAccountsSection("business");
      setTab("accounts");
    } else if (target === "kyc") {
      setProfileVerifyMode("kyc");
      setProfileSection("kyc");
      setTab("profile");
    } else if (target === "kyb") {
      setProfileVerifyMode("kyb");
      setProfileSection("kyc");
      setTab("profile");
    }
  };

  if (overlay === "add") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <AddMoneyScreen onBack={() => setOverlay(null)} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "send") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <SendScreen
            onBack={() => {
              setDeepClaimToken("");
              setOverlay(null);
            }}
            initialMode={deepClaimToken ? "user" : "ngn"}
            initialClaimToken={deepClaimToken}
          />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "bills") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <BillsScreen onBack={() => setOverlay(null)} initialCategory={billCategory} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "savings") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <SavingsScreen onBack={() => setOverlay(null)} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "stocks") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <StocksScreen onBack={() => setOverlay(null)} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "swap") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <SwapScreen onBack={() => setOverlay(null)} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "activity") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <ActivityScreen onBack={() => setOverlay(null)} />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "notifications") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <NotificationsScreen onBack={() => setOverlay(null)} onOpened={inbox.markAllRead} />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }
  if (overlay === "assistant") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
          <AssistantScreen onBack={() => setOverlay(null)} />
          <ApprovalSheet />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }

  const tabs: Array<{ key: MainTab; label: string; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap }> = [
    { key: "home", label: isBiz ? "Business" : "Home", icon: isBiz ? "briefcase-outline" : "home-outline", activeIcon: isBiz ? "briefcase" : "home" },
    { key: "accounts", label: isBiz ? "Tools" : "Accounts", icon: isBiz ? "grid-outline" : "business-outline", activeIcon: isBiz ? "grid" : "business" },
    { key: "cards", label: isBiz ? "Team Cards" : "Cards", icon: "card-outline", activeIcon: "card" },
    { key: "profile", label: "Profile", icon: "person-outline", activeIcon: "person" },
  ];

  // Home draws its dark header right up under the status bar; other tabs sit on the page surface.
  const onForest = tab === "home";
  const topInsetBg = onForest ? (isBiz ? "#0F172A" : COLORS.forest) : COLORS.page;
  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <StatusBar style={onForest || isDark ? "light" : "dark"} />
      <View style={{ height: insets.top, backgroundColor: topInsetBg }} />
      <KeyboardSafe>
        {ota.updateReady ? (
          <PressableScale onPress={() => setApplyingUpdate(true)} style={styles.otaBanner}>
            <Ionicons name="cloud-download-outline" size={16} color={COLORS.onPrimary} />
            <Text style={styles.otaBannerText}>New Proxim update ready · Tap to apply</Text>
            <Ionicons name="refresh" size={15} color={COLORS.onPrimary} />
          </PressableScale>
        ) : null}
        {tab !== "home" ? <AccountSwitcherBar onOpenAssistant={() => setOverlay("assistant")} /> : null}

        {inbox.banner ? (
          <PressableScale
            onPress={() => {
              inbox.dismissBanner();
              setOverlay("notifications");
            }}
            style={styles.inboxBanner}
          >
            <Ionicons name="notifications" size={18} color={COLORS.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.inboxTitle} numberOfLines={1}>{inbox.banner.title}</Text>
              <Text style={styles.inboxBody} numberOfLines={2}>{inbox.banner.body}</Text>
            </View>
            <PressableScale onPress={inbox.dismissBanner} haptic="none" style={{ padding: 4 }}>
              <Ionicons name="close" size={18} color={COLORS.textMuted} />
            </PressableScale>
          </PressableScale>
        ) : null}
        <View style={styles.body}>
          {tab === "home" ? <HomeScreen
            onNavigate={handleHomeNav}
            onOpenProfile={() => setTab("profile")}
            onOpenBill={(c) => {
              setBillCategory(c);
              setOverlay("bills");
            }}
            unread={inbox.unread}
          /> : null}
          {tab === "accounts" ? <AccountsScreen initialSection={accountsSection} initialBizSubTab={bizSubTab} /> : null}
          {tab === "cards" ? <CardsScreen /> : null}
          {tab === "profile" ? <ProfileScreen initialTab={profileSection} initialVerifyMode={profileVerifyMode} /> : null}
        </View>

        <View style={styles.tabBar}>
          {tabs.map((t) => {
            const active = tab === t.key;
            return (
              <PressableScale
                key={t.key}
                onPress={() => {
                  if (t.key === "accounts") setAccountsSection(isBiz ? "business" : "accounts");
                  if (t.key === "profile") {
                    setProfileVerifyMode(null);
                    setProfileSection("general");
                  }
                  setTab(t.key);
                }}
                style={styles.tabItem}
              >
                <View style={[styles.tabIcon, active && styles.tabIconActive]}>
                  <Ionicons
                    name={active ? t.activeIcon : t.icon}
                    size={22}
                    color={active ? COLORS.primary : COLORS.textMuted}
                  />
                </View>
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {t.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>

        <ApprovalSheet />
      </KeyboardSafe>
      {lockOverlay}
    </SafeAreaView>
  );
}

function ThemedRoot({ bootKey, onReset }: { bootKey: number; onReset: () => void }) {
  const { isDark } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <AppErrorBoundary onReset={onReset}>
        <AppProvider key={bootKey}>
          <View style={{ flex: 1, backgroundColor: COLORS.page }}>
            <MainShell />
          </View>
        </AppProvider>
      </AppErrorBoundary>
    </>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  // Wait for the brand font, but never longer than a few seconds: a font that fails to
  // load must not leave a blank screen.
  const [fontWaitOver, setFontWaitOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFontWaitOver(true), 4000);
    return () => clearTimeout(t);
  }, []);
  const [bootKey, setBootKey] = useState(0);
  if (!fontsLoaded && !fontError && !fontWaitOver) {
    return (
      <View style={styles.splash}>
        <Image source={require("./assets/icon.png")} style={{ width: 72, height: 72, borderRadius: 20 }} />
        <ActivityIndicator color="#00C476" style={{ marginTop: 14 }} />
        <Text style={{ color: "#A3BCB2", fontSize: 14, marginTop: 8 }}>Starting Proxim…</Text>
      </View>
    );
  }
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedRoot bootKey={bootKey} onReset={() => setBootKey((k) => k + 1)} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = createThemeStyles(() => ({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  lockOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    elevation: 999,
    backgroundColor: COLORS.bg,
  },
  splash: {
    flex: 1,
    backgroundColor: COLORS.forest,
    alignItems: "center",
    justifyContent: "center",
  },
  splashLogo: {
    width: 96,
    height: 96,
    borderRadius: 24,
  },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingTop: 10,
    paddingBottom: 12,
    paddingHorizontal: 12,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  tabLabel: {
    color: COLORS.textMuted,
    fontFamily: FONTS.medium,
    fontSize: 12,
    lineHeight: 16,
  },
  tabLabelActive: { color: COLORS.primary, fontFamily: FONTS.bold },
  tabIcon: { width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  tabIconActive: { backgroundColor: COLORS.goldSoft },
  inboxBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 12,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    shadowColor: "#0E1512",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  inboxTitle: { color: COLORS.text, fontFamily: FONTS.semibold, fontSize: 14 },
  inboxBody: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 13 },
  otaBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.primary,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  otaBannerText: {
    color: COLORS.onPrimary,
    fontSize: 12,
    fontFamily: FONTS.extrabold,
  },
}));
