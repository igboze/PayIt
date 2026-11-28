import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { AccountType, GlobalAccountItem } from "../api/types";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE, createThemeStyles } from "../theme";
import { Button, ErrorBanner, KeyValueRow, SkeletonCard, SuccessBanner } from "./UI";
import { CurrencyLogo } from "./CurrencyLogo";

const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar",
  GBP: "British Pound",
  EUR: "Euro",
  CAD: "Canadian Dollar",
  NGN: "Nigerian Naira",
  AED: "UAE Dirham",
  KES: "Kenyan Shilling",
  GHS: "Ghanaian Cedi",
  TZS: "Tanzanian Shilling",
  MXN: "Mexican Peso",
};

/**
 * Receive money from a bank abroad: the user's own USD / GBP / EUR receiving accounts,
 * every detail copyable, and a way to open the ones they don't have yet.
 */
export function GlobalAccountsDeposit({ accountType, onNeedsVerification }: { accountType: AccountType; onNeedsVerification?: () => void }) {
  const [accounts, setAccounts] = useState<GlobalAccountItem[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [currencyFees, setCurrencyFees] = useState<Record<string, { formatted: string; amount: number; coveredByBaseMonthlyFee?: boolean }>>({});
  const [minAgeDays, setMinAgeDays] = useState<number>(15);
  const [graceDays, setGraceDays] = useState<number>(14);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listGlobalAccounts(accountType);
      setAccounts(res.accounts || []);
      setSupported(res.supportedCurrencies || []);
      setCurrencyFees(res.currencyFees || {});
      if (res.billingPolicy?.minAgeDays != null) setMinAgeDays(res.billingPolicy.minAgeDays);
      if (res.billingPolicy?.graceDays != null) setGraceDays(res.billingPolicy.graceDays);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your accounts abroad.");
    } finally {
      setLoading(false);
    }
  }, [accountType]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setNotice(`${label} copied`);
    setTimeout(() => setNotice(null), 2000);
  };

  const executeOpen = async (currency: string) => {
    setOpening(currency);
    setError(null);
    try {
      const res = await api.provisionGlobalAccount(currency, accountType);
      setNotice(res.isPending ? `Your ${currency} account is being set up. We'll tell you when it's ready.` : `${currency} account ready`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Couldn't open a ${currency} account.`;
      setError(msg);
      if (/verif|kyc/i.test(msg)) onNeedsVerification?.();
    } finally {
      setOpening(null);
    }
  };

  const open = (currency: string) => {
    const code = currency.toUpperCase();
    const fee = currencyFees[code];
    if (code === "NGN" || fee?.coveredByBaseMonthlyFee) {
      executeOpen(code);
      return;
    }
    const feeLabel = fee?.formatted || "monthly maintenance fee";
    Alert.alert(
      `Open ${CURRENCY_NAMES[code] || code} Account?`,
      `Monthly maintenance fee: ${feeLabel}\n\n• Billed automatically at month-end from your balance\n• Accounts opened less than ${minAgeDays} days before month-end are not charged until the following month\n• Close any zero-balance account anytime to stop future fees (unpaid zero-balance accounts close automatically ${graceDays} days after notice).`,
      [
        { text: "Cancel", style: "cancel" },
        { text: `Open ${code} Account`, onPress: () => executeOpen(code) },
      ]
    );
  };

  const confirmClose = (currency: string) => {
    const code = currency.toUpperCase();
    Alert.alert(
      `Close ${code} Account?`,
      `Closing this account stops all future monthly maintenance fees for ${code}. Your ${code} balance must be 0 before closing. You can open a new account anytime later.`,
      [
        { text: "Keep Account", style: "cancel" },
        {
          text: "Close Account",
          style: "destructive",
          onPress: async () => {
            setClosing(code);
            setError(null);
            try {
              const res = await api.closeGlobalAccount(code, accountType);
              setNotice(res.notice || `${code} account closed.`);
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : `Couldn't close ${code} account.`);
            } finally {
              setClosing(null);
            }
          },
        },
      ]
    );
  };

  const have = new Set(accounts.map((a) => a.currency.toUpperCase()));
  const canOpen = (supported.length ? supported : ["USD", "GBP", "EUR", "CAD", "NGN", "AED", "KES", "GHS", "TZS", "MXN"]).filter(
    (c) => !have.has(c.toUpperCase())
  );

  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.intro}>
        Give these details to anyone paying you from abroad. Money that arrives is added to your Proxim balance.
      </Text>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />
      {loading ? <SkeletonCard rows={2} /> : null}

      {accounts.map((a, i) => {
        const ready = /active|approved|ready|open/i.test(a.status) || Boolean(a.accountNumber || a.iban);
        return (
          <View key={a.id || `${a.currency}-${i}`} style={styles.card}>
            <View style={styles.head}>
              <CurrencyLogo code={a.currency} size={32} />
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{CURRENCY_NAMES[a.currency.toUpperCase()] || a.currency} account</Text>
                <Text style={[styles.status, ready ? styles.statusOk : styles.statusWait]}>{ready ? "Ready to receive" : "Being set up"}</Text>
              </View>
            </View>
            {a.beneficiaryName ? <KeyValueRow currency={false} label="Account name" value={a.beneficiaryName} onCopy={() => copy("Account name", a.beneficiaryName!)} /> : null}
            {a.bankName ? <KeyValueRow currency={false} label="Bank" value={a.bankName} onCopy={() => copy("Bank", a.bankName!)} /> : null}
            {a.bankCode ? <KeyValueRow currency={false} label="Bank code" value={a.bankCode} onCopy={() => copy("Bank code", a.bankCode!)} /> : null}
            {a.accountNumber ? <KeyValueRow currency={false} label="Account number" value={a.accountNumber} onCopy={() => copy("Account number", a.accountNumber!)} /> : null}
            {a.routingNumber ? <KeyValueRow currency={false} label="Routing number" value={a.routingNumber} onCopy={() => copy("Routing number", a.routingNumber!)} /> : null}
            {a.sortCode ? <KeyValueRow currency={false} label="Sort code" value={a.sortCode} onCopy={() => copy("Sort code", a.sortCode!)} /> : null}
            {a.iban ? <KeyValueRow currency={false} label="IBAN" value={a.iban} onCopy={() => copy("IBAN", a.iban!)} /> : null}
            {a.swiftCode ? <KeyValueRow currency={false} label="SWIFT / BIC" value={a.swiftCode} onCopy={() => copy("SWIFT code", a.swiftCode!)} /> : null}
            {a.monthlyFee && a.currency.toUpperCase() !== "NGN" ? (
              <KeyValueRow currency={false} label="Monthly maintenance" value={a.monthlyFee} />
            ) : null}
            {a.pastDue ? (
              <Text style={styles.pastDueWarn}>
                Maintenance fee due ({a.pastDue.currency} {a.pastDue.amount.toFixed(2)}). Fund your balance before{" "}
                {String(a.pastDue.graceExpiresAt || "").slice(0, 10)} to keep this account active.
              </Text>
            ) : null}
            {a.canClose !== false && a.currency.toUpperCase() !== "NGN" ? (
              <Button
                title={`Close ${a.currency.toUpperCase()} account`}
                variant="secondary"
                loading={closing === a.currency.toUpperCase()}
                disabled={Boolean(closing)}
                onPress={() => confirmClose(a.currency)}
                style={{ marginTop: 8 }}
              />
            ) : null}
          </View>
        );
      })}

      {!loading && canOpen.length ? (
        <View style={styles.card}>
          <Text style={styles.title}>{accounts.length ? "Add another currency" : "Open an account abroad"}</Text>
          <Text style={styles.intro}>
            Get your own named bank details in another currency. Monthly maintenance fees apply at month-end once open {minAgeDays}+ days (close anytime for free).
          </Text>
          {canOpen.map((c) => {
            const code = c.toUpperCase();
            const feeLabel = code !== "NGN" && currencyFees[code]?.formatted ? ` · ${currencyFees[code].formatted}` : "";
            return (
              <Button
                key={c}
                title={`Open ${CURRENCY_NAMES[code] || code} account${feeLabel}`}
                variant="secondary"
                loading={opening === c}
                disabled={Boolean(opening)}
                onPress={() => open(c)}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = createThemeStyles(() => ({
  intro: { ...TYPE.label, color: COLORS.textSecondary },
  card: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, gap: 4, ...DEPTH.card },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  title: { ...TYPE.headline, color: COLORS.text },
  status: { ...TYPE.label },
  statusOk: { color: COLORS.successText },
  statusWait: { color: COLORS.warningText },
  pastDueWarn: { ...TYPE.label, color: COLORS.dangerText, marginTop: 6 },
}));
