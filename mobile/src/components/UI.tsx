import React, { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
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
import { COLORS, DEPTH, HERO, RADIUS, SPACING, FONTS, TABULAR_NUMS, TYPE, createThemeStyles } from "../theme";
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
      ? COLORS.business
      : tone === "danger"
      ? COLORS.dangerMuted
      : COLORS.primary
    : COLORS.surface;
  const borderColor = active
    ? tone === "business"
      ? COLORS.business
      : tone === "danger"
      ? COLORS.dangerBorder
      : COLORS.primary
    : COLORS.border;
  const textColor = active
    ? tone === "business"
      ? COLORS.white
      : tone === "danger"
      ? COLORS.dangerText
      : COLORS.onPrimary
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

const styles = createThemeStyles(() => ({
  hero: {
    backgroundColor: COLORS.forest,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: HERO.border,
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
    height: 52,
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
    borderWidth: 1,
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
    marginBottom: 14,
  },
  inputLabel: {
    ...TYPE.label,
    fontFamily: FONTS.bold,
    color: COLORS.textSecondary,
    marginBottom: 6,
  },
  input: {
    minHeight: 50,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.text,
    fontFamily: FONTS.medium,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: COLORS.primary,
    borderWidth: 1.5,
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
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  inputMultiline: {
    minHeight: 92,
    textAlignVertical: "top",
  },
  inputHint: {
    ...TYPE.label,
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 5,
  },
  pill: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 13,
    paddingVertical: 6,
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
    marginTop: 2,
  },
  sectionTitle: {
    ...TYPE.headline,
    fontFamily: FONTS.bold,
    fontSize: 15.5,
    color: COLORS.text,
  },
  screenHeader: {
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: SPACING.sm + 2,
    paddingRight: SPACING.md,
    backgroundColor: COLORS.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  screenHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 6,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    marginRight: 4,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  screenTitle: {
    ...TYPE.headline,
    fontFamily: FONTS.extrabold,
    fontSize: 17,
    color: COLORS.text,
  },
  screenSubtitle: {
    ...TYPE.label,
    fontSize: 12,
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
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
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
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
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
    ...TABULAR_NUMS,
    color: COLORS.text,
    textAlign: "right",
    flexShrink: 1,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(3, 12, 9, 0.65)",
    justifyContent: "flex-end",
  },
  sheetDismissArea: {
    flex: 1,
  },
  sheetBox: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: SPACING.lg,
    paddingTop: 10,
    paddingBottom: 24,
    maxHeight: "90%",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderStrong,
    marginBottom: 14,
  },
  sheetTitle: {
    ...TYPE.title,
    fontSize: 18,
    color: COLORS.text,
    marginBottom: 4,
  },
  sheetSub: {
    ...TYPE.label,
    color: COLORS.textSecondary,
    marginBottom: 14,
  },
  segWrap: {
    flexDirection: "row",
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 3,
    gap: 3,
    marginBottom: SPACING.md,
  },
  segItem: {
    flex: 1,
    minHeight: 36,
    borderRadius: RADIUS.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
  },
  segItemActive: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  segLabel: {
    ...TYPE.label,
    fontSize: 12.5,
    fontFamily: FONTS.semibold,
    color: COLORS.textSecondary,
  },
  segLabelActive: {
    color: COLORS.text,
    fontFamily: FONTS.bold,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  listRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  listRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  listRowTitle: {
    ...TYPE.bodyStrong,
    color: COLORS.text,
  },
  listRowSub: {
    ...TYPE.label,
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  badgeRowText: {
    fontFamily: FONTS.bold,
    fontSize: 11,
    letterSpacing: 0.2,
  },
  skelCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    gap: 10,
    ...DEPTH.card,
  },
}));

/** Unified bottom sheet with consistent drag handle, backdrop dismiss, dark-mode border, and keyboard lift. */
export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.sheetBackdrop} behavior="padding">
        <Pressable style={styles.sheetDismissArea} onPress={onClose} />
        <View style={styles.sheetBox}>
          <View style={styles.sheetHandle} />
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          {subtitle ? <Text style={styles.sheetSub}>{subtitle}</Text> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Crisp institutional segmented control (replaces wrapped pill bars on top-level tabs). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: Array<{ value: T; label: string; icon?: keyof typeof Ionicons.glyphMap }>;
  value: T;
  onChange: (next: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segWrap, style]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <PressableScale
            key={opt.value}
            onPress={() => onChange(opt.value)}
            haptic="selection"
            depth={0.97}
            style={[styles.segItem, active && styles.segItemActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            {opt.icon ? (
              <Ionicons
                name={opt.icon}
                size={14}
                color={active ? COLORS.primary : COLORS.textMuted}
              />
            ) : null}
            <Text style={[styles.segLabel, active && styles.segLabelActive]} numberOfLines={1}>
              {opt.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** Grouped settings / action list row with icon, title, subtitle, optional right content, and chevron. */
export function ListRow({
  icon,
  iconColor,
  iconBg,
  title,
  subtitle,
  right,
  onPress,
  showChevron = true,
  last = false,
  danger = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  last?: boolean;
  danger?: boolean;
}) {
  const inner = (
    <View style={[styles.listRow, !last && styles.listRowBorder]}>
      <View
        style={[
          styles.listRowIcon,
          iconBg ? { backgroundColor: iconBg } : danger ? { backgroundColor: COLORS.dangerMuted } : null,
        ]}
      >
        <Ionicons
          name={icon}
          size={18}
          color={iconColor || (danger ? COLORS.dangerText : COLORS.primary)}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.listRowTitle, danger && { color: COLORS.dangerText }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.listRowSub} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {showChevron && onPress ? <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} /> : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <PressableScale onPress={onPress} depth={0.99} haptic="selection">
      {inner}
    </PressableScale>
  );
}

/** Semantic status pill with crisp vector icon (zero emojis). */
export function StatusBadge({
  label,
  tone = "success",
  icon,
}: {
  label: string;
  tone?: "success" | "warning" | "danger" | "business" | "neutral";
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const palette =
    tone === "success"
      ? { bg: COLORS.primaryMuted, border: COLORS.primaryBorder, fg: COLORS.successText }
      : tone === "warning"
        ? { bg: COLORS.warningMuted, border: COLORS.warningBorder, fg: COLORS.warningText }
        : tone === "danger"
          ? { bg: COLORS.dangerMuted, border: COLORS.dangerBorder, fg: COLORS.dangerText }
          : tone === "business"
            ? { bg: COLORS.businessMuted, border: COLORS.businessBorder, fg: COLORS.business }
            : { bg: COLORS.surfaceElevated, border: COLORS.border, fg: COLORS.textSecondary };
  return (
    <View style={[styles.badgeRow, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      {icon ? <Ionicons name={icon} size={12} color={palette.fg} /> : null}
      <Text style={[styles.badgeRowText, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

/** Subtle pulsing skeleton block for structured loading states. */
export function SkeletonBox({
  width = "100%",
  height = 14,
  radius = 8,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: COLORS.surfaceElevated,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

/** Structured card-shaped skeleton placeholder. */
export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <View style={styles.skelCard}>
      <SkeletonBox width="42%" height={14} />
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <SkeletonBox width={38} height={38} radius={10} />
          <View style={{ flex: 1, gap: 6 }}>
            <SkeletonBox width={i % 2 === 0 ? "62%" : "48%"} height={12} />
            <SkeletonBox width="36%" height={10} />
          </View>
          <SkeletonBox width={58} height={14} />
        </View>
      ))}
    </View>
  );
}

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
