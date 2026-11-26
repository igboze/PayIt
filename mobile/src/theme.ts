// Proxim Mobile App — design tokens (Forest & Gold). Warm stone page, white cards, a solid
// Proxim Forest balance header and gold main actions; type, radii and spacing follow the canvas.

export const COLORS = {
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
} as const;

// The balance header is solid Proxim Forest with gold accents.
export const HERO = {
  text: "#FFFFFF",
  textSecondary: "#A8BDB3", // 8.7:1 on Forest
  accent: "#E0A82E",
  chip: "#003526",
  inset: "#003526",
  border: "#0B4A37",
} as const;
export const BALANCE_GRADIENT = { from: "#002018", to: "#002018", border: "#0B4A37" } as const;

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

// Depth: every raised surface gets a visible edge, a thicker darker bottom "lip" and a real
// shadow, so it reads as something you can press, even for people with low vision.
export const DEPTH = {
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
} as const;
