// Proxim Mobile App — Dark Premium design tokens

export const COLORS = {
  bg: "#0B1117",
  surface: "#121A22",
  surfaceElevated: "#192430",
  surfaceSoft: "#15202B",
  border: "#22303E",
  borderStrong: "#2E4052",

  primary: "#10B981",
  primaryDark: "#059669",
  primaryMuted: "rgba(16, 185, 129, 0.14)",
  primaryBorder: "rgba(16, 185, 129, 0.35)",

  business: "#F59E0B",
  businessMuted: "rgba(245, 158, 11, 0.14)",
  businessBorder: "rgba(245, 158, 11, 0.35)",

  info: "#38BDF8",
  infoMuted: "rgba(56, 189, 248, 0.14)",

  danger: "#EF4444",
  dangerMuted: "rgba(239, 68, 68, 0.14)",
  dangerBorder: "rgba(239, 68, 68, 0.35)",

  text: "#F8FAFC",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  white: "#FFFFFF",
  black: "#000000",
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
} as const;

export const RADIUS = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

// Layered depth: a soft drop shadow plus a lighter top edge reads as a raised surface.
export const DEPTH = {
  card: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
    borderTopColor: "rgba(255, 255, 255, 0.09)",
  },
  raised: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
    borderTopColor: "rgba(255, 255, 255, 0.12)",
  },
  glow: {
    shadowColor: "#10B981",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 10,
  },
} as const;
