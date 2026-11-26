import React, { useEffect, useState } from "react";
import { Modal, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import { assertPasskey } from "../api/passkey";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING, FONTS, TYPE } from "../theme";
import type { ActionConfirmResponse, ActionIntentResponse } from "../api/types";
import { Button, ErrorBanner, Input, KeyboardSafe, KeyValueRow, shortAddr } from "./UI";
import { notifyHaptic } from "./Touch";

// Actions that move money end on a success page instead of closing silently.
const SUCCESS_HEADINGS: Record<string, string> = {
  "transfer.user": "Money sent",
  "transfer.wallet": "Money sent",
  "payout.ngn": "Payout on its way",
  "payout.global": "Payout on its way",
  "withdraw.crypto": "Withdrawal started",
  "bridge.move": "Transfer started",
  "swap.execute": "Swap complete",
  "bill.pay": "Bill paid",
  "gift.create": "Gift link ready",
  "payroll.run": "Payroll sent",
  "savings.deposit": "Added to savings",
  "savings.withdraw": "Moved to your balance",
  "card.issue": "Card ready",
  "card.topup": "Card topped up",
  "card.unload": "Moved to your balance",
};
const isMoneyAction = (actionType: string) => actionType in SUCCESS_HEADINGS;
const successHeading = (actionType: string) => SUCCESS_HEADINGS[actionType] || "Done";

function SuccessView({ intent, res, onDone }: { intent: ActionIntentResponse; res: ActionConfirmResponse; onDone: () => void }) {
  const reference = res.orderId || res.txHash || null;
  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.successTop}>
        <View style={styles.successRing}>
          <View style={styles.successDot}>
            <Ionicons name="checkmark" size={40} color={COLORS.forest} />
          </View>
        </View>
        <Text style={styles.successHeading}>{successHeading(intent.actionType)}</Text>
        <Text style={styles.successTitle}>{intent.summary.title}</Text>
        {res.notice ? <Text style={styles.successNotice}>{res.notice}</Text> : null}
      </View>
      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.summaryBox}>
          {(intent.summary.lines || []).map(([label, value], idx) => (
            <KeyValueRow key={`${label}-${idx}`} label={label} value={value} />
          ))}
          {res.meterToken ? (
            <KeyValueRow
              currency={false}
              label="Meter token"
              value={String(res.meterToken)}
              onCopy={() => Clipboard.setStringAsync(String(res.meterToken)).catch(() => {})}
            />
          ) : null}
          {reference ? <KeyValueRow label="Reference" value={shortAddr(String(reference), 10, 6)} /> : null}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        {isMoneyAction(intent.actionType) ? (
          <Button
            title="Share receipt"
            variant="secondary"
            onPress={() => {
              const lines = (intent.summary.lines || []).map(([label, value]) => `${label}: ${value}`);
              if (reference) lines.push(`Reference: ${reference}`);
              Share.share({
                message: [`Proxim receipt · ${successHeading(intent.actionType)}`, intent.summary.title, ...lines].join("\n"),
              }).catch(() => {});
            }}
            style={{ marginBottom: 10 }}
          />
        ) : null}
        <Button title="Done" onPress={onDone} />
      </View>
    </View>
  );
}

