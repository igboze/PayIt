import React, { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { COLORS, DEPTH, FONTS, RADIUS, TYPE, createThemeStyles } from "../theme";

// The licensed partners that hold and move the money, shown where people decide to trust us.
const PARTNERS = [
  { name: "Nuvion", role: "Accounts & cards", domain: "nuvion.co" },
  { name: "Circle", role: "USDC dollars", domain: "circle.com" },
];

function PartnerLogo({ name, domain }: { name: string; domain: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[styles.logo, styles.logoFallback]}>
        <Text style={styles.logoLetter}>{name[0]}</Text>
      </View>
    );
  }
  return (
    <View style={styles.logo}>
      <Image
        source={{ uri: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` }}
        onError={() => setFailed(true)}
        style={{ width: 26, height: 26, borderRadius: 6 }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

/** "Powered by licensed providers" with the Nuvion and Circle logos. */
export function PoweredBy() {
  return (
    <View style={styles.wrap} accessibilityLabel="Powered by licensed providers Nuvion and Circle">
      <Text style={styles.title}>Powered by licensed providers</Text>
      <View style={styles.row}>
        {PARTNERS.map((p) => (
          <View key={p.name} style={styles.partner}>
            <PartnerLogo name={p.name} domain={p.domain} />
            <View>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.role}>{p.role}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = createThemeStyles(() => ({
  wrap: { alignItems: "center", gap: 10, marginTop: 18 },
  title: { ...TYPE.overline, color: COLORS.textSecondary },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  partner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
  },
  logo: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.border },
  logoFallback: { backgroundColor: COLORS.surfaceElevated },
  logoLetter: { fontFamily: FONTS.bold, fontSize: 16, color: COLORS.text },
  name: { ...TYPE.bodyStrong, color: COLORS.text },
  role: { ...TYPE.label, fontSize: 12, color: COLORS.textSecondary },
}));
