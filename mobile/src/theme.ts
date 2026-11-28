// Proxim Mobile App — hardened dual design tokens (Light & Dark).
// Light: Cool architectural stone (#ECEFED), crisp white cards (#FFFFFF), hard Proxim Forest
// (#001A13), deep institutional emerald CTAs (#006E44), and Midnight Navy (#0B1324) for Business.
// Dark: Deep matte obsidian-pine (#060A08), crisp dark cards (#0E1512) with 1px borders (#22332B),
// hard Proxim Emerald (#00B86B / #008751), and crisp off-white typography (#F2F7F4).
// Zero soft gradients, zero AI glow.

import { ImageStyle, StyleSheet, TextStyle, ViewStyle } from "react-native";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const LIGHT_COLORS = {
  bg: "#ECEFED",
  page: "#ECEFED",
  surface: "#FFFFFF",
  surfaceElevated: "#E0E7E3",
  surfaceSoft: "#ECEFED",
  border: "#C9D5CE",
  borderStrong: "#8EA197",

  primary: "#001A13",
  primaryDark: "#00100B",
  primaryMuted: "#DDF0E6",
  primaryBorder: "#0A4D38",
  onPrimary: "#FFFFFF",
  forest: "#001A13",
  forest800: "#053023",
  forest700: "#0E4F3A",
  deep: "#D0ECDD",
  success: "#006B3E",
  brandGreen: "#008F55",

  // Primary CTA & accent tokens (hard institutional emerald with pure white text)
  gold: "#006E44",
  goldDark: "#004F30",
  goldSoft: "#D0ECDD",
  onGold: "#FFFFFF",

  // Business account identity: hard corporate Midnight Navy
  business: "#0B1324",
  businessMuted: "#E2E8F0",
  businessBorder: "#94A3B8",

  info: "#1D4ED8",
  infoMuted: "#DBEAFE",

  danger: "#B91C1C",
  dangerMuted: "#FEE2E2",
  dangerBorder: "#EF9A9A",
  dangerText: "#991B1B",
  successText: "#006B3E",
  warningText: "#8A4300",
  warningMuted: "#FDE8C8",
  warningBorder: "#D9A45B",

  text: "#06110D",
  textSecondary: "#374841",
  textMuted: "#5C6E67",
  white: "#FFFFFF",
  black: "#000000",
};

export const DARK_COLORS: typeof LIGHT_COLORS = {
  bg: "#060A08",
  page: "#060A08",
  surface: "#0E1512",
  surfaceElevated: "#15201B",
  surfaceSoft: "#060A08",
  border: "#22332B",
  borderStrong: "#375044",

  primary: "#00B86B",
  primaryDark: "#00D67D",
  primaryMuted: "#0F261D",
  primaryBorder: "#1D543E",
  onPrimary: "#03120C",
  forest: "#091E16",
  forest800: "#112D22",
  forest700: "#1F4B39",
  deep: "#112E22",
  success: "#10B981",
  brandGreen: "#00C476",

  // Primary CTA & accent tokens (hard solid emerald with pure white text)
  gold: "#008751",
  goldDark: "#34D399",
  goldSoft: "#122C21",
  onGold: "#FFFFFF",

  // Business account identity in Dark Mode: hard corporate Slate Blue
  business: "#3B82F6",
  businessMuted: "#101D33",
  businessBorder: "#253E66",

  info: "#60A5FA",
  infoMuted: "#101E36",

  danger: "#F87171",
  dangerMuted: "#291114",
  dangerBorder: "#63242B",
  dangerText: "#FCA5A5",
  successText: "#10B981",
  warningText: "#FBBF24",
  warningMuted: "#291D0A",
  warningBorder: "#6B4E16",

  text: "#F2F7F4",
  textSecondary: "#9AB0A6",
  textMuted: "#6C8278",
  white: "#FFFFFF",
  black: "#000000",
};

export const LIGHT_HERO = {
  text: "#FFFFFF",
  textSecondary: "#A3BCB2",
  accent: "#00C476",
  chip: "#053023",
  inset: "#053023",
  border: "#0F4D39",
};

export const DARK_HERO: typeof LIGHT_HERO = {
  text: "#FFFFFF",
  textSecondary: "#9BB5AA",
  accent: "#00D67D",
  chip: "#112D22",
  inset: "#112D22",
  border: "#1F4B39",
};

