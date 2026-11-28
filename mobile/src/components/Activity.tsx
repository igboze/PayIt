// Activity: transaction rows grouped by day, payout status, and the details sheet with a
// downloadable receipt (the same PNG receipt the Telegram bot sends).
import React, { useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import type { AccountType, TransactionItem } from "../api/types";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE, createThemeStyles } from "../theme";
import { Button, ErrorBanner, formatRawTxAmount, KeyValueRow, shortAddr } from "./UI";
import { PressableScale, notifyHaptic } from "./Touch";
import { getLegacyFileSystem, getSharing } from "../nativeModules";
import { useApp } from "../state/AppContext";

type IoniconName = keyof typeof Ionicons.glyphMap;

type ToneKey = "green" | "neutral" | "violet" | "amber" | "teal" | "blue";

function toneColors(tone: ToneKey): readonly [string, string] {
  switch (tone) {
    case "green":
      return [COLORS.successText, COLORS.primaryMuted];
    case "neutral":
      return [COLORS.text, COLORS.surfaceElevated];
    case "violet":
      return [COLORS.primary, COLORS.goldSoft];
    case "amber":
      return [COLORS.goldDark, COLORS.goldSoft];
    case "teal":
      return [COLORS.gold, COLORS.forest];
    case "blue":
      return [COLORS.text, COLORS.surfaceElevated];
  }
}

export function isCreditTx(tx: TransactionItem): boolean {
  return /receive|deposit|onramp|claim|refund|credit|liquidate|unload|yield_withdraw|stock_sell/i.test(tx.type) && !/auto_earn_deposit|savings_deposit/i.test(tx.type);
}

const FIAT_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  GBP: "£",
  EUR: "€",
  USD: "$",
  CAD: "CA$",
  AUD: "A$",
  KES: "KSh ",
  GHS: "GH₵",
  ZAR: "R",
  TZS: "TSh ",
  AED: "AED ",
  MXN: "MX$",
  UGX: "USh ",
};

export function formatCurrencyAmount(amount: number, currency?: string | null): string {
  const cur = String(currency || "NGN").toUpperCase();
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return "—";
  if (cur === "NGN") return `₦${Math.round(n).toLocaleString("en-NG")}`;
  const sym = FIAT_SYMBOLS[cur];
  const formatted = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym ? `${sym}${formatted}` : `${formatted} ${cur}`;
}