export function ApprovalSheet() {
  const { pendingApproval, dismissApproval, completeApproval } = useApp();
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ intent: ActionIntentResponse; res: ActionConfirmResponse } | null>(null);

  useEffect(() => {
    setPin("");
    setNewPin("");
    setError(null);
    setSubmitting(false);
  }, [pendingApproval?.intent.challengeId]);

  if (success) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => setSuccess(null)}>
        <KeyboardSafe style={styles.backdrop}>
          <SuccessView intent={success.intent} res={success.res} onDone={() => setSuccess(null)} />
        </KeyboardSafe>
      </Modal>
    );
  }

  if (!pendingApproval) return null;

  const { intent, extraConfirmFields } = pendingApproval;
  const requiresPin = intent.requiresPin;
  const isPinChange = intent.actionType === "pin.change" || intent.actionType === "pin.reset";

  const handleApprove = async () => {
    setError(null);
    if (requiresPin && !/^\d{4}$/.test(pin)) {
      setError("Enter your 4-digit wallet PIN.");
      return;
    }
    if (isPinChange && !/^\d{4}$/.test(newPin)) {
      setError("Enter your new 4-digit PIN.");
      return;
    }
    setSubmitting(true);
    try {
      const assertion = await assertPasskey(intent.options);
      const res = await api.actionConfirm({
        challengeId: intent.challengeId,
        response: assertion,
        ...(requiresPin ? { pin } : {}),
        ...(isPinChange ? { newPin } : {}),
        ...(extraConfirmFields || {}),
      });
      if (isMoneyAction(intent.actionType)) {
        setSuccess({ intent, res });
        notifyHaptic("success");
      }
      completeApproval(res);
    } catch (err) {
      notifyHaptic("error");
      setError(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!submitting) dismissApproval();
      }}
    >
      <KeyboardSafe style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={styles.iconWrap}>
              <Ionicons name="shield-checkmark" size={22} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.kicker}>CONFIRM WITH PASSKEY</Text>
              <Text style={styles.title}>{intent.summary.title}</Text>
            </View>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            <View style={styles.summaryBox}>
              {(intent.summary.lines || []).map(([label, value], idx) => (
                <KeyValueRow key={`${label}-${idx}`} label={label} value={value} />
              ))}
            </View>

            {intent.summary.rows && intent.summary.rows.length > 0 ? (
              <View style={styles.payrollPreview}>
                <Text style={styles.subLabel}>
                  Recipients ({intent.summary.rows.length})
                </Text>
                {intent.summary.rows.slice(0, 8).map((r, i) => (
                  <Text key={i} style={styles.payrollRow}>
                    • {r.name || "Recipient"} — {r.amount ?? ""} {r.currency || ""}
                  </Text>
                ))}
                {intent.summary.rows.length > 8 ? (
                  <Text style={styles.payrollMore}>
                    +{intent.summary.rows.length - 8} more recipients
                  </Text>
                ) : null}
              </View>
            ) : null}

            {requiresPin ? (
              <Input
                label={isPinChange ? "Current 4-digit PIN" : "4-digit Wallet PIN"}
                placeholder="••••"
                value={pin}
                onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
              />
            ) : null}

            {isPinChange ? (
              <Input
                label="New 4-digit PIN"
                placeholder="••••"
                value={newPin}
                onChangeText={(t) => setNewPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
              />
            ) : null}

            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </ScrollView>

          <View style={styles.footer}>
            <Button
              title="Approve with Passkey"
              onPress={handleApprove}
              loading={submitting}
            />
            <Button
              title="Cancel"
              variant="ghost"
              disabled={submitting}
              onPress={() => dismissApproval()}
              style={{ marginTop: 6 }}
            />
          </View>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

const styles = StyleSheet.create({
  successTop: {
    alignItems: "center",
    gap: 6,
    paddingTop: 8,
    paddingBottom: 18,
  },
  successRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: "#D6F2E3",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  successDot: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.brandGreen,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: COLORS.success,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  successHeading: {
    ...TYPE.display,
    color: COLORS.text,
    textAlign: "center",
  },
  successTitle: {
    ...TYPE.body,
    color: COLORS.textSecondary,
    textAlign: "center",
  },
  successNotice: {
    ...TYPE.label,
    color: COLORS.successText,
    textAlign: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,20,15,0.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: SPACING.lg,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: "88%",
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderStrong,
    alignSelf: "center",
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  kicker: {
    color: COLORS.primary,
    fontSize: 11,
    fontFamily: FONTS.bold,
    letterSpacing: 0.9,
  },
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontFamily: FONTS.bold,
    marginTop: 2,
  },
  body: {
    marginBottom: 14,
  },
  summaryBox: {
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: 14,
  },
  payrollPreview: {
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 14,
  },
  subLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: FONTS.bold,
    marginBottom: 6,
  },
  payrollRow: {
    color: COLORS.text,
    fontFamily: FONTS.regular, fontSize: 12,
    lineHeight: 18,
  },
  payrollMore: {
    color: COLORS.textMuted,
    fontFamily: FONTS.regular, fontSize: 12,
    marginTop: 4,
  },
  footer: {
    paddingTop: 4,
  },
});
