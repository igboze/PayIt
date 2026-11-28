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
  /** Guaranteed-unique selection key (fixes electricity collision where all prepaid share prodId="01"). */
  uid: string;
  /** The id Airbills knows: network id (airtime), plan/package prodId, or disco electId. */
  code: string;
  /** Electricity disco ID (e.g. "01" Eko, "02" Ikeja). */
  electId?: string;
  /** Electricity meter product type ID ("01" prepaid, "02" postpaid) or plan prodId. */
  prodId?: string;
  /** Parsed meter type for electricity providers. */
  meterType?: "prepaid" | "postpaid";
  /** Clean short label without redundant "(prepaid)"/"(postpaid)" suffix. */
  displayName?: string;
  name: string;
  price?: number;
  networkId?: string;
}

// Same ids as the server's Airbills networks.
const NETWORKS: ProviderOpt[] = [
  { uid: "net:01", code: "01", name: "MTN" },
  { uid: "net:04", code: "04", name: "Airtel" },
  { uid: "net:02", code: "02", name: "Glo" },
  { uid: "net:03", code: "03", name: "9mobile" },
];
const CABLE_BRANDS = ["DStv", "GOtv", "StarTimes", "Showmax"];

// Popular amounts per bill type; any amount can still be typed.
const PRESET_AMOUNTS: Partial<Record<BillCat, number[]>> = {
  airtime: [100, 200, 500, 1000, 2000, 5000],
  electricity: [2000, 5000, 10000, 15000, 20000, 50000],
  betting: [1000, 2000, 5000, 10000, 20000, 50000],
};

