import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
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
import { COLORS } from "./src/theme";

type MainTab = "home" | "accounts" | "cards" | "profile";
type OverlayScreen = "add" | "send" | "bills" | "savings" | "swap" | "assistant" | null;

function MainShell() {
  const { user, bootstrapping } = useApp();
  const [tab, setTab] = useState<MainTab>("home");
  const [accountsSection, setAccountsSection] = useState<AccountsSection>("accounts");
  const [overlay, setOverlay] = useState<OverlayScreen>(null);
  const [deepLinkCode, setDeepLinkCode] = useState("");
  const [deepClaimToken, setDeepClaimToken] = useState("");

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

  const handleHomeNav = (target: HomeModalTarget) => {
    if (
      target === "add" ||
      target === "send" ||
      target === "bills" ||
      target === "savings" ||
      target === "swap" ||
      target === "assistant"
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
        <AddMoneyScreen onBack={() => setOverlay(null)} />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }
  if (overlay === "send") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <SendScreen
          onBack={() => {
            setDeepClaimToken("");
            setOverlay(null);
          }}
          initialMode={deepClaimToken ? "user" : "ngn"}
          initialClaimToken={deepClaimToken}
        />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }
  if (overlay === "bills") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <BillsScreen onBack={() => setOverlay(null)} />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }
  if (overlay === "savings") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <SavingsScreen onBack={() => setOverlay(null)} />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }
  if (overlay === "swap") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <SwapScreen onBack={() => setOverlay(null)} />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }
  if (overlay === "assistant") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <AssistantScreen onBack={() => setOverlay(null)} />
        <ApprovalSheet />
      </SafeAreaView>
    );
  }

  const tabs: Array<{ key: MainTab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
    { key: "home", label: "Home", icon: "home-outline" },
    { key: "accounts", label: "Accounts", icon: "briefcase-outline" },
    { key: "cards", label: "Cards", icon: "card-outline" },
    { key: "profile", label: "Profile", icon: "person-outline" },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <AccountSwitcherBar onOpenAssistant={() => setOverlay("assistant")} />

      <View style={styles.body}>
        {tab === "home" ? <HomeScreen onNavigate={handleHomeNav} /> : null}
        {tab === "accounts" ? <AccountsScreen initialSection={accountsSection} /> : null}
        {tab === "cards" ? <CardsScreen /> : null}
        {tab === "profile" ? <ProfileScreen /> : null}
      </View>

      <View style={styles.tabBar}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                if (t.key === "accounts") setAccountsSection("accounts");
                setTab(t.key);
              }}
              style={styles.tabItem}
            >
              <Ionicons
                name={t.icon}
                size={21}
                color={active ? COLORS.primary : COLORS.textMuted}
              />
              <Text style={[styles.tabLabel, active && { color: COLORS.primary }]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ApprovalSheet />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <MainShell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  splash: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  splashText: { color: COLORS.textSecondary, fontSize: 14 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingVertical: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  tabLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },
});
