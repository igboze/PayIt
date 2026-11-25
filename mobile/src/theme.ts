// Proxim Mobile App — design tokens. Light page and white cards with a charcoal balance
// card; type, radii and spacing follow the Proxim design canvas.

export const COLORS = {
  // Light page with white cards; green is kept for buttons and positive amounts.
  // Screens are transparent so the floating backdrop (FloatingBackdrop) shows through;
  // use page for solid fills such as sheets and inset boxes.
  bg: "transparent",
  page: "#F6F7F6",
  surface: "#FFFFFF",
  surfaceElevated: "#EFF2F0",
  surfaceSoft: "#F3F5F4",
  border: "#E3E7E5",
  borderStrong: "#D3D9D6",

  primary: "#067F48", // ~5:1 on white, readable at small sizes
  primaryDark: "#05693C",
  primaryMuted: "rgba(6, 127, 72, 0.10)",
  primaryBorder: "rgba(6, 127, 72, 0.30)",
  onPrimary: "#FFFFFF",
  forest: "#0B4D3A",
  deep: "#E7F6EE", // active pill / selected background
  success: "#067F48", // incoming amounts

  business: "#B7791F",
  businessMuted: "rgba(183, 121, 31, 0.10)",
  businessBorder: "rgba(183, 121, 31, 0.35)",

  info: "#0284C7",
  infoMuted: "rgba(2, 132, 199, 0.10)",

  danger: "#DC2626",
  dangerMuted: "rgba(220, 38, 38, 0.08)",
  dangerBorder: "rgba(220, 38, 38, 0.30)",
  dangerText: "#B91C1C",
  successText: "#067A45",
  warningText: "#92400E",

  text: "#0E1512",
  textSecondary: "#55615B",
  textMuted: "#8A9590",
  white: "#FFFFFF",
  black: "#000000",
} as const;

// The balance card is the one dark surface: charcoal, not green.
export const HERO = {
  text: "#F4F6F5",
  textSecondary: "#A9B4AE",
  accent: "#34D399",
  chip: "rgba(255, 255, 255, 0.10)",
  inset: "rgba(255, 255, 255, 0.06)",
} as const;
export const BALANCE_GRADIENT = { from: "#26302B", to: "#111614", border: "rgba(255, 255, 255, 0.06)" } as const;

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

// Soft, low shadows that lift white cards off the off-white page.
export const DEPTH = {
  card: {
    shadowColor: "#0E1512",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
    elevation: 3,
  },
  raised: {
    shadowColor: "#0E1512",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  glow: {
    shadowColor: "#067F48",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 6,
  },
} as const;
