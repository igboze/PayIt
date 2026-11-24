import React, { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import { assertPasskey } from "../api/passkey";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING } from "../theme";
import { Button, ErrorBanner, Input, KeyValueRow } from "./UI";

export function ApprovalSheet() {
  const { pendingApproval, dismissApproval, completeApproval } = useApp();
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPin("");
    setNewPin("");
    setError(null);
    setSubmitting(false);
  }, [pendingApproval?.intent.challengeId]);

  if (!pendingApproval) return null;

  const { intent, extraConfirmFields } = pendingApproval;
  const requiresPin = intent.requiresPin;
  const isPinChange = intent.actionType === "pin.change";

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
      completeApproval(res);
    } catch (err) {
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
      <View style={styles.backdrop}>
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
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
    fontWeight: "700",
    letterSpacing: 0.9,
  },
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 2,
  },
  body: {
    marginBottom: 14,
  },
  summaryBox: {
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: 14,
  },
  payrollPreview: {
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 14,
  },
  subLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  payrollRow: {
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 18,
  },
  payrollMore: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  footer: {
    paddingTop: 4,
  },
});
