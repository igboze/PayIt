import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { BillHistoryItem } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatNgn,
  Input,
  KeyValueRow,
  Pill,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";

const CATEGORIES = ["airtime", "data", "electricity", "cable", "betting", "transport"] as const;
type BillCat = (typeof CATEGORIES)[number];

interface ProviderOpt {
  code: string;
  name: string;
  price?: number;
}

function normalizeProviders(raw: unknown[]): ProviderOpt[] {
  return (raw || [])
    .map((item) => {
      if (typeof item === "string") return { code: item, name: item };
      const o = item as Record<string, unknown>;
      const code = String(o.code || o.id || o.productCode || o.networkId || o.slug || o.name || "");
      const name = String(o.name || o.label || o.title || code);
      const price = o.price !== undefined ? Number(o.price) : o.amount !== undefined ? Number(o.amount) : undefined;
      return { code, name, price: Number.isFinite(price) ? price : undefined };
    })
    .filter((p) => p.code);
}

export function BillsScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, requestApproval } = useApp();
  const [category, setCategory] = useState<BillCat>("airtime");
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  const [selected, setSelected] = useState<ProviderOpt | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amountNgn, setAmountNgn] = useState("");
  const [meterInfo, setMeterInfo] = useState<string | null>(null);
  const [history, setHistory] = useState<BillHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSelected(null);
    setMeterInfo(null);
    api
      .listBillProviders(category)
      .then((res) => {
        const list = normalizeProviders(res.providers || []);
        setProviders(list);
        if (list.length) {
          setSelected(list[0]);
          if (list[0].price) setAmountNgn(String(list[0].price));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load providers."));
  }, [category]);

  useEffect(() => {
    api.listBillHistory(15).then((r) => setHistory(r.bills || [])).catch(() => {});
  }, []);

  const handleValidateMeter = async () => {
    if (!selected || !recipient.trim()) {
      setError("Select an electricity provider and enter your meter number.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.validateBillMeter(recipient.trim(), selected.code);
      const d = res.details || {};
      const customer = String(d.customerName || d.name || d.Customer_Name || "Meter verified");
      setMeterInfo(customer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not validate meter number.");
    } finally {
      setLoading(false);
    }
  };

  const handlePayBill = async () => {
    if (!selected) {
      setError("Select a provider.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("bill.pay", {
        accountType: activeAccount,
        category,
        productCode: selected.code,
        providerName: selected.name,
        recipient: recipient.trim(),
        amountNgn: Number(amountNgn),
      });
      setNotice(res.notice || "Bill paid successfully!");
      api.listBillHistory(15).then((r) => setHistory(r.bills || [])).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bill payment failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Pay Bills"
        subtitle={`From ${activeAccount === "business" ? "Business" : "Personal"} wallet`}
        onBack={onBack}
      />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.pillRow}>
          {CATEGORIES.map((c) => (
            <Pill
              key={c}
              label={c.charAt(0).toUpperCase() + c.slice(1)}
              active={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </View>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        <Card>
          <SectionHeader title={`Select ${category} provider`} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {providers.slice(0, 20).map((p) => (
                <Pill
                  key={p.code}
                  label={p.price ? `${p.name} (${formatNgn(p.price)})` : p.name}
                  active={selected?.code === p.code}
                  onPress={() => {
                    setSelected(p);
                    if (p.price) setAmountNgn(String(p.price));
                  }}
                />
              ))}
            </View>
          </ScrollView>

          <Input
            label={
              category === "electricity"
                ? "Meter Number"
                : category === "cable"
                ? "Smartcard / IUC Number"
                : category === "betting"
                ? "Customer / Account ID"
                : "Phone Number"
            }
            placeholder={category === "electricity" ? "Meter number" : "08012345678"}
            value={recipient}
            onChangeText={setRecipient}
            keyboardType="default"
          />

          {category === "electricity" ? (
            <Button
              title={meterInfo ? `Verified: ${meterInfo}` : "Validate Meter Number"}
              variant="secondary"
              onPress={handleValidateMeter}
              loading={loading}
              style={{ marginBottom: 14 }}
            />
          ) : null}

          <Input
            label="Amount (NGN)"
            placeholder="e.g. 2000"
            value={amountNgn}
            onChangeText={setAmountNgn}
            keyboardType="numeric"
          />
          <Button title="Review and pay bill" onPress={handlePayBill} loading={loading} />
        </Card>

        <SectionHeader title="Recent Bill Payments" />
        <Card>
          {history.length === 0 ? (
            <EmptyState icon="receipt-outline" title="No bill payments yet" />
          ) : (
            history.map((b) => (
              <KeyValueRow
                key={b.id}
                label={`${b.category} · ${b.providerName || b.recipient}`}
                value={
                  b.meterToken
                    ? `${formatNgn(b.amountNgn)} · Token: ${b.meterToken}`
                    : `${formatNgn(b.amountNgn)} (${b.status})`
                }
                onCopy={
                  b.meterToken
                    ? () => {
                        Clipboard.setStringAsync(b.meterToken!);
                        setNotice("Meter token copied!");
                      }
                    : undefined
                }
              />
            ))
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: SPACING.md },
});
