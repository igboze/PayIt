import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import { COLORS, RADIUS, TYPE, createThemeStyles } from "../theme";
import { Button } from "./UI";

/**
 * Full-screen "Updating Proxim" view shown while an update is applied, so people see
 * progress instead of a blank screen. Restarts into the new version after a short beat.
 */
export function UpdatingScreen({ apply, onCancel }: { apply: () => Promise<void>; onCancel: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    const go = setTimeout(() => {
      apply().catch(() => setStuck(true));
    }, 1500);
    // If the restart doesn't happen, offer a way out instead of spinning forever.
    const giveUp = setTimeout(() => setStuck(true), 12000);
    return () => {
      clearTimeout(go);
      clearTimeout(giveUp);
    };
  }, [apply, progress]);

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ["4%", "100%"] });

  return (
    <View style={styles.root} accessibilityLiveRegion="polite">
      <Image source={require("../../assets/icon.png")} style={styles.logo} />
      <Text style={styles.title}>{stuck ? "Almost there" : "Updating Proxim"}</Text>
      <Text style={styles.body}>
        {stuck
          ? "Close Proxim and open it again to finish the update."
          : "Installing the latest version. This takes a few seconds; your money and settings stay as they are."}
      </Text>
      <View style={styles.track} accessibilityRole="progressbar">
        <Animated.View style={[styles.fill, { width }]} />
      </View>
      {stuck ? <Button title="Back to the app" variant="secondary" onPress={onCancel} style={{ alignSelf: "stretch" }} /> : null}
    </View>
  );
}

const styles = createThemeStyles(() => ({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 14, backgroundColor: COLORS.page },
  logo: { width: 80, height: 80, borderRadius: 22, marginBottom: 6 },
  title: { ...TYPE.title, color: COLORS.text, textAlign: "center" },
  body: { ...TYPE.body, color: COLORS.textSecondary, textAlign: "center" },
  track: { alignSelf: "stretch", height: 10, borderRadius: RADIUS.pill, backgroundColor: COLORS.border, overflow: "hidden", marginTop: 8 },
  fill: { height: 10, borderRadius: RADIUS.pill, backgroundColor: COLORS.primary },
}));
