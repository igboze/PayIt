// Sends JavaScript crashes to the server log so we can see what went wrong on a phone,
// and catches render errors so the app shows a recovery screen instead of force-closing.
import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";

const API_BASE =
  // Same base the API client uses; kept local so this file loads before anything else.
  (process.env.EXPO_PUBLIC_API_BASE_URL as string | undefined) || "https://payit-production.up.railway.app/api/app/v1";

let updateId: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  updateId = (require("expo-updates") as { updateId?: string | null }).updateId || "embedded";
} catch (_) {
  updateId = null;
}

const sent = new Set<string>();

export function reportError(err: unknown, where: string, fatal = false) {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const key = `${where}:${e.message}`;
    if (sent.has(key)) return; // don't flood the log with repeats
    sent.add(key);
    fetch(`${API_BASE}/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: e.message, stack: String(e.stack || "").slice(0, 2000), where, fatal, updateId }),
    }).catch(() => {});
  } catch (_) {
    // never let reporting itself crash the app
  }
}

/** Call once, as early as possible: reports uncaught JS errors, then lets RN handle them. */
export function installCrashReporter() {
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void };
  };
  const EU = g.ErrorUtils;
  if (!EU) return;
  const previous = EU.getGlobalHandler();
  EU.setGlobalHandler((error, isFatal) => {
    reportError(error, "global", Boolean(isFatal));
    // Give the report a moment to leave before a fatal error closes the app.
    if (isFatal) setTimeout(() => previous(error, isFatal), 700);
    else previous(error, isFatal);
  });
}

type BoundaryState = { error: Error | null };

/** Catches render errors anywhere below it and shows a way back instead of crashing. */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode; onReset?: () => void }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const e = new Error(error.message);
    e.stack = `${error.stack || ""}\nComponent stack:${info?.componentStack || ""}`;
    reportError(e, "render", false);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Image source={require("../assets/icon.png")} style={styles.logo} />
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>We've been told about it. Your money is safe. Try again, and if it keeps happening, close and reopen Proxim.</Text>
        <Text onPress={this.reset} style={styles.button} accessibilityRole="button">
          Try again
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F2F5F3", alignItems: "center", justifyContent: "center", padding: 28, gap: 12 },
  logo: { width: 72, height: 72, borderRadius: 20, marginBottom: 8 },
  title: { fontSize: 22, fontWeight: "700", color: "#0B1713", textAlign: "center" },
  body: { fontSize: 15, lineHeight: 22, color: "#475952", textAlign: "center" },
  button: {
    marginTop: 12,
    overflow: "hidden",
    backgroundColor: "#002018",
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 16,
  },
});
