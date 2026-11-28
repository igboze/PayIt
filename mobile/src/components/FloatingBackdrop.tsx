import React from "react";
import { StyleSheet, View } from "react-native";
import { COLORS } from "../theme";

// Crisp solid matte mineral canvas — zero blurry glowing orbs so the UI reads like a
// real institutional bank rather than a generic gradient template.
export function FloatingBackdrop() {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.base]} />;
}

const styles = StyleSheet.create({
  base: { backgroundColor: COLORS.page },
});
