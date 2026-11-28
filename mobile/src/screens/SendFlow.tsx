// Send money, recipient first (Proxim design canvas: Payout / SendUser / Contacts):
//   1. Pick who: a saved recipient, a new bank account (name checked as you type) or a Proxim user.
//   2. Enter the amount on a keypad, in naira, with the dollar cost shown live.
//   3. Review and approve in the passkey sheet, which ends on the success page.
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type { BankItem, ContactItem, ResolvedBankAccount } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TYPE } from "../theme";
import { Button, ErrorBanner, formatUsdc, ScreenHeader } from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale, tap } from "../components/Touch";

type Tab = "bank" | "user";
export type MoreSendMode = "global" | "wallet" | "gift";

type Recipient =
  | { kind: "bank"; name: string; bankCode: string; bankName: string; accountNumber: string }
  | { kind: "user"; name: string; handle: string; query: string };

// Initials avatars use solid brand pairs only (text, fill).
const AVATAR_TONES = [
  ["#FFFFFF", "#002018"],
  ["#FFFFFF", "#007F4F"],
  ["#FFFFFF", "#0F172A"],
  ["#002018", "#DFF2E8"],
  ["#002018", "#E6EEEA"],
] as const;

function initials(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const txt = initials(name);
  const [fg, bg] = AVATAR_TONES[[...txt].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ ...TYPE.bodyStrong, color: fg }}>{txt}</Text>
    </View>
  );
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const fmtNgn = (n: number) => {
  const safe = Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
  const hasKobo = Math.round(safe * 100) % 100 !== 0;
  return `₦${safe.toLocaleString("en-NG", {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

const fmtTypedNgn = (raw: string) => {
  if (!raw) return "₦0";
  const hasDot = raw.includes(".");
  const [intRaw, decRaw = ""] = raw.split(".");
  const intNum = Number(intRaw || "0");
  const intFormatted = Number.isFinite(intNum) ? intNum.toLocaleString("en-NG") : "0";
  return hasDot ? `₦${intFormatted}.${decRaw}` : `₦${intFormatted}`;
};

export function SendFlow({
  onBack,
  onMore,
  initialTab = "bank",
}: {
  onBack: () => void;
  onMore: (mode: MoreSendMode) => void;
  initialTab?: Tab;
}) {
  const { activeAccount, requestApproval, dataVersion, balanceHidden } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [step, setStep] = useState<"recipient" | "amount">("recipient");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Shared data
  const [rate, setRate] = useState<number | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const [heldNgn, setHeldNgn] = useState<number>(0);
  const [contacts, setContacts] = useState<ContactItem[]>([]);

  useEffect(() => {
    api.getBankRates().then((r) => setRate(r.offRampRate || r.onRampRate || null)).catch(() => { });
    api.listContacts().then((r) => setContacts(r.contacts || [])).catch(() => { });
  }, []);
  useEffect(() => {
    api
      .getBalances(activeAccount)
      .then((b) => {
        setBalanceUsd(Number(b.totalUsdc ?? 0));
        const ngnPocket = (b.fiatBalances || []).find((f) => f.currency === "NGN");
        setHeldNgn(Number(ngnPocket?.available ?? 0));
      })
      .catch(() => { });
  }, [activeAccount, dataVersion]);

  const savedBank = useMemo(() => contacts.filter((c) => c.accountNumber && /^\d{10}$/.test(c.accountNumber)), [contacts]);

  // ── Bank: new account ─────────────────────────────────────────────────────
  const [bankPickerOpen, setBankPickerOpen] = useState(false);
  const [bank, setBank] = useState<BankItem | null>(null);
  const [acct, setAcct] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<ResolvedBankAccount | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    setResolved(null);
    setResolveError(null);
    if (!bank || !/^\d{10}$/.test(acct)) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setResolving(true);
      try {
        const res = await api.resolveBankAccount(bank.code, acct, bank.name);
        if (!cancelled) {
          setResolved(res);
          tap("selection");
        }
      } catch (err) {
        if (!cancelled) setResolveError(err instanceof Error ? err.message : "Couldn't check that account.");
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bank?.code, acct]);

  const chooseSavedBank = async (c: ContactItem) => {
    setError(null);
    try {
      const found = await api.listBanks(c.bankName || undefined);
      const match = (found.banks || []).find((b) => b.name.toLowerCase() === String(c.bankName || "").toLowerCase()) || found.banks?.[0];
      if (!match) throw new Error("We couldn't find that bank. Add the account again.");
      setRecipient({
        kind: "bank",
        name: c.accountName || c.name,
        bankCode: match.code,
        bankName: match.name,
        accountNumber: String(c.accountNumber),
      });
      setStep("amount");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that recipient.");
    }
  };

  const continueWithNewBank = () => {
    if (!bank || !resolved) return;
    setRecipient({
      kind: "bank",
      name: resolved.accountName,
      bankCode: bank.code,
      bankName: resolved.bankName || bank.name,
      accountNumber: acct,
    });
    setStep("amount");
  };

  // ── Proxim user ───────────────────────────────────────────────────────────
  const [userQuery, setUserQuery] = useState("");
  const [userLooking, setUserLooking] = useState(false);
  const [userFound, setUserFound] = useState<{ displayName: string; username: string | null; isSelf: boolean } | null>(null);
  const [userMissing, setUserMissing] = useState(false);

  useEffect(() => {
    setUserFound(null);
    setUserMissing(false);
    const q = userQuery.trim();
    if (q.replace(/^[@+]/, "").length < 3) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setUserLooking(true);
      try {
        const res = await api.lookupUser(q);
        if (!cancelled) setUserFound(res.user);
      } catch {
        if (!cancelled) setUserMissing(true);
      } finally {
        if (!cancelled) setUserLooking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [userQuery]);

  const chooseUser = () => {
    if (!userFound || userFound.isSelf) return;
    const handle = userFound.username ? `@${userFound.username}` : userQuery.trim();
    setRecipient({
      kind: "user",
      name: userFound.displayName || handle,
      handle,
      query: handle,
    });
    setStep("amount");
  };

  // ── Amount ────────────────────────────────────────────────────────────────
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const calcTieredNgnFee = (ngn: number): number => {
    if (ngn <= 0) return 0;
    const pct = Math.round(ngn * 0.01 * 100) / 100;
    return ngn < 100000 ? Math.min(pct, 500) : pct;
  };

  const calcMaxSendableNgn = (availNgn: number): number => {
    const availKobo = Math.floor(Math.max(0, availNgn) * 100);
    if (availKobo <= 0) return 0;
    let lo = 0;
    let hi = availKobo;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const midMajor = mid / 100;
      const feeKobo = Math.round(calcTieredNgnFee(midMajor) * 100);
      if (mid + feeKobo <= availKobo) lo = mid;
      else hi = mid - 1;
    }
    return Number((lo / 100).toFixed(2));
  };

  const amountNgn = Number((Number(amount || 0) || 0).toFixed(2));
  const usdCost = rate ? amountNgn / rate : null;
  const isBankSend = recipient?.kind === "bank";
  const usingHeldNgn = isBankSend && heldNgn > 0 && (heldNgn >= amountNgn + calcTieredNgnFee(amountNgn) || (balanceUsd ?? 0) < 1);
  const heldNgnFee = usingHeldNgn ? calcTieredNgnFee(amountNgn) : 0;
  const heldNgnTotal = usingHeldNgn ? Number((amountNgn + heldNgnFee).toFixed(2)) : 0;
  const bankFeeUsd = isBankSend && !usingHeldNgn && usdCost !== null ? Number((usdCost * 0.01).toFixed(4)) : 0;
  const totalUsdDebit = usdCost !== null ? usdCost + bankFeeUsd : null;
  const minNgn = recipient?.kind === "user" ? 100 : 500;
  const maxSendableNgn = usingHeldNgn
    ? calcMaxSendableNgn(heldNgn)
    : balanceUsd !== null && rate
      ? Math.floor(((isBankSend ? balanceUsd / 1.01 : balanceUsd) * rate) * 100) / 100
      : 0;
  const overBalance = usingHeldNgn
    ? heldNgnTotal > heldNgn + 0.005
    : totalUsdDebit !== null && balanceUsd !== null && totalUsdDebit > balanceUsd + 1e-9;

  const pressKey = (k: string) => {
    tap("light");
    setError(null);
    setAmount((cur) => {
      if (k === "del") return cur.slice(0, -1);
      if (k === ".") {
        if (cur.includes(".")) return cur;
        return cur ? `${cur}.` : "0.";
      }
      if (cur.includes(".")) {
        const [intPart, decPart = ""] = cur.split(".");
        if (decPart.length >= 2) return cur; // max 2 decimal places (kobo)
        return `${intPart}.${decPart}${k}`;
      }
      if (cur === "0") return k;
      if (cur.length >= 8) return cur; // up to ₦99,999,999.99
      return cur + k;
    });
  };

  const review = async () => {
    if (!recipient) return;
    if (!(amountNgn >= minNgn)) {
      setError(`Send at least ${fmtNgn(minNgn)}.`);
      return;
    }
    if (overBalance) {
      setError("That's more than your balance.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const exactNgn = Number(amountNgn.toFixed(2));
      if (recipient.kind === "bank") {
        await requestApproval("payout.ngn", {
          accountType: activeAccount,
          amountNgn: exactNgn,
          bankCode: recipient.bankCode,
          bankName: recipient.bankName,
          accountNumber: recipient.accountNumber,
          accountName: recipient.name,
          narration: note.trim() || undefined,
        });
        // Remember the account so it shows up under Saved next time.
        if (!savedBank.some((c) => c.accountNumber === recipient.accountNumber)) {
          api
            .upsertContact({
              name: titleCase(recipient.name),
              bankName: recipient.bankName,
              accountNumber: recipient.accountNumber,
              accountName: recipient.name,
            })
            .catch(() => { });
        }
      } else {
        await requestApproval("transfer.user", {
          accountType: activeAccount,
          recipient: recipient.query,
          amountNgn: exactNgn,
          narration: note.trim() || undefined,
        });
      }
      onBack(); // the approval sheet shows the success page on top
    } catch (err) {
      const msg = err instanceof Error ? err.message : "That didn't go through.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSending(false);
    }
  };

  // Android Back on the amount step goes back to choosing the recipient.
  useEffect(() => {
    if (step !== "amount") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setStep("recipient");
      return true;
    });
    return () => sub.remove();
  }, [step]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (step === "amount" && recipient) {
    const sub =
      recipient.kind === "bank"
        ? `${recipient.bankName} ••${recipient.accountNumber.slice(-2)}`
        : `${recipient.handle} · Proxim`;
    return (
      <View style={styles.root}>
        <ScreenHeader title="Send money" onBack={() => setStep("recipient")} />
        <View style={styles.amountBody}>
          <PressableScale onPress={() => setStep("recipient")} depth={0.98} style={styles.recipientCard}>
            <Avatar name={recipient.name} size={40} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {titleCase(recipient.name)}
              </Text>
              <View style={styles.subRow}>
                {recipient.kind === "bank" ? <CurrencyLogo code="NGN" size={14} /> : null}
                <Text style={styles.rowSub} numberOfLines={1}>
                  {sub}
                </Text>
              </View>
            </View>
            <Text style={styles.link}>Change</Text>
          </PressableScale>

          <View style={{ flex: 1 }} />

          <View style={styles.amountBlock}>
            <Text style={styles.overline}>You send</Text>
            <Text style={[styles.bigAmount, !amount && { color: COLORS.textMuted }]} numberOfLines={1} adjustsFontSizeToFit>
              {fmtTypedNgn(amount)}
            </Text>
            <Text style={[styles.amountHint, overBalance && { color: COLORS.dangerText }]}>
              {amountNgn > 0
                ? usingHeldNgn
                  ? overBalance
                    ? `Need ${fmtNgn(heldNgnTotal)} (incl. ${fmtNgn(heldNgnFee)} fee) · Max sendable ${fmtNgn(maxSendableNgn)}`
                    : `They get ${fmtNgn(amountNgn)} · Fee ${fmtNgn(heldNgnFee)} · Total ${fmtNgn(heldNgnTotal)} (NGN balance)`
                  : usdCost !== null
                    ? isBankSend
                      ? `${formatUsdc(totalUsdDebit ?? usdCost)} total (incl. ${formatUsdc(bankFeeUsd)} 1% fee)${rate ? ` · $1 = ₦${Number(rate).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}`
                      : `${formatUsdc(usdCost)} from your balance (Free)${rate ? ` · $1 = ₦${Number(rate).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}`
                    : " "
                : balanceHidden
                  ? "Balance hidden"
                  : heldNgn > 0 && isBankSend
                    ? `NGN balance ${fmtNgn(heldNgn)} · Max sendable ${fmtNgn(calcMaxSendableNgn(heldNgn))}`
                    : balanceUsd !== null
                      ? `Balance ${formatUsdc(balanceUsd)}${rate ? ` ≈ ${fmtNgn(balanceUsd * rate)}` : ""}`
                      : " "}
            </Text>
          </View>

          <View style={styles.quickRow}>
            {[5000, 10000, 20000, 50000].map((v) => {
              const on = amountNgn === v;
              return (
                <PressableScale
                  key={v}
                  onPress={() => {
                    setAmount(String(v));
                    setError(null);
                  }}
                  haptic="selection"
                  depth={0.94}
                  style={[styles.quick, on && styles.quickOn]}
                >
                  <Text style={[styles.quickText, on && { color: COLORS.primaryDark }]}>{fmtNgn(v).replace(",000", "k")}</Text>
                </PressableScale>
              );
            })}
            {maxSendableNgn >= minNgn ? (
              <PressableScale
                onPress={() => {
                  setAmount(String(maxSendableNgn));
                  setError(null);
                }}
                haptic="selection"
                depth={0.94}
                style={[styles.quick, amountNgn === maxSendableNgn && styles.quickOn]}
              >
                <Text style={[styles.quickText, amountNgn === maxSendableNgn && { color: COLORS.primaryDark }]}>Max</Text>
              </PressableScale>
            ) : null}
          </View>

          <PressableScale
            onPress={() => setNoteOpen(true)}
            haptic="selection"
            depth={0.98}
            style={[styles.noteCard, note.trim() ? styles.noteCardFilled : null]}
            accessibilityRole="button"
            accessibilityLabel={note.trim() ? `Description: ${note.trim()}. Tap to edit` : "Add transfer description"}
          >
            <View style={styles.noteIconBadge}>
              <Ionicons name="document-text-outline" size={18} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.noteCardLabel}>{note.trim() ? "Description" : "Add description (optional)"}</Text>
              <Text style={note.trim() ? styles.noteCardValue : styles.noteCardPlaceholder} numberOfLines={1}>
                {note.trim() || "e.g. Lunch, rent, invoice payment…"}
              </Text>
            </View>
            <Text style={styles.noteActionText}>{note.trim() ? "Edit" : "Add"}</Text>
            <Ionicons name="chevron-forward" size={16} color={COLORS.primaryDark} />
          </PressableScale>

          <Modal visible={noteOpen} transparent animationType="slide" onRequestClose={() => setNoteOpen(false)}>
            <View style={styles.sheetBackdrop}>
              <View style={styles.noteSheet}>
                <View style={styles.sheetHandle} />
                <Text style={styles.sheetTitle}>Transfer description</Text>
                <Text style={styles.noteSheetSub}>
                  Shown on your receipt and sent as the payment narration to {titleCase(recipient.name)}.
                </Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="What is this transfer for?"
                  placeholderTextColor={COLORS.textMuted}
                  maxLength={60}
                  style={styles.noteInput}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => setNoteOpen(false)}
                />
                <View style={styles.notePresets}>
                  {["Food & drinks", "Rent", "Transport", "Family", "Invoice"].map((preset) => (
                    <PressableScale
                      key={preset}
                      onPress={() => setNote(preset)}
                      haptic="selection"
                      style={[styles.notePresetPill, note.trim() === preset && styles.notePresetPillOn]}
                    >
                      <Text style={[styles.notePresetText, note.trim() === preset && styles.notePresetTextOn]}>
                        {preset}
                      </Text>
                    </PressableScale>
                  ))}
                </View>
                <View style={styles.noteSheetActions}>
                  {note.trim() ? (
                    <Button
                      title="Clear"
                      variant="ghost"
                      onPress={() => {
                        setNote("");
                        setNoteOpen(false);
                      }}
                      style={{ flex: 1 }}
                    />
                  ) : null}
                  <Button title="Save description" onPress={() => setNoteOpen(false)} style={{ flex: 2 }} />
                </View>
              </View>
            </View>
          </Modal>

          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          <View style={styles.keypad}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"].map((k) => (
              <PressableScale key={k} onPress={() => pressKey(k)} haptic="none" depth={0.9} style={styles.key} accessibilityLabel={k === "del" ? "Delete" : k === "." ? "Decimal point" : k}>
                {k === "del" ? (
                  <Ionicons name="backspace-outline" size={26} color={COLORS.text} />
                ) : (
                  <Text style={styles.keyText}>{k}</Text>
                )}
              </PressableScale>
            ))}
          </View>

          <Button
            title={amountNgn > 0 ? `Review ${fmtNgn(amountNgn)}` : "Enter an amount"}
            onPress={review}
            loading={sending}
            disabled={!(amountNgn > 0) || overBalance}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title="Send money" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.pickBody} keyboardShouldPersistTaps="handled">
        {savedBank.length ? (
          <View>
            <Text style={styles.overline}>Recent</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
              {savedBank.slice(0, 8).map((c, i) => {
                const nm = titleCase(c.accountName || c.name);
                return (
                  <PressableScale
                    key={`r-${c.accountNumber}-${i}`}
                    onPress={() => chooseSavedBank(c)}
                    depth={0.94}
                    style={styles.recentItem}
                    accessibilityLabel={`Send to ${nm}`}
                  >
                    <Avatar name={nm} size={54} />
                    <Text style={styles.recentName} numberOfLines={1}>
                      {nm.split(" ")[0]}
                    </Text>
                  </PressableScale>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        <View style={styles.segment}>
          {(["bank", "user"] as Tab[]).map((t) => (
            <PressableScale key={t} onPress={() => setTab(t)} haptic="selection" depth={0.97} style={[styles.segItem, tab === t && styles.segItemOn]}>
              <Text style={[styles.segText, tab === t && styles.segTextOn]}>{t === "bank" ? "Bank account" : "Proxim user"}</Text>
            </PressableScale>
          ))}
        </View>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        {tab === "bank" ? (
          <>
            <Text style={styles.overline}>New bank account</Text>
            <View style={styles.formCard}>
              <PressableScale onPress={() => setBankPickerOpen(true)} depth={0.98} style={styles.field}>
                {bank ? <BankLogo bank={bank} /> : <Ionicons name="business-outline" size={20} color={COLORS.textMuted} />}
                <Text style={[styles.fieldText, !bank && { color: COLORS.textMuted }]} numberOfLines={1}>
                  {bank ? bank.name : "Choose bank"}
                </Text>
                <Ionicons name="chevron-down" size={18} color={COLORS.textMuted} />
              </PressableScale>
              <View style={styles.field}>
                <Ionicons name="keypad-outline" size={20} color={COLORS.textMuted} />
                <TextInput
                  value={acct}
                  onChangeText={(t) => setAcct(t.replace(/\D/g, "").slice(0, 10))}
                  placeholder="10-digit account number"
                  placeholderTextColor={COLORS.textMuted}
                  keyboardType="number-pad"
                  maxLength={10}
                  style={styles.fieldInput}
                />
                {resolving ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
              </View>
              {resolved ? (
                <View style={styles.verified}>
                  <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} />
                  <Text style={styles.verifiedText} numberOfLines={1}>
                    {titleCase(resolved.accountName)}
                  </Text>
                </View>
              ) : resolveError ? (
                <Text style={styles.fieldError}>{resolveError}</Text>
              ) : bank && acct.length === 10 && resolving ? (
                <Text style={styles.fieldHint}>Checking the account name…</Text>
              ) : null}
            </View>
            <Button title="Continue" onPress={continueWithNewBank} disabled={!resolved} />

            {savedBank.length ? (
              <>
                <Text style={[styles.overline, { marginTop: 8 }]}>Saved</Text>
                <View style={styles.listCard}>
                  {savedBank.map((c, i) => (
                    <PressableScale key={`${c.accountNumber}-${i}`} onPress={() => chooseSavedBank(c)} depth={0.98} style={styles.listRow}>
                      <Avatar name={c.accountName || c.name} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {titleCase(c.accountName || c.name)}
                        </Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {c.bankName || "Bank"} ••{String(c.accountNumber).slice(-2)}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                    </PressableScale>
                  ))}
                </View>
              </>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.searchField}>
              <Ionicons name="search" size={20} color={COLORS.textMuted} />
              <TextInput
                value={userQuery}
                onChangeText={setUserQuery}
                placeholder="@username or phone number"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.fieldInput}
              />
              {userLooking ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
            </View>
            {userFound ? (
              <View style={styles.listCard}>
                <PressableScale onPress={chooseUser} disabled={userFound.isSelf} depth={0.98} style={styles.listRow}>
                  <Avatar name={userFound.displayName || userFound.username || "?"} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {userFound.displayName}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {userFound.isSelf ? "That's you" : userFound.username ? `@${userFound.username}` : "Proxim user"}
                    </Text>
                  </View>
                  {!userFound.isSelf ? <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} /> : null}
                </PressableScale>
              </View>
            ) : userMissing ? (
              <View style={styles.missing}>
                <Text style={styles.rowSub}>No Proxim user found. Send them a gift link they can claim when they join.</Text>
                <Button title="Send a gift link" variant="secondary" onPress={() => onMore("gift")} />
              </View>
            ) : (
              <Text style={styles.fieldHint}>Sending to another Proxim user is instant and free.</Text>
            )}
          </>
        )}

        <Text style={[styles.overline, { marginTop: 8 }]}>More ways to send</Text>
        <View style={styles.listCard}>
          {(
            [
              ["global", "globe-outline", "Send abroad", "Bank accounts in 27 currencies"],
              ["wallet", "wallet-outline", "Send to a crypto wallet", "Any wallet address"],
              ["gift", "gift-outline", "Gift link", "Anyone can claim it, even before joining"],
            ] as Array<[MoreSendMode, keyof typeof Ionicons.glyphMap, string, string]>
          ).map(([mode, icon, title, sub]) => (
            <PressableScale key={mode} onPress={() => onMore(mode)} depth={0.98} style={styles.listRow}>
              <View style={styles.moreIcon}>
                <Ionicons name={icon} size={20} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{title}</Text>
                <Text style={styles.rowSub}>{sub}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
            </PressableScale>
          ))}
        </View>
      </ScrollView>

      <BankPicker
        visible={bankPickerOpen}
        onClose={() => setBankPickerOpen(false)}
        onPick={(b) => {
          setBank(b);
          setBankPickerOpen(false);
        }}
      />
    </View>
  );
}

function BankLogo({ bank, size = 24 }: { bank: BankItem; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (bank.logo && !failed) {
    return <Image source={{ uri: bank.logo }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: COLORS.surfaceElevated, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontFamily: FONTS.bold, fontSize: size * 0.4, color: COLORS.textSecondary }}>{initials(bank.name)}</Text>
    </View>
  );
}

function BankPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (b: BankItem) => void }) {
  const [q, setQ] = useState("");
  const [banks, setBanks] = useState<BankItem[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .listBanks(q.trim() || undefined)
        .then((r) => setBanks(r.banks || []))
        .catch(() => { })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q, visible]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Choose bank</Text>
          <View style={styles.searchField}>
            <Ionicons name="search" size={20} color={COLORS.textMuted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search GTBank, OPay, Kuda…"
              placeholderTextColor={COLORS.textMuted}
              autoFocus
              style={styles.fieldInput}
            />
            {loading ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
          </View>
          <FlatList
            data={banks}
            keyExtractor={(b) => b.code}
            keyboardShouldPersistTaps="handled"
            style={{ marginTop: 8 }}
            renderItem={({ item }) => (
              <PressableScale onPress={() => onPick(item)} depth={0.98} style={styles.bankRow}>
                <BankLogo bank={item} size={32} />
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
              </PressableScale>
            )}
            ListEmptyComponent={!loading ? <Text style={[styles.fieldHint, { padding: 16 }]}>No bank matches that.</Text> : undefined}
          />
          <Button title="Close" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  pickBody: { padding: SPACING.md, paddingTop: 4, gap: 12, paddingBottom: 32 },
  segment: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceElevated,
  },
  segItem: { flex: 1, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  segItemOn: { backgroundColor: COLORS.surface, ...DEPTH.raised },
  segText: { ...TYPE.label, color: COLORS.textSecondary },
  segTextOn: { color: COLORS.text, fontFamily: FONTS.semibold },
  overline: { ...TYPE.overline, color: COLORS.textMuted },
  recentRow: { gap: 14, paddingTop: 10, paddingBottom: 4, paddingRight: 8 },
  recentItem: { width: 60, alignItems: "center", gap: 6 },
  recentName: { ...TYPE.label, fontSize: 12, color: COLORS.text, fontFamily: FONTS.semibold },
  formCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 6, ...DEPTH.card },
  field: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 12 },
  fieldText: { ...TYPE.bodyStrong, color: COLORS.text, flex: 1 },
  fieldInput: { flex: 1, fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text, paddingVertical: 12 },
  verified: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 6,
    marginTop: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.primaryMuted,
  },
  verifiedText: { ...TYPE.bodyStrong, color: COLORS.successText, flex: 1 },
  fieldError: { ...TYPE.label, color: COLORS.dangerText, paddingHorizontal: 12, paddingBottom: 10 },
  fieldHint: { ...TYPE.label, color: COLORS.textSecondary, paddingHorizontal: 12, paddingBottom: 10 },
  listCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 4, ...DEPTH.card },
  listRow: { flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: RADIUS.md },
  rowTitle: { ...TYPE.bodyStrong, color: COLORS.text, flexShrink: 1 },
  rowSub: { ...TYPE.label, color: COLORS.textSecondary, flexShrink: 1 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  moreIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  missing: { gap: 10 },
  // Amount step
  amountBody: { flex: 1, paddingHorizontal: SPACING.md, paddingBottom: 16, gap: 12 },
  recipientCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
  },
  link: { ...TYPE.label, color: COLORS.primaryDark, fontFamily: FONTS.semibold },
  amountBlock: { alignItems: "center", gap: 6 },
  bigAmount: { fontFamily: FONTS.extrabold, fontSize: 52, lineHeight: 60, letterSpacing: -1, color: COLORS.text },
  amountHint: { ...TYPE.label, color: COLORS.textSecondary, textAlign: "center" },
  quickRow: { flexDirection: "row", gap: 8 },
  quick: {
    flex: 1,
    height: 40,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  quickOn: { borderColor: COLORS.primary, borderWidth: 1.5, backgroundColor: COLORS.deep },
  quickText: { ...TYPE.label, color: COLORS.textSecondary },
  noteCard: {
    ...DEPTH.raised,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: COLORS.primaryBorder,
  },
  noteCardFilled: {
    backgroundColor: COLORS.primaryMuted,
    borderColor: COLORS.primary,
  },
  noteIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  noteCardLabel: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text },
  noteCardValue: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.primaryDark, marginTop: 1 },
  noteCardPlaceholder: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  noteActionText: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.primaryDark },
  noteSheet: {
    backgroundColor: COLORS.page,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    padding: SPACING.md,
    paddingTop: 10,
    paddingBottom: 28,
    gap: 12,
  },
  noteSheetSub: { ...TYPE.label, color: COLORS.textSecondary, marginTop: -4 },
  noteInput: {
    height: 50,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    fontFamily: FONTS.medium,
    fontSize: 16,
    color: COLORS.text,
  },
  notePresets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  notePresetPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  notePresetPillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  notePresetText: { ...TYPE.label, color: COLORS.text },
  notePresetTextOn: { color: COLORS.onPrimary, fontFamily: FONTS.semibold },
  noteSheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  keypad: { flexDirection: "row", flexWrap: "wrap" },
  key: { width: "33.333%", height: 56, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  keyText: { fontFamily: FONTS.bold, fontSize: 24, color: COLORS.text },
  // Bank picker sheet
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(14, 21, 18, 0.45)", justifyContent: "flex-end" },
  sheet: {
    height: "85%",
    backgroundColor: COLORS.page,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    padding: SPACING.md,
    paddingTop: 10,
  },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.borderStrong, marginBottom: 12 },
  sheetTitle: { ...TYPE.title, color: COLORS.text, marginBottom: 12 },
  bankRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12 },
});
