// Activity: transaction rows grouped by day, payout status, and the details sheet with a
// downloadable receipt (the same PNG receipt the Telegram bot sends).
import React, { useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import type { AccountType, TransactionItem } from "../api/types";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE } from "../theme";
import { Button, ErrorBanner, formatRawTxAmount, KeyValueRow, shortAddr } from "./UI";
import { PressableScale, notifyHaptic } from "./Touch";
import { getLegacyFileSystem, getSharing } from "../nativeModules";

type IoniconName = keyof typeof Ionicons.glyphMap;

const TONES = {
  green: ["#047857", "rgba(16, 185, 129, 0.14)"],
  neutral: ["#3F4A45", "rgba(14, 21, 18, 0.06)"],
  violet: ["#6D28D9", "rgba(139, 92, 246, 0.12)"],
  amber: ["#B45309", "rgba(245, 158, 11, 0.14)"],
  teal: ["#0F766E", "rgba(20, 184, 166, 0.14)"],
  blue: ["#1D4ED8", "rgba(59, 130, 246, 0.12)"],
} as const;

export function isCreditTx(tx: TransactionItem): boolean {
  return /receive|deposit|onramp|claim|refund|credit|liquidate|unload/i.test(tx.type) && !/auto_earn_deposit/i.test(tx.type);
}

export function txKindLabel(rawType: string): string {
  const t = String(rawType || "").toLowerCase();
  if (t === "auto_earn_deposit") return "Moved to savings";
  if (t === "auto_earn_liquidate") return "From savings";
  if (t === "scheduled_transfer") return "Scheduled payment";
  if (/offramp|payout|cashout/.test(t)) return "Bank transfer";
  if (/withdraw/.test(t)) return "Sent to wallet";
  if (/deposit|onramp|receive|credit|claim/.test(t)) return "Money in";
  if (/refund/.test(t)) return "Refund";
  if (/bill/.test(t)) return "Bill payment";
  if (/card/.test(t)) return "Card";
  if (/swap/.test(t)) return "Swap";
  if (/saving|yield/.test(t)) return "Savings";
  if (/transfer|p2p|send/.test(t)) return "Sent";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Transaction";
}

