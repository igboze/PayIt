import React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, DEPTH, HERO, RADIUS, SPACING, FONTS, TYPE } from "../theme";
import { PressableScale } from "./Touch";
import { CurrencyLogo, currencyInText } from "./CurrencyLogo";
import { toUserError } from "../utils/errors";

/** Explicit code, or false to hide; when omitted the code is read from the label text. */
type CurrencyProp = { currency?: string | false };
function pickCurrency(currency: string | false | undefined, text?: string | null): string | null {
  if (currency === false) return null;
  return currency || currencyInText(text);
}

export function formatUsdc(value: number | string | null | undefined, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatNgn(value: number | string | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

export function formatRawTxAmount(raw: string, decimals = 18): string {
  const s = String(raw || "").trim();
  if (!s) return "—";
  if (/^\d+$/.test(s) && decimals > 0) {
    const padded = s.padStart(decimals + 1, "0");
    const whole = padded.slice(0, padded.length - decimals);
    const frac = padded.slice(padded.length - decimals, padded.length - decimals + 4).replace(/0+$/, "");
    const n = Number(`${whole}.${frac || "0"}`);
    if (Number.isFinite(n)) return formatUsdc(n);
  }
  const n = Number(s);
  if (Number.isFinite(n)) return formatUsdc(n);
  return s;
}

export function shortAddr(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return "Not available";
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Makes the whole card a raised, pressable surface. */
  onPress?: () => void;
}) {
  if (onPress) {
    return (
      <PressableScale onPress={onPress} depth={0.98} style={[styles.card, style]}>
        {children}
      </PressableScale>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = "primary",
  style,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      haptic={variant === "primary" ? "medium" : "light"}
      style={[
        styles.btn,
        variant === "primary" && styles.btnPrimary,
        variant === "secondary" && styles.btnSecondary,
        variant === "danger" && styles.btnDanger,
        variant === "ghost" && styles.btnGhost,
        isDisabled && { opacity: 0.5, shadowOpacity: 0, elevation: 0 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? COLORS.onGold : COLORS.text} size="small" />
      ) : (
        <Text
          style={[
            styles.btnText,
            variant === "primary" && { color: COLORS.onGold, fontFamily: FONTS.extrabold },
            variant === "danger" && { color: COLORS.danger },
            variant === "ghost" && { color: COLORS.textSecondary },
          ]}
        >
          {title}
        </Text>
      )}
    </PressableScale>
  );
}

export function Input({
  label,
  hint,
  currency,
  ...props
}: TextInputProps & { label?: string; hint?: string } & CurrencyProp) {
  const code = pickCurrency(currency, label);
  // Secure fields (PINs) get a show/hide toggle so people can check what they typed.
  const [reveal, setReveal] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const secure = Boolean(props.secureTextEntry);
  return (
    <View style={styles.inputWrap}>
      {label ? (
        <View style={[styles.labelRow, { marginBottom: 6 }]}>
          {code ? <CurrencyLogo code={code} size={16} /> : null}
          <Text style={[styles.inputLabel, { marginBottom: 0 }]}>{label}</Text>
        </View>
      ) : null}
      <View>
        <TextInput
          placeholderTextColor={COLORS.textMuted}
          selectionColor={COLORS.primary}
          {...props}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
          secureTextEntry={secure && !reveal}
          style={[
            styles.input,
            focused && styles.inputFocused,
            props.multiline && styles.inputMultiline,
            secure && styles.inputSecure,
            props.style,
          ]}
        />
        {secure ? (
          <Pressable
            onPress={() => setReveal((r) => !r)}
            hitSlop={10}
            style={styles.revealBtn}
            accessibilityRole="button"
            accessibilityLabel={reveal ? "Hide PIN" : "Show PIN"}
          >
            <Ionicons name={reveal ? "eye-off-outline" : "eye-outline"} size={22} color={COLORS.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.inputHint}>{hint}</Text> : null}
    </View>
  );
}

export function Pill({
  label,
  active = false,
  tone = "primary",
  onPress,
  currency,
}: {
  label: string;
  active?: boolean;
  tone?: "primary" | "business" | "danger" | "neutral";
  onPress?: () => void;
  /** Only shown when given; pill labels are too short to guess from. */
  currency?: string;
}) {
  const bg = active
    ? tone === "business"
      ? COLORS.gold
      : tone === "danger"
      ? COLORS.dangerMuted
      : COLORS.forest
    : COLORS.surface;
  const borderColor = active
    ? tone === "business"
      ? COLORS.gold
      : tone === "danger"
      ? COLORS.dangerBorder
      : COLORS.forest
    : COLORS.border;
  const textColor = active
    ? tone === "business"
      ? COLORS.onGold
      : tone === "danger"
      ? COLORS.danger
      : COLORS.white
    : COLORS.text;

  const inner = (
    <View style={[styles.pill, { backgroundColor: bg, borderColor }, currency ? styles.pillWithLogo : null]}>
      {currency ? <CurrencyLogo code={currency} size={16} /> : null}
      <Text style={[styles.pillText, { color: textColor }]}>{label}</Text>
    </View>
  );
  if (!onPress) return inner;
  return (
    <PressableScale onPress={onPress} depth={0.94} haptic="selection">
      {inner}
    </PressableScale>
  );
}

export function SectionHeader({
  title,
  right,
  currency,
}: {
  title: string;
  right?: React.ReactNode;
} & CurrencyProp) {
  const code = pickCurrency(currency, title);
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.labelRow, { flexShrink: 1 }]}>
        {code ? <CurrencyLogo code={code} size={20} /> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.screenHeader}>
      <View style={styles.screenHeaderLeft}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={22} color={COLORS.text} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.screenTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.screenSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {right}
    </View>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  const safeMessage = toUserError(message);
  return (
    <View style={styles.errorBanner}>
      <Ionicons name="alert-circle" size={18} color={COLORS.danger} style={{ marginTop: 1 }} />
      <Text style={styles.errorText}>{safeMessage}</Text>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={8}>
          <Ionicons name="close" size={18} color={COLORS.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function SuccessBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <View style={styles.successBanner}>
      <Ionicons name="checkmark-circle" size={18} color={COLORS.success} style={{ marginTop: 1 }} />
      <Text style={styles.successText}>{message}</Text>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={8}>
          <Ionicons name="close" size={18} color={COLORS.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({
  icon = "layers-outline",
  title,
  subtitle,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={COLORS.primary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

export function KeyValueRow({
  label,
  value,
  onCopy,
  currency,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
} & CurrencyProp) {
  const code = pickCurrency(currency, label);
  return (
    <View style={styles.kvRow}>
      <View style={[styles.labelRow, { flexShrink: 1 }]}>
        {code ? <CurrencyLogo code={code} size={16} /> : null}
        <Text style={styles.kvLabel}>{label}</Text>
      </View>
      <View style={styles.kvRight}>
        <Text style={styles.kvValue} selectable numberOfLines={2}>
          {value}
        </Text>
        {onCopy ? (
          <Pressable onPress={onCopy} hitSlop={8} style={styles.kvCopy} accessibilityRole="button" accessibilityLabel={`Copy ${label}`}>
            <Ionicons name="copy-outline" size={15} color={COLORS.goldDark} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The Forest summary block used at the top of money screens (Home, Savings, Stocks, Cards):
 * gold overline, a big two-weight number, a soft subtitle, then any actions.
 */
export function ForestHero({
  overline,
  amount,
  sub,
  children,
  style,
}: {
  overline: string;
  amount: string;
  sub?: string | null;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const dot = amount.lastIndexOf(".");
  const whole = dot > 0 ? amount.slice(0, dot) : amount;
  const cents = dot > 0 ? amount.slice(dot) : "";
  return (
    <View style={[styles.hero, style]}>
      <Text style={styles.heroOver}>{overline}</Text>
      <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>
        {whole}
        {cents ? <Text style={styles.heroCents}>{cents}</Text> : null}
      </Text>
      {sub ? <Text style={styles.heroSub}>{sub}</Text> : null}
      {children ? <View style={{ marginTop: 14, gap: 10 }}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: COLORS.forest,
    borderRadius: RADIUS.xl,
    paddingHorizontal: 20,
    paddingVertical: 20,
    marginBottom: SPACING.md,
    ...DEPTH.forest,
  },
  heroOver: { ...TYPE.overline, color: HERO.accent },
  heroAmount: { ...TYPE.xl, fontSize: 38, lineHeight: 46, color: HERO.text, marginTop: 4 },
  heroCents: { fontSize: 22, color: HERO.textSecondary },
  heroSub: { ...TYPE.label, color: HERO.textSecondary, marginTop: 2 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pillWithLogo: { flexDirection: "row", alignItems: "center", gap: 6 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    overflow: "hidden",
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...DEPTH.card,
  },
  btn: {
    height: 56,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.md,
  },
  btnPrimary: {
    backgroundColor: COLORS.gold,
    ...DEPTH.glow,
  },
  btnSecondary: {
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
  },
  btnDanger: {
    backgroundColor: COLORS.dangerMuted,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
  },
  btnGhost: {
    backgroundColor: "transparent",
  },
  btnText: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
  },
  inputWrap: {
    marginBottom: SPACING.md,
  },
  inputLabel: {
    ...TYPE.label,
    fontFamily: FONTS.bold,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  input: {
    minHeight: 56,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: "#A69B84", // ~3:1 against white so field edges are visible
    borderRadius: RADIUS.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: COLORS.text,
    fontFamily: FONTS.medium,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: COLORS.forest,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  inputSecure: {
    paddingRight: 52,
    letterSpacing: 6,
    fontSize: 20,
  },
  revealBtn: {
    position: "absolute",
    right: 4,
    top: 0,
    bottom: 0,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  inputHint: {
    ...TYPE.label,
    color: COLORS.textMuted,
    marginTop: 6,
  },
  pill: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  pillText: {
    ...TYPE.label,
    fontFamily: FONTS.bold,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    marginTop: SPACING.sm,
  },
  sectionTitle: {
    ...TYPE.headline,
    fontFamily: FONTS.extrabold,
    fontSize: 16,
    color: COLORS.text,
  },
  screenHeader: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: SPACING.sm,
    paddingRight: SPACING.md,
    backgroundColor: COLORS.bg,
  },
  screenHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 4,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    marginRight: 6,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  screenTitle: {
    ...TYPE.headline,
    fontFamily: FONTS.extrabold,
    fontSize: 18,
    color: COLORS.text,
  },
  screenSubtitle: {
    ...TYPE.label,
    color: COLORS.textSecondary,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: COLORS.dangerMuted,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
    borderRadius: RADIUS.md,
    padding: 14,
    marginBottom: SPACING.md,
  },
  errorText: {
    ...TYPE.label,
    color: COLORS.dangerText,
    flex: 1,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: "#DDF1E5",
    borderWidth: 1,
    borderColor: "#B7E2C9",
    borderRadius: RADIUS.md,
    padding: 14,
    marginBottom: SPACING.md,
  },
  successText: {
    ...TYPE.label,
    color: COLORS.successText,
    flex: 1,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
    paddingHorizontal: 16,
    gap: 8,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
    textAlign: "center",
  },
  emptySub: {
    ...TYPE.label,
    color: COLORS.textSecondary,
    textAlign: "center",
  },
  kvRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surfaceElevated,
    gap: 12,
  },
  kvCopy: {
    marginLeft: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.goldSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  kvLabel: {
    ...TYPE.label,
    color: COLORS.textSecondary,
  },
  kvRight: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    justifyContent: "flex-end",
  },
  kvValue: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
    textAlign: "right",
    flexShrink: 1,
  },
});

/**
 * Lifts content above the on-screen keyboard. Android runs edge to edge, so the window no
 * longer shrinks for the keyboard by itself; padding works the same on both platforms.
 */
export function KeyboardSafe({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <KeyboardAvoidingView style={[{ flex: 1 }, style]} behavior="padding">
      {children}
    </KeyboardAvoidingView>
  );
}
