import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";
import { COLORS } from "../theme";

// Soft light behind the whole app: white page with slow-drifting orbs of mint, emerald and
// teal, and one white glow. Each orb is a stack of faint circles, which gives a feathered,
// blurred edge without a native blur module. Sits behind every screen; cards stay white.
type Orb = { color: string; size: number; top: number | string; left: number | string; strength: number; drift: number; ms: number };

const ORBS: Orb[] = [
  { color: "#34D399", size: 420, top: -160, left: -170, strength: 0.045, drift: 22, ms: 14000 },
  { color: "#0A9F5A", size: 280, top: "38%", left: "66%", strength: 0.03, drift: 26, ms: 17000 },
  { color: "#5EEAD4", size: 320, top: "70%", left: -140, strength: 0.03, drift: 20, ms: 15500 },
  { color: "#FFFFFF", size: 360, top: "12%", left: "18%", strength: 0.35, drift: 16, ms: 19000 },
];

const RINGS = [1, 0.8, 0.62, 0.45, 0.3];

function FloatingOrb({ orb, still }: { orb: Orb; still: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: orb.ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: orb.ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [still, orb.ms, t]);

  const translateX = t.interpolate({ inputRange: [0, 1], outputRange: [-orb.drift, orb.drift] });
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [orb.drift * 0.6, -orb.drift * 0.6] });
  const scale = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.06, 1] });

  return (
    <Animated.View
      style={{
        position: "absolute",
        top: orb.top as number,
        left: orb.left as number,
        width: orb.size,
        height: orb.size,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ translateX }, { translateY }, { scale }],
      }}
    >
      {RINGS.map((r, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            width: orb.size * r,
            height: orb.size * r,
            borderRadius: (orb.size * r) / 2,
            backgroundColor: orb.color,
            opacity: orb.strength,
          }}
        />
      ))}
    </Animated.View>
  );
}

export function FloatingBackdrop() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setStill).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.base]}>
      {ORBS.map((orb, i) => (
        <FloatingOrb key={i} orb={orb} still={still} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: COLORS.page, overflow: "hidden" },
});