function txVisual(tx: TransactionItem): { icon: IoniconName; tone: keyof typeof TONES } {
  const t = String(tx.type || "").toLowerCase();
  if (/saving|yield|auto_earn/.test(t)) return { icon: "server-outline", tone: "teal" };
  if (isCreditTx(tx)) return { icon: "arrow-down", tone: "green" };
  if (/bill/.test(t)) return { icon: "receipt-outline", tone: "amber" };
  if (/card/.test(t)) return { icon: "card-outline", tone: "violet" };
  if (/offramp|payout/.test(t)) return { icon: "business-outline", tone: "blue" };
  if (/swap/.test(t)) return { icon: "swap-horizontal", tone: "teal" };
  return { icon: "arrow-up", tone: "neutral" };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function txTitle(tx: TransactionItem): string {
  if (tx.counterparty?.name) return titleCase(tx.counterparty.name);
  return tx.narration || txKindLabel(tx.type);
}

function parseDate(raw?: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeOf(raw?: string | null): string {
  const d = parseDate(raw);
  return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
}

export function dayLabel(raw?: string | null): string {
  const d = parseDate(raw);
  if (!d) return "Earlier";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function groupByDay(txs: TransactionItem[]): Array<{ title: string; data: TransactionItem[] }> {
  const out: Array<{ title: string; data: TransactionItem[] }> = [];
  for (const tx of txs) {
    const label = dayLabel(tx.createdAt);
    const last = out[out.length - 1];
    if (last && last.title === label) last.data.push(tx);
    else out.push({ title: label, data: [tx] });
  }
  return out;
}

type Status = { label: string; color: string; bg: string };
export function txStatus(tx: TransactionItem): Status | null {
  if (tx.payoutStatus === "paid") return { label: "Paid", color: COLORS.successText, bg: COLORS.primaryMuted };
  if (tx.payoutStatus === "failed") return { label: "Failed", color: COLORS.dangerText, bg: COLORS.dangerMuted };
  if (tx.payoutStatus === "processing") return { label: "Processing", color: COLORS.warningText, bg: COLORS.businessMuted };
  const s = String(tx.status || "").toLowerCase();
  if (/fail|reject|error|cancel/.test(s)) return { label: "Failed", color: COLORS.dangerText, bg: COLORS.dangerMuted };
  if (/pending|submitted|processing|initiated/.test(s)) return { label: "Processing", color: COLORS.warningText, bg: COLORS.businessMuted };
  return null; // completed: no chip
}

function StatusChip({ status }: { status: Status }) {
  return (
    <View style={[styles.chip, { backgroundColor: status.bg }]}>
      <Text style={[styles.chipText, { color: status.color }]}>{status.label}</Text>
    </View>
  );
}

export function TxRow({ tx, onPress }: { tx: TransactionItem; onPress: () => void }) {
  const credit = isCreditTx(tx);
  const vis = txVisual(tx);
  const [fg, bg] = TONES[vis.tone];
  const status = txStatus(tx);
  const sub = [timeOf(tx.createdAt), tx.counterparty?.detail || (tx.counterparty?.name || tx.narration ? txKindLabel(tx.type) : null)]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressableScale onPress={onPress} depth={0.98} style={styles.row}>
      <View style={[styles.tile, { backgroundColor: bg }]}>
        <Ionicons name={vis.icon} size={22} color={fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={styles.title} numberOfLines={1}>
          {txTitle(tx)}
        </Text>
        <View style={styles.subRow}>
          {status ? <StatusChip status={status} /> : null}
          <Text style={styles.sub} numberOfLines={1}>
            {sub}
          </Text>
        </View>
      </View>
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <Text style={[styles.amount, credit && { color: COLORS.successText }]}>
          {credit ? "+" : "−"}
          {formatRawTxAmount(tx.amount, tx.decimals)}
        </Text>
        {tx.fiatAmount ? <Text style={styles.sub}>₦{Math.round(tx.fiatAmount).toLocaleString("en-NG")}</Text> : null}
      </View>
    </PressableScale>
  );
}


export function TxDetailSheet({
  tx,
  activeAccount,
  onClose,
}: {
  tx: TransactionItem | null;
  activeAccount: AccountType;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = getAccessToken();

  if (!tx) return null;
  const status = txStatus(tx);
  const credit = isCreditTx(tx);

  const saveReceipt = async () => {
    setError(null);
    setSaving(true);
    try {
      let shared = false;
      const Sharing = getSharing();
      const LegacyFS = getLegacyFileSystem();
      if (Sharing && LegacyFS && token && (await Sharing.isAvailableAsync().catch(() => false))) {
        try {
          const target = `${LegacyFS.cacheDirectory}proxim-receipt-${tx.id}.png`;
          const res = await LegacyFS.downloadAsync(api.getReceiptUrl(tx.id), target, {
            headers: { Authorization: `Bearer ${token}`, "X-Proxim-Account": activeAccount },
          });
          if (res.status !== 200) throw new Error("download failed");
          await Sharing.shareAsync(res.uri, { mimeType: "image/png", dialogTitle: "Save or share receipt", UTI: "public.png" });
          shared = true;
        } catch (_) {
          shared = false;
        }
      }
      if (!shared) {
        // Opens the PNG in the browser, where it can be saved or shared.
        const link = await api.getReceiptLink(tx.id);
        await Linking.openURL(link);
      }
      notifyHaptic("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get the receipt.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text style={styles.headAmount}>
              {credit ? "+" : "−"}
              {formatRawTxAmount(tx.amount, tx.decimals)}
            </Text>
            {tx.fiatAmount ? <Text style={styles.headSub}>₦{Math.round(tx.fiatAmount).toLocaleString("en-NG")}</Text> : null}
            <Text style={styles.headTitle}>{txTitle(tx)}</Text>
            {status ? <StatusChip status={status} /> : null}
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <KeyValueRow label="Type" value={txKindLabel(tx.type)} />
            {tx.counterparty?.detail ? <KeyValueRow currency={false} label="To" value={tx.counterparty.detail} /> : null}
            {tx.payoutStatus ? (
              <KeyValueRow
                label="Payout"
                value={tx.payoutStatus === "paid" ? "Paid to the bank" : tx.payoutStatus === "failed" ? "Didn't go through" : "On its way to the bank"}
              />
            ) : null}
            {tx.narration ? <KeyValueRow currency={false} label="Note" value={tx.narration} /> : null}
            <KeyValueRow label="Date" value={`${dayLabel(tx.createdAt)}, ${timeOf(tx.createdAt)}`} />
            <KeyValueRow label="Account" value={tx.accountType === "business" ? "Business" : "Personal"} />
            {tx.txHash ? <KeyValueRow currency={false} label="Reference" value={shortAddr(tx.txHash, 10, 8)} /> : null}

            {preview && token ? (
              <View style={styles.receiptBox}>
                <Image
                  source={{ uri: api.getReceiptUrl(tx.id), headers: { Authorization: `Bearer ${token}`, "X-Proxim-Account": activeAccount } }}
                  style={styles.receiptImg}
                  resizeMode="contain"
                />
              </View>
            ) : null}
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </ScrollView>
          <View style={styles.actions}>
            <Button title="Save or share receipt" onPress={saveReceipt} loading={saving} />
            {!preview ? <Button title="View receipt" variant="secondary" onPress={() => setPreview(true)} /> : null}
            <Button title="Close" variant="ghost" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <View style={{ gap: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <View style={[styles.tile, { backgroundColor: COLORS.surfaceElevated }]} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[styles.bone, { width: "55%" }]} />
            <View style={[styles.bone, { width: "35%", height: 10 }]} />
          </View>
          <View style={[styles.bone, { width: 56 }]} />
        </View>
      ))}
      <ActivityIndicator color={COLORS.primary} style={{ marginTop: 6 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  tile: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  title: { ...TYPE.bodyStrong, color: COLORS.text },
  subRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  sub: { ...TYPE.label, color: COLORS.textSecondary, flexShrink: 1 },
  amount: { ...TYPE.bodyStrong, color: COLORS.text },
  chip: { borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 2 },
  chipText: { ...TYPE.label, fontSize: 12, lineHeight: 16 },
  bone: { height: 12, borderRadius: 6, backgroundColor: COLORS.surfaceElevated },
  backdrop: { flex: 1, backgroundColor: "rgba(14, 21, 18, 0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    padding: SPACING.lg,
    paddingTop: 10,
    maxHeight: "90%",
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.borderStrong, marginBottom: 14 },
  head: { alignItems: "center", gap: 4, marginBottom: 12 },
  headAmount: { ...TYPE.display, color: COLORS.text },
  headSub: { ...TYPE.bodyStrong, color: COLORS.textSecondary },
  headTitle: { ...TYPE.body, color: COLORS.textSecondary, textAlign: "center" },
  receiptBox: { marginTop: 14, borderRadius: RADIUS.md, overflow: "hidden", backgroundColor: COLORS.page },
  receiptImg: { width: "100%", height: 380 },
  actions: { gap: 8, marginTop: 12 },
});
