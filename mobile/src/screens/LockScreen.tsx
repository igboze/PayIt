import React, { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../state/AppContext";
import { COLORS, SPACING, TYPE } from "../theme";
import { Button, ErrorBanner } from "../components/UI";
import { notifyHaptic } from "../components/Touch";
import { PoweredBy } from "../components/PoweredBy";

const LOGO = require("../../assets/icon.png");

/** Shown to a returning user until they confirm with their passkey. Nothing else renders. */
export function LockScreen() {
  const { user, unlock, signOut } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const doUnlock = async () => {
    setError(null);
    setBusy(true);
    try {
      await unlock();
      notifyHaptic("success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't confirm it's you.";
      if (!/cancel/i.test(msg)) {
        setError(msg);
        notifyHaptic("error");
      }
    } finally {
      setBusy(false);
    }
  };

  // Ask for the passkey straight away on open.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const t = setTimeout(doUnlock, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const first = (user?.senderName || "").split(/\s+/)[0] || (user?.username ? `@${user.username}` : "");

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Image source={LOGO} style={styles.logo} />
        <Text style={styles.title}>{first ? `Welcome back, ${first}` : "Welcome back"}</Text>
        <Text style={styles.sub}>Confirm it's you with your passkey to open Proxim.</Text>
      </View>
      <View style={styles.lockIcon}>
        <Ionicons name="finger-print" size={44} color={COLORS.primary} />
      </View>
      <View style={styles.bottom}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <Button title="Unlock with passkey" onPress={doUnlock} loading={busy} />
        <Button title="Sign out" variant="ghost" onPress={() => signOut()} disabled={busy} />
        <PoweredBy />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg, padding: SPACING.lg, justifyContent: "space-between" },
  top: { alignItems: "center", gap: 10, marginTop: 48 },
  logo: { width: 72, height: 72, borderRadius: 20, marginBottom: 8 },
  title: { ...TYPE.title, color: COLORS.text, textAlign: "center" },
  sub: { ...TYPE.body, color: COLORS.textSecondary, textAlign: "center" },
  lockIcon: {
    alignSelf: "center",
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  bottom: { gap: 8 },
});
