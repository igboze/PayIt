// Pay bills: pick a bill type, then the provider from a grid of logos (and a plan or package
// where there is one), then the number and amount. Everything is visible at once — no
// sideways-scrolling lists.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { BillHistoryItem } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TYPE } from "../theme";
import { Button, EmptyState, ErrorBanner, formatNgn, Input, KeyValueRow, ScreenHeader, SuccessBanner } from "../components/UI";
import { BILL_CATEGORIES, BillCat, BillCategoryTile, ProviderLogo, ProviderTile } from "../components/bills";
import { PressableScale } from "../components/Touch";

export type { BillCat };

interface ProviderOpt {
  /** The id Airbills knows: network id (airtime), plan/package prodId, or disco electId. */
  code: string;
  name: string;
  price?: number;
  networkId?: string;
}

// Same ids as the server's Airbills networks.
const NETWORKS: ProviderOpt[] = [
  { code: "01", name: "MTN" },
  { code: "04", name: "Airtel" },
  { code: "02", name: "Glo" },
  { code: "03", name: "9mobile" },
];
const CABLE_BRANDS = ["DStv", "GOtv", "StarTimes", "Showmax"];

function normalizeProviders(raw: unknown[]): ProviderOpt[] {
  return (raw || [])
    .map((item) => {
      if (typeof item === "string") return { code: item, name: item };
      const o = item as Record<string, unknown>;
      const code = String(o.prodId || o.electId || o.id || o.code || o.networkId || "");
      const name = String(o.description || o.name || o.label || o.title || code);
      const rawPrice = o.prodAmount ?? o.price ?? o.amount;
      const price = rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : undefined;
      const networkId = o.networkId ? String(o.networkId) : undefined;
      return { code, name, price: Number.isFinite(price) && (price as number) > 0 ? price : undefined, networkId };
    })
    .filter((p) => p.code);
}

const RECIPIENT_LABEL: Record<BillCat, string> = {
  airtime: "Phone number",
  data: "Phone number",
  electricity: "Meter number",
  cable: "Smartcard / IUC number",
  betting: "Betting account ID",
  transport: "Card or phone number",
};

