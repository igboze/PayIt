import React, { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING, FONTS, TABULAR_NUMS, createThemeStyles } from "../theme";
import { formatUsdc } from "./UI";
import { PressableScale } from "./Touch";
import { toUserError } from "../utils/errors";

export function AccountSwitcherBar({ onOpenAssistant }: { onOpenAssistant?: () => void }) {
  const {
    user,
    activeAccount,
    otherAccountBalanceUsdc,
    switchingAccount,
    switchAccount,
    requestApproval,
    balanceHidden,
  } = useApp();
  const [busySetup, setBusySetup] = useState(false);

  if (!user) return null;

  const isBiz = activeAccount === "business";

  const handleToggle = async (target: "personal" | "business") => {
    if (target === activeAccount || switchingAccount || busySetup) return;
    if (target === "business" && !user.hasBusinessAccount) {
      Alert.alert(
        "Create Business Account",
        "Set up a dedicated Business balance separated from your Personal account?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Create Business Account",
            onPress: async () => {
              setBusySetup(true);
              try {
                await requestApproval("business.setup", {});
                await switchAccount("business");
              } catch (err) {
                const msg = toUserError(err, "Could not set up business account.");
                if (!/cancel/i.test(msg)) Alert.alert("Business Setup", msg);
              } finally {
                setBusySetup(false);
              }
            },
          },
        ]
      );
      return;
    }
    try {
      await switchAccount(target);
    } catch (err) {
      Alert.alert("Account Switch", toUserError(err, "Could not switch account."));
    }
  };

  return (
    <View style={styles.bar}>
      <View style={styles.segment}>
        <PressableScale
          onPress={() => handleToggle("personal")}
          style={[styles.segBtn, !isBiz && styles.segPersonalActive]}
        >
          <Ionicons
            name="person"
            size={13}
            color={!isBiz ? COLORS.primary : COLORS.textSecondary}
          />
          <Text style={[styles.segText, !isBiz && { color: COLORS.primary }]}>Personal</Text>
        </PressableScale>

        <PressableScale
          onPress={() => handleToggle("business")}
          style={[styles.segBtn, isBiz && styles.segBizActive]}
        >
          <Ionicons
            name="briefcase"
            size={13}
            color={isBiz ? COLORS.business : COLORS.textSecondary}
          />
          <Text style={[styles.segText, isBiz && { color: COLORS.business }]}>
            {user.hasBusinessAccount ? "Business" : "+ Business"}
          </Text>
        </PressableScale>
      </View>

      <View style={styles.right}>
        {switchingAccount || busySetup ? (
          <ActivityIndicator size="small" color={isBiz ? COLORS.business : COLORS.primary} />
        ) : otherAccountBalanceUsdc !== null ? (
          <PressableScale
            onPress={() => handleToggle(isBiz ? "personal" : "business")}
            style={styles.otherPill}
          >
            <Text style={styles.otherText}>
              {isBiz ? "Personal" : "Business"}: {balanceHidden ? "••••" : formatUsdc(otherAccountBalanceUsdc)}
            </Text>
          </PressableScale>
        ) : null}

        {onOpenAssistant ? (
          <PressableScale onPress={onOpenAssistant} style={styles.aiBtn} hitSlop={8}>
            <Ionicons name="sparkles" size={16} color={COLORS.primary} />
          </PressableScale>
        ) : null}
      </View>
    </View>
  );
}

const styles = createThemeStyles(() => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
    backgroundColor: COLORS.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 3,
    gap: 4,
  },
  segBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
  },
  segPersonalActive: {
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
  },
  segBizActive: {
    backgroundColor: COLORS.businessMuted,
    borderWidth: 1,
    borderColor: COLORS.businessBorder,
  },
  segText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: FONTS.bold,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  otherPill: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  otherText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontFamily: FONTS.semibold,
    ...TABULAR_NUMS,
  },
  aiBtn: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    alignItems: "center",
    justifyContent: "center",
  },
}));
