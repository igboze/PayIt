// Bill categories, their icons, and provider logos (loaded from each provider's own website
// icon, so people recognise MTN, DStv, Ikeja Electric, Bet9ja... at a glance).
import React, { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, DEPTH, FONTS, RADIUS, TYPE } from "../theme";
import { PressableScale } from "./Touch";

export type BillCat = "airtime" | "data" | "electricity" | "cable" | "transport" | "betting";

export const BILL_CATEGORIES: Array<{ key: BillCat; label: string; icon: keyof typeof Ionicons.glyphMap; fg: string; bg: string }> = [
  { key: "airtime", label: "Airtime", icon: "call", fg: "#047857", bg: "#D1FAE5" },
  { key: "data", label: "Data", icon: "wifi", fg: "#1D4ED8", bg: "#DBEAFE" },
  { key: "electricity", label: "Electricity", icon: "flash", fg: "#B45309", bg: "#FEF3C7" },
  { key: "cable", label: "Cable TV", icon: "tv", fg: "#6D28D9", bg: "#EDE9FE" },
  { key: "transport", label: "Transport", icon: "bus", fg: "#0F766E", bg: "#CCFBF1" },
  { key: "betting", label: "Betting", icon: "football", fg: "#BE185D", bg: "#FCE7F3" },
];

// Provider name fragment -> website domain, for the logo.
const PROVIDER_DOMAINS: Array<[RegExp, string]> = [
  [/\bmtn\b/i, "mtn.ng"],
  [/\bglo\b|globacom/i, "gloworld.com"],
  [/airtel/i, "airtel.com.ng"],
  [/9\s*mobile|etisalat/i, "9mobile.com.ng"],
  [/smile/i, "smile.com.ng"],
  [/spectranet/i, "spectranet.com.ng"],
  [/dstv/i, "dstv.com"],
  [/gotv/i, "gotvafrica.com"],
  [/star\s*times/i, "startimes.com.ng"],
  [/showmax/i, "showmax.com"],
  [/ikeja/i, "ikejaelectric.com"],
  [/\beko\b|ekedc|ekedp/i, "ekedp.com"],
  [/abuja|aedc/i, "aedc.com.ng"],
  [/ibadan|ibedc/i, "ibedc.com"],
  [/enugu|eedc/i, "enugudisco.com"],
  [/port\s*harcourt|phed/i, "phed.com.ng"],
  [/kano|kedco/i, "kedco.ng"],
  [/\bjos\b|jed/i, "jedplc.com"],
  [/kaduna/i, "kadunaelectric.com"],
  [/benin|bedc/i, "bedcpower.com"],
  [/yola|yedc/i, "yedc.com.ng"],
  [/aba\s*power/i, "abapower.com"],
  [/bet9ja/i, "bet9ja.com"],
  [/sporty/i, "sportybet.com"],
  [/betking/i, "betking.com"],
  [/1\s*x\s*bet/i, "1xbet.com"],
  [/nairabet/i, "nairabet.com"],
  [/msport/i, "msport.com"],
  [/bangbet/i, "bangbet.com"],
  [/betway/i, "betway.com.ng"],
  [/merrybet/i, "merrybet.com"],
  [/betlion/i, "betlion.ng"],
  [/paripesa/i, "paripesa.ng"],
  [/22\s*bet/i, "22bet.ng"],
  [/cowry/i, "cowry.ng"],
  [/\blcc\b|lekki/i, "lcc.com.ng"],
  [/gigm|god is good/i, "gigm.com"],
  [/abc transport/i, "abctransport.com"],
];

export function providerLogoUrl(name: string): string | null {
  const hit = PROVIDER_DOMAINS.find(([re]) => re.test(name));
  return hit ? `https://www.google.com/s2/favicons?domain=${hit[1]}&sz=128` : null;
}

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 3)).toUpperCase();
}

