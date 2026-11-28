// Device-persisted Light / Dark / System theme controller for Proxim Mobile.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { applyResolvedTheme, type ResolvedTheme, type ThemePreference } from "../theme";

export const THEME_PREFERENCE_KEY = "proxim_theme_preference_v1";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  isDark: boolean;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "light",
  isDark: false,
  setPreference: () => {},
});

let _cachedPreference: ThemePreference = "system";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(_cachedPreference);

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(THEME_PREFERENCE_KEY)
      .then((saved) => {
        if (!alive) return;
        if (saved === "light" || saved === "dark" || saved === "system") {
          _cachedPreference = saved;
          setPreferenceState(saved);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const resolved: ResolvedTheme =
    preference === "dark"
      ? "dark"
      : preference === "light"
        ? "light"
        : systemScheme === "dark"
          ? "dark"
          : "light";

  // Apply synchronously during render BEFORE children evaluate any createThemeStyles() sheets
  applyResolvedTheme(resolved);

  const setPreference = useCallback((next: ThemePreference) => {
    _cachedPreference = next;
    setPreferenceState(next);
    SecureStore.setItemAsync(THEME_PREFERENCE_KEY, next).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, isDark: resolved === "dark", setPreference }),
    [preference, resolved, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
