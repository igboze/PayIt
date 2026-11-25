import React, { useRef } from "react";
import { Animated, Platform, Pressable, PressableProps, StyleProp, ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type HapticKind = "light" | "medium" | "selection" | "none";

export function tap(kind: HapticKind = "light") {
  if (kind === "none" || Platform.OS === "web") return;
  try {
    if (kind === "selection") void Haptics.selectionAsync().catch(() => {});
    else void Haptics.impactAsync(kind === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  } catch (_) {
    // Older builds without the native module: press still works, just silently.
  }
}

/** Success or error buzz for finished actions. */
export function notifyHaptic(kind: "success" | "error" = "success") {
  if (Platform.OS === "web") return;
  try {
    void Haptics.notificationAsync(
      kind === "success" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
    ).catch(() => {});
  } catch (_) {
    // Native module missing on older builds.
  }
}

/**
 * Pressable that physically "sinks" when touched: springs down to `depth` scale and dips
 * slightly, with a light haptic tap, then springs back on release.
 */
export function PressableScale({
  children,
  style,
  depth = 0.96,
  haptic = "light",
  disabled,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  depth?: number;
  haptic?: HapticKind;
}) {
  const press = useRef(new Animated.Value(0)).current;
  const to = (v: number) =>
    Animated.spring(press, { toValue: v, useNativeDriver: true, speed: 40, bounciness: v ? 0 : 8 }).start();

  const scale = press.interpolate({ inputRange: [0, 1], outputRange: [1, depth] });
  const translateY = press.interpolate({ inputRange: [0, 1], outputRange: [0, 1.5] });

  return (
    <AnimatedPressable
      {...rest}
      style={[style, { transform: [{ scale }, { translateY }] }]}
      disabled={disabled}
      onPressIn={(e) => {
        to(1);
        tap(haptic);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(0);
        onPressOut?.(e);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}