/** Round provider logo, falling back to clear initials. */
export function ProviderLogo({ name, size = 44 }: { name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const uri = providerLogoUrl(name);
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (uri && !failed) {
    return (
      <View style={[box, styles.logoFrame]}>
        <Image source={{ uri }} onError={() => setFailed(true)} style={{ width: size * 0.78, height: size * 0.78, borderRadius: size * 0.2 }} resizeMode="contain" />
      </View>
    );
  }
  return (
    <View style={[box, styles.logoFrame, { backgroundColor: COLORS.surfaceElevated }]}>
      <Text style={{ fontFamily: FONTS.bold, fontSize: Math.round(size * 0.3), color: COLORS.text }}>{initials(name)}</Text>
    </View>
  );
}

/** Big tappable tile with a provider logo and name, for grids. */
export function ProviderTile({
  name,
  sub,
  badge,
  badgeTone = "neutral",
  wide = false,
  selected,
  onPress,
}: {
  name: string;
  sub?: string;
  badge?: string;
  badgeTone?: "prepaid" | "postpaid" | "neutral";
  wide?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  const badgeColors =
    badgeTone === "prepaid"
      ? { bg: "#D1FAE5", fg: "#065F46" }
      : badgeTone === "postpaid"
        ? { bg: "#FEF3C7", fg: "#92400E" }
        : { bg: COLORS.surfaceElevated, fg: COLORS.textSecondary };
  return (
    <PressableScale
      onPress={onPress}
      depth={0.95}
      haptic="selection"
      style={[styles.tile, wide && styles.tileWide, selected && styles.tileOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      accessibilityLabel={[name, badge, sub].filter(Boolean).join(", ")}
    >
      <ProviderLogo name={name} size={wide ? 38 : 42} />
      <Text style={[styles.tileName, wide && styles.tileNameCompact]} numberOfLines={3}>
        {name}
      </Text>
      {badge ? (
        <View style={[styles.badgePill, { backgroundColor: badgeColors.bg }]}>
          <Text style={[styles.badgeText, { color: badgeColors.fg }]}>{badge}</Text>
        </View>
      ) : null}
      {sub ? (
        <Text style={styles.tileSub} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
      {selected ? (
        <View style={styles.check}>
          <Ionicons name="checkmark" size={14} color={COLORS.onPrimary} />
        </View>
      ) : null}
    </PressableScale>
  );
}

/** Icon tile for a bill category (Home shortcuts and the Bills screen). */
export function BillCategoryTile({ cat, selected, onPress, compact }: { cat: (typeof BILL_CATEGORIES)[number]; selected?: boolean; onPress: () => void; compact?: boolean }) {
  return (
    <PressableScale
      onPress={onPress}
      depth={0.94}
      style={[styles.catTile, compact && styles.catTileCompact, selected && styles.tileOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      accessibilityLabel={cat.label}
    >
      <View style={[styles.catIcon, { backgroundColor: cat.bg }]}>
        <Ionicons name={cat.icon} size={compact ? 22 : 26} color={cat.fg} />
      </View>
      <Text style={styles.catLabel}>{cat.label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  logoFrame: { backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.border, overflow: "hidden" },
  tile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 108,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 10,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
  },
  tileWide: {
    flexBasis: "46%",
    minHeight: 118,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  tileOn: { borderColor: COLORS.primary, borderWidth: 2, borderBottomWidth: 4, borderBottomColor: COLORS.primaryDark, backgroundColor: COLORS.deep },
  tileName: { fontSize: 13, lineHeight: 17, fontFamily: FONTS.semibold, color: COLORS.text, textAlign: "center" },
  tileNameCompact: { fontSize: 12, lineHeight: 16, fontFamily: FONTS.semibold, color: COLORS.text, textAlign: "center" },
  badgePill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: RADIUS.pill },
  badgeText: { fontSize: 11, lineHeight: 14, fontFamily: FONTS.bold, letterSpacing: 0.2 },
  tileSub: { ...TYPE.label, fontSize: 12, color: COLORS.textSecondary, textAlign: "center" },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  catTile: {
    flexBasis: "30%",
    flexGrow: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
  },
  catTileCompact: { paddingVertical: 12 },
  catIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  catLabel: { ...TYPE.label, fontFamily: FONTS.semibold, color: COLORS.text, textAlign: "center" },
});