function formatRawExactCrypto(raw: string, decimals = 18): string {
  const s = String(raw || "").trim();
  if (!s) return "0.00";
  let n = NaN;
  if (/^\d+$/.test(s) && decimals > 0) {
    const padded = s.padStart(decimals + 1, "0");
    const whole = padded.slice(0, padded.length - decimals);
    const frac = padded.slice(padded.length - decimals, padded.length - decimals + 6).replace(/0+$/, "");
    n = Number(`${whole}.${frac || "0"}`);
  } else {
    n = Number(s);
  }
  if (!Number.isFinite(n)) return "0.00";
  return Number(n.toFixed(6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * Primary + secondary display amount for a transaction row / detail sheet:
 * - Naira deposits (Paj / Global Neobank NGN): Primary in Naira (+₦...), secondary USD equivalent.
 * - International deposits (Global Neobank GBP/EUR/USD/CAD/KES/etc.): Primary in source currency (+£... / +€...).
 * - Crypto deposits & crypto sends: Primary in exact USDC (+10.1234 USDC / −40.00 USDC).
 * - Everything else: USD primary with optional Naira secondary for NGN bank payouts.
 */
export function getTxDisplayAmounts(tx: TransactionItem): { primary: string; secondary: string | null } {
  const credit = isCreditTx(tx);
  const sign = credit ? "+" : "−";
  const usdStr = formatRawTxAmount(tx.amount, tx.decimals);
  const typeLower = String(tx.type || "").toLowerCase();
  const channel = tx.depositChannel || null;

  if (credit) {
    const isNairaDeposit =
      channel === "naira" ||
      (/deposit_naira|onramp/.test(typeLower) && (tx.fiatCurrency === "NGN" || tx.fiatAmount != null));
    if (isNairaDeposit && tx.fiatAmount != null && tx.fiatAmount > 0) {
      return {
        primary: `${sign}${formatCurrencyAmount(tx.fiatAmount, "NGN")}`,
        secondary: `≈ ${usdStr}`,
      };
    }

    const isIntlDeposit =
      channel === "international" ||
      (typeLower === "deposit_fiat" && tx.fiatCurrency && tx.fiatCurrency !== "NGN");
    if (isIntlDeposit && tx.fiatCurrency) {
      const cur = tx.fiatCurrency.toUpperCase();
      if (tx.fiatAmount != null && tx.fiatAmount > 0) {
        return {
          primary: `${sign}${formatCurrencyAmount(tx.fiatAmount, cur)}`,
          secondary: cur === "USD" ? null : `≈ ${usdStr}`,
        };
      }
      return { primary: `${sign}${usdStr} ${cur}`, secondary: null };
    }

    const isCryptoDeposit =
      channel === "crypto" ||
      /deposit_crypto|deposit_crosschain|crypto_deposit|near_deposit|evm_sweep|cctp|^deposit$/.test(typeLower);
    if (isCryptoDeposit) {
      return {
        primary: `${sign}${formatRawExactCrypto(tx.amount, tx.decimals)} USDC`,
        secondary: null,
      };
    }
  } else {
    const isCryptoSend = /crosschain_withdraw|intent_withdraw|send_usdc|send_eurc|^transfer$|move_funds/.test(typeLower);
    if (isCryptoSend) {
      const token = typeLower === "send_eurc" ? "EURC" : "USDC";
      return {
        primary: `${sign}${formatRawExactCrypto(tx.amount, tx.decimals)} ${token}`,
        secondary: null,
      };
    }
  }

  return {
    primary: `${sign}${usdStr}`,
    secondary: tx.fiatAmount ? formatCurrencyAmount(tx.fiatAmount, tx.fiatCurrency || "NGN") : null,
  };
}

export function txKindLabel(rawType: string, tx?: TransactionItem): string {
  const t = String(rawType || "").toLowerCase();
  if (t === "auto_earn_deposit") return "Moved to savings";
  if (t === "auto_earn_liquidate" || t === "yield_withdraw") return "From savings";
  if (t === "savings_deposit") return "Savings deposit";
  if (t === "stock_buy") return "Stock purchase";
  if (t === "stock_sell") return "Stock sale";
  if (t === "scheduled_transfer") return "Scheduled payment";
  if (/offramp|payout|cashout/.test(t)) return "Bank transfer";
  if (/withdraw/.test(t)) return "Sent to wallet";
  if (tx?.depositChannel === "naira" || /deposit_naira|onramp/.test(t)) return "Naira deposit";
  if (tx?.depositChannel === "international" || t === "deposit_fiat") {
    return tx?.fiatCurrency ? `International deposit · ${tx.fiatCurrency.toUpperCase()}` : "International deposit";
  }
  if (tx?.depositChannel === "crypto" || /deposit_crypto|near_deposit|evm_sweep/.test(t)) return "Crypto deposit";
  if (/deposit|receive|credit|claim/.test(t)) return "Money in";
  if (/refund/.test(t)) return "Refund";
  if (/bill/.test(t)) return "Bill payment";
  if (/card/.test(t)) return "Card";
  if (/swap/.test(t)) return "Swap";
  if (/saving|yield/.test(t)) return "Savings";
  if (/transfer|p2p|send/.test(t)) return "Sent";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Transaction";
}

function txVisual(tx: TransactionItem): { icon: IoniconName; tone: ToneKey } {
  const t = String(tx.type || "").toLowerCase();
  if (/stock_buy|stock_sell/.test(t)) return { icon: "trending-up-outline", tone: "blue" };
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
  return tx.narration || txKindLabel(tx.type, tx);
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
  const { balanceHidden } = useApp();
  const credit = isCreditTx(tx);
  const vis = txVisual(tx);
  const [fg, bg] = toneColors(vis.tone);
  const status = txStatus(tx);
  const display = getTxDisplayAmounts(tx);
  const kind = txKindLabel(tx.type, tx);
  const sub = [timeOf(tx.createdAt), tx.counterparty?.detail || (tx.counterparty?.name || tx.narration ? kind : null)]
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
        <Text style={[styles.amount, credit && !balanceHidden && { color: COLORS.successText }]}>
          {balanceHidden ? "••••" : display.primary}
        </Text>
        {!balanceHidden && display.secondary ? <Text style={styles.sub}>{display.secondary}</Text> : null}
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
  const display = getTxDisplayAmounts(tx);

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
            <Text style={styles.headAmount}>{display.primary}</Text>
            {display.secondary ? <Text style={styles.headSub}>{display.secondary}</Text> : null}
            <Text style={styles.headTitle}>{txTitle(tx)}</Text>
            {status ? <StatusChip status={status} /> : null}
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <KeyValueRow label="Type" value={txKindLabel(tx.type, tx)} />
            {tx.counterparty?.name ? <KeyValueRow currency={false} label={isCreditTx(tx) ? "From" : "Recipient"} value={titleCase(tx.counterparty.name)} /> : null}
            {tx.counterparty?.detail ? <KeyValueRow currency={false} label={isCreditTx(tx) ? "Sender Bank / Account" : "Destination"} value={tx.counterparty.detail} /> : null}
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

const styles = createThemeStyles(() => ({
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
  backdrop: { flex: 1, backgroundColor: "rgba(0, 20, 15, 0.55)", justifyContent: "flex-end" },
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
}));
