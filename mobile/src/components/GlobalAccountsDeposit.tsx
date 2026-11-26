import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { AccountType, GlobalAccountItem } from "../api/types";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE } from "../theme";
import { Button, ErrorBanner, KeyValueRow, SuccessBanner } from "./UI";
import { CurrencyLogo } from "./CurrencyLogo";

const CURRENCY_NAMES: Record<string, string> = { USD: "US dollar", GBP: "British pound", EUR: "Euro", CAD: "Canadian dollar" };

/**
 * Receive money from a bank abroad: the user's own USD / GBP / EUR receiving accounts,
 * every detail copyable, and a way to open the ones they don't have yet.
 */
export function GlobalAccountsDeposit({ accountType, onNeedsVerification }: { accountType: AccountType; onNeedsVerification?: () => void }) {
  const [accounts, setAccounts] = useState<GlobalAccountItem[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listGlobalAccounts(accountType);
      setAccounts(res.accounts || []);
      setSupported(res.supportedCurrencies || []);
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

  const open = async (currency: string) => {
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

  const have = new Set(accounts.map((a) => a.currency.toUpperCase()));
  const canOpen = (supported.length ? supported : ["USD", "GBP", "EUR"]).filter((c) => !have.has(c.toUpperCase()));

  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.intro}>
        Give these details to anyone paying you from abroad. Money that arrives is added to your Proxim balance.
      </Text>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />
      {loading ? <ActivityIndicator color={COLORS.primary} style={{ paddingVertical: 20 }} /> : null}

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
            {a.accountNumber ? <KeyValueRow currency={false} label="Account number" value={a.accountNumber} onCopy={() => copy("Account number", a.accountNumber!)} /> : null}
            {a.routingNumber ? <KeyValueRow currency={false} label="Routing number" value={a.routingNumber} onCopy={() => copy("Routing number", a.routingNumber!)} /> : null}
            {a.sortCode ? <KeyValueRow currency={false} label="Sort code" value={a.sortCode} onCopy={() => copy("Sort code", a.sortCode!)} /> : null}
            {a.iban ? <KeyValueRow currency={false} label="IBAN" value={a.iban} onCopy={() => copy("IBAN", a.iban!)} /> : null}
            {a.swiftCode ? <KeyValueRow currency={false} label="SWIFT / BIC" value={a.swiftCode} onCopy={() => copy("SWIFT code", a.swiftCode!)} /> : null}
          </View>
        );
      })}

      {!loading && canOpen.length ? (
        <View style={styles.card}>
          <Text style={styles.title}>{accounts.length ? "Add another currency" : "Open an account abroad"}</Text>
          <Text style={styles.intro}>Get your own account details in another currency. ID verification is required.</Text>
          {canOpen.map((c) => (
            <Button
              key={c}
              title={`Open ${CURRENCY_NAMES[c.toUpperCase()] || c} account`}
              variant="secondary"
              loading={opening === c}
              disabled={Boolean(opening)}
              onPress={() => open(c)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { ...TYPE.label, color: COLORS.textSecondary },
  card: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, gap: 4, ...DEPTH.card },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  title: { ...TYPE.headline, color: COLORS.text },
  status: { ...TYPE.label },
  statusOk: { color: COLORS.successText },
  statusWait: { color: COLORS.warningText },
});
