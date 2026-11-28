import React from "react";
import { StyleSheet, View } from "react-native";
import { COLORS, createThemeStyles } from "../theme";

// Crisp solid matte mineral canvas — zero blurry glowing orbs so the UI reads like a
// real institutional bank rather than a generic gradient template.
export function FloatingBackdrop() {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.base]} />;
}

const styles = createThemeStyles(() => ({
  base: { backgroundColor: COLORS.page },
}));
