// Proxim Mobile App — design tokens (Proxim Forest & Crisp Emerald).
// Hard, architectural neobank palette: cool mineral mist canvas, solid white cards with 1px
// hairline borders, deep Proxim Forest hero, hard institutional emerald actions, and Midnight
// Slate for Business accounts. Zero soft gradients or pastel glows.

export const COLORS = {
  bg: "#F2F5F3",
  page: "#F2F5F3", // cool mineral mist; pure white cards sit cleanly on top
  surface: "#FFFFFF",
  surfaceElevated: "#E6EEEA", // solid cool sage-slate sunken fills
  surfaceSoft: "#F2F5F3",
  border: "#D8E1DC", // crisp 1px card and divider outlines
  borderStrong: "#B4C4BC", // inputs, outline buttons, focus anchors

  primary: "#002018", // Proxim Forest: headers, icons, dark buttons (17:1 on white)
  primaryDark: "#00130E",
  primaryMuted: "#E5F2EC", // solid light emerald surface
  primaryBorder: "#0B4A37",
  onPrimary: "#FFFFFF",
  forest: "#002018",
  forest800: "#063527",
  forest700: "#0F523D",
  deep: "#DFF2E8", // solid selected pill / card highlight
  success: "#007A47", // money in & confirmed states (5.4:1 on white)
  brandGreen: "#009E60", // hard Proxim emerald accent

  // Primary CTA & accent tokens (hard institutional emerald with pure white text)
  gold: "#007F4F", // solid hard emerald CTA fill (5.1:1 with white text)
  goldDark: "#005E3A", // deep emerald text on light backgrounds
  goldSoft: "#DFF2E8", // crisp solid pale emerald for active tab pill & icon badges
  onGold: "#FFFFFF",

  // Business account identity: authoritative Midnight Slate
  business: "#0F172A",
  businessMuted: "#E8EDF5",
  businessBorder: "#CBD5E1",

  info: "#1D4ED8",
  infoMuted: "#E5EDFF",

  danger: "#C81E1E",
  dangerMuted: "#FCE8E8",
  dangerBorder: "#F3BCBC",
  dangerText: "#9B1C1C",
  successText: "#007A47",
  warningText: "#9A4D00",
  warningMuted: "#FEF0DC",

  text: "#0B1713", // razor-sharp dark pine ink
  textSecondary: "#475952", // crisp cool slate-green (7.2:1 on white)
  textMuted: "#6F8079", // muted labels (4.5:1+ on white)
  white: "#FFFFFF",
  black: "#000000",
} as const;

// The balance header is solid Proxim Forest with crisp emerald accents.
export const HERO = {
  text: "#FFFFFF",
  textSecondary: "#A3BCB2", // 8.4:1 on Forest
  accent: "#00C476",
  chip: "#063527",
  inset: "#063527",
  border: "#114E3B",
} as const;
export const BALANCE_GRADIENT = { from: "#002018", to: "#002018", border: "#114E3B" } as const;

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

// Clean, crisp architectural elevation — flat 1px hairline borders with restrained shadow.
export const DEPTH = {
  card: {
    borderWidth: 1,
    borderColor: "#D8E1DC",
    shadowColor: "#002018",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  raised: {
    borderWidth: 1,
    borderColor: "#CFDAD4",
    shadowColor: "#002018",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  // Main CTA: crisp solid emerald with tight elevation, zero cartoon bottom lip.
  glow: {
    borderWidth: 0,
    shadowColor: "#002018",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 6,
    elevation: 3,
  },
  // Forest blocks: crisp architectural edge.
  forest: {
    borderBottomWidth: 1,
    borderBottomColor: "#0F4735",
    shadowColor: "#002018",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 5,
  },
} as const;
