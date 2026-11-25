import React, { useState } from "react";
import { Image, Platform, StyleSheet, Text, View } from "react-native";
import { FONTS } from "../theme";

// The official Proxim card artwork, the same template the Telegram bot renders cards on
// (src/assets/proxim_card_template.png, 1024 x 682). Only the dynamic fields are drawn on
// top, at the bot's coordinates (src/card_image_generator.js), scaled to the card width.
const CARD_ART = require("../../assets/proxim_card.png");
const TEMPLATE_W = 1024;
const TEMPLATE_H = 682;
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** Text placed with its baseline at (x, y) on the 1024-wide template. */
function Field({
  scale,
  x,
  baseline,
  size,
  spacing = 0,
  mono = false,
  children,
}: {
  scale: number;
  x: number;
  baseline: number;
  size: number;
  spacing?: number;
  mono?: boolean;
  children: React.ReactNode;
}) {
  const fontSize = size * scale;
  return (
    <Text
      numberOfLines={1}
      style={{
        position: "absolute",
        left: x * scale,
        top: (baseline - size * 0.93) * scale,
        fontSize,
        lineHeight: fontSize * 1.15,
        letterSpacing: spacing * scale,
        color: "#FFFFFF",
        fontFamily: mono ? MONO : FONTS.regular,
        includeFontPadding: false,
      }}
    >
      {children}
    </Text>
  );
}

export function ProximCardFace({
  last4,
  expiryMonth,
  expiryYear,
  holderName,
  frozen = false,
}: {
  last4?: string | null;
  expiryMonth?: string | number | null;
  expiryYear?: string | number | null;
  holderName?: string | null;
  frozen?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const scale = width / TEMPLATE_W;
  const tail = String(last4 || "").replace(/\D/g, "").slice(-4).padStart(4, "•");
  const mm = expiryMonth ? String(expiryMonth).padStart(2, "0").slice(-2) : "--";
  const yy = expiryYear ? String(expiryYear).slice(-2) : "--";
  const holder = String(holderName || "PROXIM MEMBER").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 26);

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Image source={CARD_ART} style={styles.art} resizeMode="stretch" />
      {width > 0 ? (
        <>
          <Field scale={scale} x={112} baseline={417} size={52} spacing={1.5} mono>
            {`•••• •••• •••• ${tail}`}
          </Field>
          <Field scale={scale} x={186} baseline={490} size={35} spacing={0.5} mono>
            {`${mm}/${yy}`}
          </Field>
          <Field scale={scale} x={114} baseline={542} size={31} spacing={5}>
            {holder}
          </Field>
        </>
      ) : null}
      {frozen ? (
        <View style={styles.frozen}>
          <Text style={styles.frozenText}>Frozen</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    aspectRatio: TEMPLATE_W / TEMPLATE_H,
  },
  art: {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
  },
  frozen: {
    position: "absolute",
    // The artwork has a transparent margin; keep the overlay on the card itself.
    left: "2.7%",
    right: "2.7%",
    top: "5%",
    bottom: "5%",
    borderRadius: 22,
    backgroundColor: "rgba(14, 21, 18, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  frozenText: {
    color: "#FFFFFF",
    fontFamily: FONTS.bold,
    fontSize: 18,
    letterSpacing: 1,
  },
});
