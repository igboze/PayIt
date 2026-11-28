// Proxim Mobile App — design tokens (Forest & Gold — Light & Dark).
// Light: Warm stone page (#F5F1E8), pure white cards (#FFFFFF), Proxim Forest (#002018),
// and rich Gold (#E0A82E) main actions with tactile lips.
// Dark: Deep matte forest-obsidian (#07110D), dark forest cards (#0F1C17), Proxim Forest
// headers (#002018), warm ivory ink (#F5F1E8), and radiant Gold (#E0A82E) accents & CTAs.

import { ImageStyle, StyleSheet, TextStyle, ViewStyle } from "react-native";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

export const LIGHT_COLORS = {
  // Forest & Gold: warm stone page, solid white cards, Proxim Forest for structure and
  // text accents, Gold for the one main action per screen. All values are solid colours.
  bg: "#F5F1E8",
  page: "#F5F1E8", // warm stone; cards are pure white on top of it
  surface: "#FFFFFF",
  surfaceElevated: "#EDE7DA", // sunken fills: segments, neutral icon tiles
  surfaceSoft: "#F5F1E8",
  border: "#DCD3C1", // card and field outlines
  borderStrong: "#BDB29C", // inputs, outline buttons, bottom lip

  primary: "#002018", // Proxim Forest: active states, links, icons, dark buttons (17:1 on white)
  primaryDark: "#00140F",
  primaryMuted: "#EDE7DA",
  primaryBorder: "#0B4A37",
  onPrimary: "#FFFFFF",
  forest: "#002018",
  forest800: "#003526",
  forest700: "#0B4A37",
  deep: "#F6E7BF", // selected pill / chip background (gold 100)
  success: "#007840", // money in (5.6:1 on white)
  brandGreen: "#00B060", // logo green: success fills only, with Forest text

  gold: "#E0A82E", // main action fill; on Forest it is 8:1
  goldDark: "#8A6410", // gold text on light backgrounds (5.4:1), button lip
  goldSoft: "#F6E7BF",
  onGold: "#002018",

  business: "#8A6410",
  businessMuted: "#F6E7BF",
  businessBorder: "#E0C27A",

  info: "#1F5F8B",
  infoMuted: "#DCEAF4",

  danger: "#C8321E",
  dangerMuted: "#FBE1DC",
  dangerBorder: "#F0B6AB",
  dangerText: "#A32816",
  successText: "#007840",
  warningText: "#8A5600",
  warningMuted: "#FBEBCB",

  text: "#13110C",
  textSecondary: "#5C5546", // 7.4:1 on white
  textMuted: "#776F5F", // 4.9:1 on white
  white: "#FFFFFF",
  black: "#000000",
};

export const DARK_COLORS: typeof LIGHT_COLORS = {
  // Forest & Gold Dark: deep matte forest-obsidian page, dark forest cards, warm ivory ink,
  // and radiant Proxim Gold for primary active states & CTAs.
  bg: "#07110D",
  page: "#07110D",
  surface: "#0F1C17",
  surfaceElevated: "#172821",
  surfaceSoft: "#07110D",
  border: "#21372E",
  borderStrong: "#355447",

  primary: "#E0A82E", // Radiant Proxim Gold on dark surfaces (8.2:1 on card)
  primaryDark: "#C9921F",
  primaryMuted: "#1E2D25",
  primaryBorder: "#594518",
  onPrimary: "#002018", // Deep Forest ink on Gold (9.1:1)
  forest: "#002018",
  forest800: "#073024",
  forest700: "#144B39",
  deep: "#2B220F",
  success: "#22C55E",
  brandGreen: "#00B060",

  gold: "#E0A82E",
  goldDark: "#F2C252",
  goldSoft: "#2A210F",
  onGold: "#002018",

  business: "#F2C252",
  businessMuted: "#2A210F",
  businessBorder: "#664E1B",

  info: "#60A5FA",
  infoMuted: "#102033",

  danger: "#F87171",
  dangerMuted: "#2A1215",
  dangerBorder: "#63252C",
  dangerText: "#FCA5A5",
  successText: "#34D399",
  warningText: "#FBBF24",
  warningMuted: "#2A1F0B",

  text: "#F5F1E8", // Warm ivory (15.6:1 on card)
  textSecondary: "#B3ADA0", // Warm muted stone (8.1:1 on card)
  textMuted: "#868073",
  white: "#FFFFFF",
  black: "#000000",
};

