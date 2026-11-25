import React, { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { AppProvider, useApp } from "./src/state/AppContext";
import { ApprovalSheet } from "./src/components/ApprovalSheet";
import { AccountSwitcherBar } from "./src/components/AccountSwitcherBar";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { HomeScreen, type HomeModalTarget } from "./src/screens/HomeScreen";
import { AddMoneyScreen } from "./src/screens/AddMoneyScreen";
import { SendScreen } from "./src/screens/SendScreen";
import { BillsScreen } from "./src/screens/BillsScreen";
import { CardsScreen } from "./src/screens/CardsScreen";
import { AccountsScreen, type AccountsSection } from "./src/screens/AccountsScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { AssistantScreen } from "./src/screens/AssistantScreen";
import { SavingsScreen } from "./src/screens/SavingsScreen";
import { SwapScreen } from "./src/screens/SwapScreen";
import { COLORS, FONTS } from "./src/theme";
import { PressableScale } from "./src/components/Touch";
import { KeyboardSafe } from "./src/components/UI";
import { FloatingBackdrop } from "./src/components/FloatingBackdrop";
import { useAutoOtaUpdates } from "./src/hooks/useAutoOtaUpdates";
import { usePushRegistration } from "./src/hooks/usePushRegistration";
import { useInbox } from "./src/hooks/useInbox";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { LockScreen } from "./src/screens/LockScreen";
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";

type MainTab = "home" | "accounts" | "cards" | "profile";
type OverlayScreen = "add" | "send" | "bills" | "savings" | "swap" | "assistant" | "notifications" | null;

function MainShell() {
  const { user, bootstrapping, bumpDataVersion, locked } = useApp();
  const ota = useAutoOtaUpdates();
  usePushRegistration(Boolean(user) && !locked);
  const inbox = useInbox(Boolean(user) && !locked, bumpDataVersion);

  const [tab, setTab] = useState<MainTab>("home");
  const [accountsSection, setAccountsSection] = useState<AccountsSection>("accounts");
  const [overlay, setOverlay] = useState<OverlayScreen>(null);
  const [deepLinkCode, setDeepLinkCode] = useState("");
  const [deepClaimToken, setDeepClaimToken] = useState("");

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
      }
    };
    Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener("url", (ev) => handleUrl(ev.url));
    return () => sub.remove();
  }, []);

  if (bootstrapping) {
    return (
      <SafeAreaView style={styles.splash}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.splashText}>Connecting to Proxim…</Text>
      </SafeAreaView>
    );
  }

  if (!user) {
    return <OnboardingScreen initialLinkCode={deepLinkCode} />;
  }

  if (locked) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
        <LockScreen />
        </KeyboardSafe>
      </SafeAreaView>
    );
  }

  const handleHomeNav = (target: HomeModalTarget) => {
    if (
      target === "add" ||
      target === "send" ||
      target === "bills" ||
      target === "savings" ||
      target === "swap" ||
      target === "assistant" ||
      target === "notifications"
    ) {
      setOverlay(target);
    } else if (target === "cards") {
      setTab("cards");
    } else if (target === "global") {
      setAccountsSection("global");
      setTab("accounts");
    } else if (target === "kyc") {
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
        <BillsScreen onBack={() => setOverlay(null)} />
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

  const tabs: Array<{ key: MainTab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
    { key: "home", label: "Home", icon: "home-outline" },
    { key: "accounts", label: "Accounts", icon: "business-outline" },
    { key: "cards", label: "Cards", icon: "card-outline" },
    { key: "profile", label: "Profile", icon: "person-outline" },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardSafe>
      {ota.updateReady ? (
        <PressableScale onPress={ota.applyNow} style={styles.otaBanner}>
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
        {tab === "home" ? <HomeScreen onNavigate={handleHomeNav} onOpenProfile={() => setTab("profile")} unread={inbox.unread} /> : null}
        {tab === "accounts" ? <AccountsScreen initialSection={accountsSection} /> : null}
        {tab === "cards" ? <CardsScreen /> : null}
        {tab === "profile" ? <ProfileScreen /> : null}
      </View>

      <View style={styles.tabBar}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <PressableScale
              key={t.key}
              onPress={() => {
                if (t.key === "accounts") setAccountsSection("accounts");
                setTab(t.key);
              }}
              style={styles.tabItem}
            >
              <Ionicons
                name={t.icon}
                size={24}
                color={active ? COLORS.primary : COLORS.textMuted}
              />
              <Text style={[styles.tabLabel, active && { color: COLORS.primary }]}>
                {t.label}
              </Text>
            </PressableScale>
          );
        })}
      </View>

      <ApprovalSheet />
        </KeyboardSafe>
    </SafeAreaView>
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
  // Wait for the brand font, but never block the app if it fails to load.
  if (!fontsLoaded && !fontError) {
    return <View style={styles.splash} />;
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AppProvider>
        <View style={{ flex: 1 }}>
          <FloatingBackdrop />
          <MainShell />
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  splash: {
    flex: 1,
    backgroundColor: COLORS.page,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  splashText: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 14 },
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
    fontSize: 13,
    lineHeight: 18,
  },
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
});