// Data plans grouped the way networks sell them.
type PlanGroup = "all" | "daily" | "weekly" | "monthly" | "combo";
const PLAN_GROUPS: Array<[PlanGroup, string]> = [
  ["all", "All"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["combo", "Night & combo"],
];
function planGroup(name: string): PlanGroup {
  const n = name.toLowerCase();
  if (/night|combo|social|youtube|tiktok|whatsapp|instagram|\+|bonus|weekend/.test(n)) return "combo";
  if (/\b(1|2|3)\s*-?\s*days?\b|daily|24\s*h/.test(n)) return "daily";
  if (/\b(7|14)\s*-?\s*days?\b|week/.test(n)) return "weekly";
  if (/\b(30|60|90)\s*-?\s*days?\b|month/.test(n)) return "monthly";
  return "all";
}

function normalizeProviders(raw: unknown[], category: BillCat): ProviderOpt[] {
  return (raw || [])
    .map((item, idx) => {
      if (typeof item === "string") return { uid: `${category}:${item}:${idx}`, code: item, name: item };
      const o = item as Record<string, unknown>;
      const electId = o.electId ? String(o.electId) : undefined;
      const prodId = o.prodId ? String(o.prodId) : undefined;
      // Electricity providers share prodId ("01"=prepaid, "02"=postpaid) across ALL discos, so electId is the primary provider code
      // and uid MUST combine electId + prodId + index so selecting one never highlights multiple discos.
      const code =
        category === "electricity"
          ? String(electId || o.id || o.code || prodId || "")
          : String(prodId || electId || o.id || o.code || o.networkId || "");
      const name = String(o.description || o.name || o.label || o.title || code);
      const rawPrice = o.prodAmount ?? o.price ?? o.amount;
      const price = rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : undefined;
      const networkId = o.networkId ? String(o.networkId) : undefined;

      let meterType: "prepaid" | "postpaid" | undefined;
      let displayName: string | undefined;
      if (category === "electricity") {
        if (/post\s*-?\s*paid/i.test(name) || prodId === "02") meterType = "postpaid";
        else if (/pre\s*-?\s*paid/i.test(name) || prodId === "01") meterType = "prepaid";
        displayName = name
          .replace(/\s*\((?:pre|post)\s*-?\s*paid\)\s*/gi, "")
          .replace(/\s*-\s*(?:pre|post)\s*-?\s*paid\s*/gi, "")
          .trim();
      }
      const uid = `${category}:${electId || ""}:${prodId || ""}:${code}:${idx}`;
      return {
        uid,
        code,
        electId,
        prodId,
        meterType,
        displayName,
        name,
        price: Number.isFinite(price) && (price as number) > 0 ? price : undefined,
        networkId,
      };
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
  const [planFilter, setPlanFilter] = useState<PlanGroup>("all");
  const [meterFilter, setMeterFilter] = useState<"all" | "prepaid" | "postpaid">("all");

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
    setPlanFilter("all");
    setMeterFilter("all");
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
        if (!cancelled) setOptions(normalizeProviders(res.providers || [], category));
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
      const res = await api.validateBillMeter(recipient.trim(), selected.electId || selected.code);
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
      const providerId = category === "electricity" ? (selected.electId || selected.code) : selected.code;
      const res = await requestApproval("bill.pay", {
        accountType: activeAccount,
        category,
        providerId,
        productCode: providerId, // older servers read this
        billData: category === "electricity" && selected.prodId ? { prodId: selected.prodId } : undefined,
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
            {category === "data" && options.length ? (
              <View style={styles.filters}>
                {PLAN_GROUPS.filter(([g]) => g === "all" || options.some((p) => planGroup(p.name) === g)).map(([g, label]) => (
                  <PressableScale
                    key={g}
                    onPress={() => setPlanFilter(g)}
                    haptic="selection"
                    depth={0.94}
                    style={[styles.filterChip, planFilter === g && styles.filterChipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: planFilter === g }}
                  >
                    <Text style={[styles.filterText, planFilter === g && styles.filterTextOn]}>{label}</Text>
                  </PressableScale>
                ))}
              </View>
            ) : null}
            {category === "electricity" && options.length ? (
              <View style={styles.filters}>
                {(
                  [
                    ["all", "All meters"],
                    ["prepaid", "Prepaid"],
                    ["postpaid", "Postpaid"],
                  ] as const
                ).map(([g, label]) => (
                  <PressableScale
                    key={g}
                    onPress={() => setMeterFilter(g)}
                    haptic="selection"
                    depth={0.94}
                    style={[styles.filterChip, meterFilter === g && styles.filterChipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: meterFilter === g }}
                  >
                    <Text style={[styles.filterText, meterFilter === g && styles.filterTextOn]}>{label}</Text>
                  </PressableScale>
                ))}
              </View>
            ) : null}
            {needsBrand ? (
              <View style={styles.grid}>
                {options.filter((p) => category !== "data" || planFilter === "all" || planGroup(p.name) === planFilter).map((p) => (
                  <PlanCard key={p.uid} name={p.name} price={p.price} selected={selected?.uid === p.uid} onPress={() => choose(p)} />
                ))}
              </View>
            ) : (
              <View style={styles.grid}>
                {options
                  .filter((p) => category !== "electricity" || meterFilter === "all" || p.meterType === meterFilter)
                  .map((p) => (
                    <ProviderTile
                      key={p.uid}
                      name={p.displayName || p.name}
                      badge={p.meterType === "prepaid" ? "Prepaid" : p.meterType === "postpaid" ? "Postpaid" : undefined}
                      badgeTone={p.meterType || "neutral"}
                      wide={category === "electricity"}
                      sub={p.price ? formatNgn(p.price) : undefined}
                      selected={selected?.uid === p.uid}
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
            {PRESET_AMOUNTS[category] && !fixedPrice ? (
              <>
                <Text style={styles.amountLabel}>Choose an amount</Text>
                <View style={styles.amountGrid}>
                  {PRESET_AMOUNTS[category]!.map((v) => {
                    const on = Number(amountNgn) === v;
                    return (
                      <PressableScale
                        key={v}
                        onPress={() => setAmountNgn(String(v))}
                        haptic="selection"
                        depth={0.95}
                        style={[styles.amountTile, on && styles.amountTileOn]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[styles.amountText, on && { color: COLORS.primaryDark }]}>{formatNgn(v)}</Text>
                      </PressableScale>
                    );
                  })}
                </View>
              </>
            ) : null}
            <Input
              label={PRESET_AMOUNTS[category] && !fixedPrice ? "Or enter your own amount (₦)" : "Amount (₦)"}
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
  planOn: { borderColor: COLORS.primary, borderWidth: 2, backgroundColor: COLORS.deep },
  planName: { ...TYPE.label, fontFamily: FONTS.semibold, color: COLORS.text },
  planPrice: { ...TYPE.headline, color: COLORS.primaryDark },
  form: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, marginTop: 8, ...DEPTH.card },
  formHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  formTitle: { ...TYPE.headline, color: COLORS.text, flex: 1 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  filterChip: { minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: RADIUS.pill, backgroundColor: COLORS.surface, ...DEPTH.raised },
  filterChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterText: { ...TYPE.label, fontFamily: FONTS.semibold, color: COLORS.text },
  filterTextOn: { color: COLORS.onPrimary },
  amountLabel: { ...TYPE.label, color: COLORS.textSecondary, marginBottom: 8 },
  amountGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  amountTile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    ...DEPTH.raised,
  },
  amountTileOn: { borderColor: COLORS.primary, borderWidth: 2, backgroundColor: COLORS.deep },
  amountText: { ...TYPE.bodyStrong, color: COLORS.text },
  historyCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.md, ...DEPTH.card },
});