export function BillsScreen({ onBack, initialCategory = "airtime" }: { onBack: () => void; initialCategory?: BillCat }) {
  const { activeAccount, requestApproval } = useApp();
  const [category, setCategory] = useState<BillCat>(initialCategory);
  const [brand, setBrand] = useState<string | null>(null); // network (data) or cable brand
  const [options, setOptions] = useState<ProviderOpt[]>([]); // providers or plans to choose from
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [selected, setSelected] = useState<ProviderOpt | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amountNgn, setAmountNgn] = useState("");
  const [meterInfo, setMeterInfo] = useState<string | null>(null);
  const [history, setHistory] = useState<BillHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsBrand = category === "data" || category === "cable";
  const fixedPrice = category === "data" || category === "cable" || (category === "transport" && Boolean(selected?.price));

  // Reset when the bill type changes.
  useEffect(() => {
    setBrand(null);
    setSelected(null);
    setMeterInfo(null);
    setOptions([]);
    setAmountNgn("");
    setError(null);
  }, [category]);

  // Load what to choose from: providers, or plans once a network / cable brand is picked.
  useEffect(() => {
    if (category === "airtime") return setOptions(NETWORKS);
    if (needsBrand && !brand) return setOptions([]);
    let cancelled = false;
    setLoadingOptions(true);
    const extra = category === "data" ? { networkId: NETWORKS.find((n) => n.name === brand)?.code } : category === "cable" ? { provider: brand || undefined } : undefined;
    api
      .listBillProviders(category, extra)
      .then((res) => {
        if (!cancelled) setOptions(normalizeProviders(res.providers || []));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Couldn't load options."))
      .finally(() => !cancelled && setLoadingOptions(false));
    return () => {
      cancelled = true;
    };
  }, [category, brand, needsBrand]);

  useEffect(() => {
    api.listBillHistory(15).then((r) => setHistory(r.bills || [])).catch(() => {});
  }, []);

  const choose = (p: ProviderOpt) => {
    setSelected(p);
    setMeterInfo(null);
    if (p.price) setAmountNgn(String(p.price));
  };

  const validateMeter = async () => {
    if (!selected || !recipient.trim()) return setError("Choose your electricity company and enter the meter number.");
    setLoading(true);
    setError(null);
    try {
      const res = await api.validateBillMeter(recipient.trim(), selected.code);
      const d = (res.details || {}) as Record<string, unknown>;
      setMeterInfo(String(d.customerName || d.name || d.Customer_Name || "Meter verified"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't verify that meter number.");
    } finally {
      setLoading(false);
    }
  };

  const pay = async () => {
    if (!selected) return setError(needsBrand ? "Choose a plan." : "Choose a provider.");
    if (!recipient.trim()) return setError(`Enter the ${RECIPIENT_LABEL[category].toLowerCase()}.`);
    if (!(Number(amountNgn) > 0)) return setError("Enter an amount.");
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("bill.pay", {
        accountType: activeAccount,
        category,
        providerId: selected.code,
        productCode: selected.code, // older servers read this
        networkId: category === "data" ? NETWORKS.find((n) => n.name === brand)?.code || selected.networkId : selected.networkId,
        providerName: category === "data" || category === "cable" ? `${brand} ${selected.name}` : selected.name,
        recipient: recipient.trim(),
        amountNgn: Number(amountNgn),
      });
      setNotice(res.notice || "Bill paid");
      api.listBillHistory(15).then((r) => setHistory(r.bills || [])).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bill payment failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const cat = useMemo(() => BILL_CATEGORIES.find((c) => c.key === category)!, [category]);
  const brandList = category === "data" ? NETWORKS.map((n) => n.name) : CABLE_BRANDS;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Pay bills" subtitle={`From your ${activeAccount === "business" ? "business" : "personal"} balance`} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.step}>What are you paying for?</Text>
        <View style={styles.grid}>
          {BILL_CATEGORIES.map((c) => (
            <BillCategoryTile key={c.key} cat={c} compact selected={c.key === category} onPress={() => setCategory(c.key)} />
          ))}
        </View>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {needsBrand ? (
          <>
            <Text style={styles.step}>{category === "data" ? "Choose network" : "Choose TV provider"}</Text>
            <View style={styles.grid}>
              {brandList.map((b) => (
                <ProviderTile key={b} name={b} selected={brand === b} onPress={() => { setBrand(b); setSelected(null); }} />
              ))}
            </View>
          </>
        ) : null}

        {(!needsBrand || brand) ? (
          <>
            <Text style={styles.step}>
              {needsBrand ? (category === "data" ? `${brand} data plans` : `${brand} packages`) : category === "airtime" ? "Choose network" : `Choose ${cat.label.toLowerCase()} provider`}
            </Text>
            {loadingOptions ? <ActivityIndicator color={COLORS.primary} style={{ paddingVertical: 16 }} /> : null}
            {needsBrand ? (
              <View style={styles.grid}>
                {options.map((p) => (
                  <PlanCard key={p.code} name={p.name} price={p.price} selected={selected?.code === p.code} onPress={() => choose(p)} />
                ))}
              </View>
            ) : (
              <View style={styles.grid}>
                {options.map((p) => (
                  <ProviderTile
                    key={p.code}
                    name={p.name}
                    sub={p.price ? formatNgn(p.price) : undefined}
                    selected={selected?.code === p.code}
                    onPress={() => choose(p)}
                  />
                ))}
              </View>
            )}
            {!loadingOptions && !options.length ? <Text style={styles.muted}>Nothing available right now. Try again shortly.</Text> : null}
          </>
        ) : null}

        {selected ? (
          <View style={styles.form}>
            <View style={styles.formHead}>
              <ProviderLogo name={needsBrand ? brand || selected.name : selected.name} size={36} />
              <Text style={styles.formTitle} numberOfLines={2}>
                {needsBrand ? `${brand} · ${selected.name}` : selected.name}
              </Text>
            </View>
            <Input
              label={RECIPIENT_LABEL[category]}
              placeholder={category === "airtime" || category === "data" ? "08012345678" : ""}
              value={recipient}
              onChangeText={(t) => {
                setRecipient(t);
                setMeterInfo(null);
              }}
              keyboardType={category === "betting" ? "default" : "number-pad"}
              currency={false}
            />
            {category === "electricity" ? (
              <Button
                title={meterInfo ? `Verified: ${meterInfo}` : "Check meter number"}
                variant="secondary"
                onPress={validateMeter}
                loading={loading && !meterInfo}
                style={{ marginBottom: 14 }}
              />
            ) : null}
            <Input
              label="Amount (₦)"
              placeholder="e.g. 2000"
              value={amountNgn}
              onChangeText={(t) => setAmountNgn(t.replace(/[^0-9]/g, ""))}
              keyboardType="number-pad"
              editable={!fixedPrice}
              currency="NGN"
            />
            <Button title={Number(amountNgn) > 0 ? `Pay ${formatNgn(Number(amountNgn))}` : "Pay"} onPress={pay} loading={loading} />
          </View>
        ) : null}

        <Text style={[styles.step, { marginTop: 20 }]}>Recent bill payments</Text>
        <View style={styles.historyCard}>
          {history.length === 0 ? (
            <EmptyState icon="receipt-outline" title="No bill payments yet" />
          ) : (
            history.map((b) => (
              <KeyValueRow
                key={b.id}
                currency={false}
                label={`${b.providerName || b.category} · ${b.recipient}`}
                value={b.meterToken ? `${formatNgn(b.amountNgn)} · Token ${b.meterToken}` : `${formatNgn(b.amountNgn)} · ${b.status}`}
                onCopy={
                  b.meterToken
                    ? () => {
                        Clipboard.setStringAsync(b.meterToken!);
                        setNotice("Meter token copied");
                      }
                    : undefined
                }
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function PlanCard({ name, price, selected, onPress }: { name: string; price?: number; selected: boolean; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      depth={0.96}
      haptic="selection"
      style={[styles.plan, selected && styles.planOn]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={price ? `${name}, ${formatNgn(price)}` : name}
    >
      <Text style={styles.planName} numberOfLines={3}>
        {name}
      </Text>
      {price ? <Text style={styles.planPrice}>{formatNgn(price)}</Text> : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 48, gap: 10 },
  step: { ...TYPE.headline, color: COLORS.text, marginTop: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  muted: { ...TYPE.label, color: COLORS.textSecondary },
  plan: {
    flexBasis: "46%",
    flexGrow: 1,
    minHeight: 96,
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
  },
  planOn: { borderColor: COLORS.primary, borderWidth: 2, borderBottomWidth: 4, borderBottomColor: COLORS.primaryDark, backgroundColor: COLORS.deep },
  planName: { ...TYPE.label, fontFamily: FONTS.semibold, color: COLORS.text },
  planPrice: { ...TYPE.headline, color: COLORS.primaryDark },
  form: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, marginTop: 8, ...DEPTH.card },
  formHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  formTitle: { ...TYPE.headline, color: COLORS.text, flex: 1 },
  historyCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, ...DEPTH.card },
});