export const LIGHT_DEPTH = {
  card: {
    borderWidth: 1,
    borderColor: "#C9D5CE",
    shadowColor: "#001A13",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  raised: {
    borderWidth: 1,
    borderColor: "#BCCAC2",
    shadowColor: "#001A13",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
    elevation: 2,
  },
  glow: {
    borderWidth: 0,
    shadowColor: "#001A13",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 6,
    elevation: 3,
  },
  forest: {
    borderBottomWidth: 1,
    borderBottomColor: "#0F4D39",
    shadowColor: "#001A13",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 5,
  },
};

export const DARK_DEPTH: typeof LIGHT_DEPTH = {
  card: {
    borderWidth: 1,
    borderColor: "#22332B",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 6,
    elevation: 2,
  },
  raised: {
    borderWidth: 1,
    borderColor: "#2B4036",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.32,
    shadowRadius: 5,
    elevation: 2,
  },
  glow: {
    borderWidth: 0,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 3,
  },
  forest: {
    borderBottomWidth: 1,
    borderBottomColor: "#1F4B39",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 5,
  },
};

// Live mutable theme tokens — updated synchronously whenever the active theme switches.
export const COLORS: typeof LIGHT_COLORS = { ...LIGHT_COLORS };
export const HERO: typeof LIGHT_HERO = { ...LIGHT_HERO };
export const DEPTH: typeof LIGHT_DEPTH = {
  card: { ...LIGHT_DEPTH.card },
  raised: { ...LIGHT_DEPTH.raised },
  glow: { ...LIGHT_DEPTH.glow },
  forest: { ...LIGHT_DEPTH.forest },
};
export const BALANCE_GRADIENT = { from: "#001A13", to: "#001A13", border: "#0F4D39" };

let _resolvedTheme: ResolvedTheme = "light";
let _themeVersion = 0;

export function getResolvedTheme(): ResolvedTheme {
  return _resolvedTheme;
}

export function isDarkTheme(): boolean {
  return _resolvedTheme === "dark";
}

export function getThemeVersion(): number {
  return _themeVersion;
}

/**
 * Synchronously switch the live palette tokens (COLORS, HERO, DEPTH) and bump the theme version
 * so every `createThemeStyles(...)` sheet across the app automatically rebuilds on next render.
 */
export function applyResolvedTheme(scheme: ResolvedTheme): void {
  const next: ResolvedTheme = scheme === "dark" ? "dark" : "light";
  if (next === _resolvedTheme && _themeVersion > 0) return;
  _resolvedTheme = next;
  const isDark = next === "dark";
  Object.assign(COLORS, isDark ? DARK_COLORS : LIGHT_COLORS);
  Object.assign(HERO, isDark ? DARK_HERO : LIGHT_HERO);
  const nextDepth = isDark ? DARK_DEPTH : LIGHT_DEPTH;
  Object.assign(DEPTH.card, nextDepth.card);
  Object.assign(DEPTH.raised, nextDepth.raised);
  Object.assign(DEPTH.glow, nextDepth.glow);
  Object.assign(DEPTH.forest, nextDepth.forest);
  BALANCE_GRADIENT.from = COLORS.forest;
  BALANCE_GRADIENT.to = COLORS.forest;
  BALANCE_GRADIENT.border = HERO.border;
  _themeVersion += 1;
}

/**
 * Drop-in replacement for `StyleSheet.create(...)` that automatically invalidates and rebuilds
 * when Light/Dark mode switches, with zero overhead during normal renders.
 */
export function createThemeStyles<T extends NamedStyles<T>>(factory: () => T): T {
  let cachedVersion = -1;
  let cachedSheet: T | null = null;
  const resolve = (): T => {
    if (!cachedSheet || cachedVersion !== _themeVersion) {
      cachedSheet = StyleSheet.create(factory()) as T;
      cachedVersion = _themeVersion;
    }
    return cachedSheet;
  };
  return new Proxy({} as T, {
    get(_target, prop) {
      return resolve()[prop as keyof T];
    },
    has(_target, prop) {
      return prop in resolve();
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Object.getOwnPropertyDescriptor(resolve(), prop);
      return desc ? { ...desc, configurable: true } : undefined;
    },
  });
}

// Plus Jakarta Sans, loaded in App.tsx. Custom fonts carry their own weight, so pick the
// family by weight instead of setting fontWeight.
export const FONTS = {
  regular: "PlusJakartaSans_400Regular",
  medium: "PlusJakartaSans_500Medium",
  semibold: "PlusJakartaSans_600SemiBold",
  bold: "PlusJakartaSans_700Bold",
  extrabold: "PlusJakartaSans_800ExtraBold",
} as const;

export function fontFor(weight?: string | number | null): string {
  const w = Number(weight) || (weight === "bold" ? 700 : 400);
  if (w >= 800) return FONTS.extrabold;
  if (w >= 700) return FONTS.bold;
  if (w >= 600) return FONTS.semibold;
  if (w >= 500) return FONTS.medium;
  return FONTS.regular;
}

// Tabular numerals prevent financial figures from jittering or misaligning in columns.
export const TABULAR_NUMS = { fontVariant: ["tabular-nums" as const] };

// Canvas type scale — institutional proportions with tabular figures on display & headline scales.
export const TYPE = {
  xl: { fontFamily: FONTS.extrabold, fontSize: 40, lineHeight: 46, letterSpacing: -0.9, fontVariant: ["tabular-nums" as const] },
  display: { fontFamily: FONTS.bold, fontSize: 28, lineHeight: 34, letterSpacing: -0.45, fontVariant: ["tabular-nums" as const] },
  title: { fontFamily: FONTS.bold, fontSize: 20, lineHeight: 26, letterSpacing: -0.25 },
  headline: { fontFamily: FONTS.semibold, fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
  body: { fontFamily: FONTS.regular, fontSize: 14.5, lineHeight: 21 },
  bodyStrong: { fontFamily: FONTS.semibold, fontSize: 14.5, lineHeight: 21 },
  label: { fontFamily: FONTS.medium, fontSize: 12.5, lineHeight: 17 },
  overline: { fontFamily: FONTS.bold, fontSize: 11, lineHeight: 15, letterSpacing: 0.75, textTransform: "uppercase" as const },
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 20,
  xl: 28,
} as const;

export const RADIUS = {
  sm: 10,
  md: 14,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;