// The balance header is solid Proxim Forest with gold accents.
export const LIGHT_HERO = {
  text: "#FFFFFF",
  textSecondary: "#A8BDB3", // 8.7:1 on Forest
  accent: "#E0A82E",
  chip: "#003526",
  inset: "#003526",
  border: "#0B4A37",
};

export const DARK_HERO: typeof LIGHT_HERO = {
  text: "#FFFFFF",
  textSecondary: "#A8BDB3",
  accent: "#E0A82E",
  chip: "#083225",
  inset: "#083225",
  border: "#17523E",
};

// Depth: every raised surface gets a visible edge, a thicker darker bottom "lip" and a real
// shadow, so it reads as something you can press, even for people with low vision.
export const LIGHT_DEPTH = {
  card: {
    borderWidth: 1,
    borderColor: "#DCD3C1",
    borderBottomWidth: 2,
    borderBottomColor: "#CFC5B0",
    shadowColor: "#13110C",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  raised: {
    borderWidth: 1,
    borderColor: "#DCD3C1",
    borderBottomWidth: 2,
    borderBottomColor: "#BDB29C",
    shadowColor: "#13110C",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  // Main action: gold with a darker gold lip.
  glow: {
    borderWidth: 0,
    borderBottomWidth: 3,
    borderBottomColor: "#8A6410",
    shadowColor: "#8A6410",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 5,
  },
  // Forest blocks: a near-black lip.
  forest: {
    borderBottomWidth: 3,
    borderBottomColor: "#00140F",
    shadowColor: "#002018",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6,
  },
};

export const DARK_DEPTH: typeof LIGHT_DEPTH = {
  card: {
    borderWidth: 1,
    borderColor: "#21372E",
    borderBottomWidth: 2,
    borderBottomColor: "#050A08",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 12,
    elevation: 3,
  },
  raised: {
    borderWidth: 1,
    borderColor: "#2A4439",
    borderBottomWidth: 2,
    borderBottomColor: "#050A08",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 3,
  },
  glow: {
    borderWidth: 0,
    borderBottomWidth: 3,
    borderBottomColor: "#8A6410",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 5,
  },
  forest: {
    borderBottomWidth: 3,
    borderBottomColor: "#17523E",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 6,
  },
};

// Live mutable theme tokens — updated synchronously when switching Light/Dark.
export const COLORS: typeof LIGHT_COLORS = { ...LIGHT_COLORS };
export const HERO: typeof LIGHT_HERO = { ...LIGHT_HERO };
export const DEPTH: typeof LIGHT_DEPTH = {
  card: { ...LIGHT_DEPTH.card },
  raised: { ...LIGHT_DEPTH.raised },
  glow: { ...LIGHT_DEPTH.glow },
  forest: { ...LIGHT_DEPTH.forest },
};
export const BALANCE_GRADIENT = { from: "#002018", to: "#002018", border: "#0B4A37" };

let _resolvedTheme: ResolvedTheme = "light";
let _themeVersion = 0;

export function getResolvedTheme(): ResolvedTheme {
  return _resolvedTheme;
}

export function isDarkTheme(): boolean {
  return _resolvedTheme === "dark";
}

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
 * Plain-object reactive StyleSheet (zero Proxy — 100% Hermes/React 19 safe).
 * Rebuilds automatically whenever Light/Dark theme switches.
 */
export function createThemeStyles<T extends NamedStyles<T>>(factory: () => T): T {
  let cachedVersion = _themeVersion;
  let cachedSheet = StyleSheet.create(factory()) as T;
  const resolve = (): T => {
    if (cachedVersion !== _themeVersion) {
      cachedSheet = StyleSheet.create(factory()) as T;
      cachedVersion = _themeVersion;
    }
    return cachedSheet;
  };
  const out = {} as T;
  for (const key of Object.keys(cachedSheet) as Array<keyof T>) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        return resolve()[key];
      },
    });
  }
  return out;
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

// Canvas type scale.
export const TYPE = {
  xl: { fontFamily: FONTS.extrabold, fontSize: 44, lineHeight: 52, letterSpacing: -0.9 },
  display: { fontFamily: FONTS.bold, fontSize: 30, lineHeight: 38, letterSpacing: -0.45 },
  title: { fontFamily: FONTS.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.2 },
  headline: { fontFamily: FONTS.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.1 },
  body: { fontFamily: FONTS.regular, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: FONTS.semibold, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: FONTS.medium, fontSize: 13, lineHeight: 18 },
  overline: { fontFamily: FONTS.semibold, fontSize: 12, lineHeight: 16, letterSpacing: 0.7, textTransform: "uppercase" as const },
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 20,
  xl: 28,
} as const;

export const RADIUS = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;
