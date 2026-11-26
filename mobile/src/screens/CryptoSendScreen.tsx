// Send dollars out as crypto: pick a network and a token (anything NEAR Intents can deliver),
// paste the address, enter the amount, then review and approve with passkey + PIN.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TYPE } from "../theme";
import { Button, ErrorBanner, Input, KeyboardSafe, ScreenHeader } from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";

type Chain = { key: string; name: string; logoUrl: string | null; tokenCount: number };
type Token = { symbol: string; name: string; assetId: string; blockchain: string; priceUsd: number | null; logoUrl: string | null };

// Proxim's own network: USDC, instant, no bridge.
const PROXIM_NETWORK: Chain = { key: "proxim-arc", name: "Proxim network (Arc)", logoUrl: null, tokenCount: 1 };
// USDC to these goes through Circle's bridge (cheaper than a swap).
const CCTP_KEY: Record<string, string> = { base: "base", arb: "arbitrum", arbitrum: "arbitrum", eth: "ethereum", ethereum: "ethereum", sol: "solana", solana: "solana", pol: "polygon", polygon: "polygon", avax: "avalanche", avalanche: "avalanche", op: "optimism", optimism: "optimism" };

export function CryptoSendScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, requestApproval } = useApp();
  const [chains, setChains] = useState<Chain[]>([]);
  const [tokensByChain, setTokensByChain] = useState<Record<string, Token[]>>({});
  const [feeUsd, setFeeUsd] = useState(0.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [chain, setChain] = useState<Chain | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [picker, setPicker] = useState<"chain" | "token" | null>(null);
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api
      .listWithdrawalTokens()
      .then((r) => {
        setChains([PROXIM_NETWORK, ...(r.chains || [])]);
        setTokensByChain(r.tokensByChain || {});
        setFeeUsd(Number(r.feeUsd ?? 0.3));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load networks."))
      .finally(() => setLoading(false));
  }, []);

  const tokens: Token[] = useMemo(() => {
    if (!chain) return [];
    if (chain.key === PROXIM_NETWORK.key) return [{ symbol: "USDC", name: "USD Coin", assetId: "arc-usdc", blockchain: "arc", priceUsd: 1, logoUrl: null }];
    return tokensByChain[chain.key] || [];
  }, [chain, tokensByChain]);

  const usd = Number(amount || 0);
  const isProxim = chain?.key === PROXIM_NETWORK.key;
  const viaBridge = Boolean(chain && token && token.symbol.toUpperCase() === "USDC" && CCTP_KEY[chain.key]);
  const fee = isProxim ? 0 : feeUsd;
  const estimate = token?.priceUsd && usd > fee ? (usd - fee) / token.priceUsd : null;

  const review = async () => {
    if (!chain || !token) return setError("Pick a network and a token.");
    if (!address.trim()) return setError("Paste the wallet address you're sending to.");
    if (!(usd >= 1) || usd <= fee) return setError(`Send at least $${Math.max(1, fee + 0.01).toFixed(2)}.`);
    setError(null);
    setSending(true);
    try {
      if (isProxim) {
        await requestApproval("transfer.wallet", { accountType: activeAccount, toAddress: address.trim(), amountUsdc: usd });
      } else if (viaBridge) {
        await requestApproval("withdraw.crypto", { accountType: activeAccount, destinationChain: CCTP_KEY[chain.key], destinationAddress: address.trim(), amountUsdc: usd });
      } else {
        await requestApproval("withdraw.crypto", { accountType: activeAccount, assetId: token.assetId, destinationAddress: address.trim(), amountUsdc: usd });
      }
      onBack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "That didn't go through.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Send crypto" subtitle={`From your ${activeAccount === "business" ? "business" : "personal"} balance`} onBack={onBack} />
      <KeyboardSafe>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {loading ? <ActivityIndicator color={COLORS.primary} style={{ paddingVertical: 24 }} /> : null}
          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          <Text style={styles.label}>Network</Text>
          <PressableScale onPress={() => setPicker("chain")} depth={0.98} style={styles.select} accessibilityLabel="Choose network">
            <CoinIcon uri={chain?.logoUrl} code={chain ? chain.name : "?"} />
            <Text style={[styles.selectText, !chain && styles.placeholder]}>{chain ? chain.name : "Choose a network"}</Text>
            <Ionicons name="chevron-down" size={20} color={COLORS.textSecondary} />
          </PressableScale>

          <Text style={styles.label}>Token</Text>
          <PressableScale
            onPress={() => (chain ? setPicker("token") : setError("Choose a network first."))}
            depth={0.98}
            style={styles.select}
            accessibilityLabel="Choose token"
          >
            <CoinIcon uri={token?.logoUrl} code={token ? token.symbol : "?"} />
            <Text style={[styles.selectText, !token && styles.placeholder]}>{token ? `${token.symbol} · ${token.name}` : "Choose a token"}</Text>
            <Ionicons name="chevron-down" size={20} color={COLORS.textSecondary} />
          </PressableScale>

          <Input
            label="Wallet address"
            placeholder={isProxim ? "0x…" : "Paste the address"}
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            currency={false}
          />
          <Input
            label="Amount (USD)"
            placeholder="e.g. 25"
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
            currency="USD"
          />

          {token && usd > 0 ? (
            <View style={styles.summary}>
              <Row label="Network fee" value={fee ? `$${fee.toFixed(2)}` : "Free"} />
              <Row
                label="They get"
                value={
                  isProxim || viaBridge
                    ? `≈ ${(usd - fee).toFixed(2)} USDC`
                    : estimate
                      ? `≈ ${estimate.toFixed(estimate < 1 ? 6 : 4)} ${token.symbol}`
                      : `${token.symbol} at the live rate`
                }
              />
              <Text style={styles.note}>The exact amount is confirmed on the next screen before you approve.</Text>
            </View>
          ) : null}

          <Button title="Review" onPress={review} loading={sending} disabled={!chain || !token} />
        </ScrollView>
      </KeyboardSafe>

      <PickerSheet
        visible={picker === "chain"}
        title="Choose network"
        items={chains.map((c) => ({ key: c.key, title: c.name, sub: c.key === PROXIM_NETWORK.key ? "USDC · instant, no fee" : `${c.tokenCount} tokens`, uri: c.logoUrl }))}
        onClose={() => setPicker(null)}
        onPick={(key) => {
          const c = chains.find((x) => x.key === key) || null;
          setChain(c);
          setToken(c?.key === PROXIM_NETWORK.key ? { symbol: "USDC", name: "USD Coin", assetId: "arc-usdc", blockchain: "arc", priceUsd: 1, logoUrl: null } : null);
          setPicker(null);
        }}
      />
      <PickerSheet
        visible={picker === "token"}
        title={chain ? `Tokens on ${chain.name}` : "Choose token"}
        items={tokens.map((t) => ({ key: t.assetId, title: t.symbol, sub: t.name, uri: t.logoUrl }))}
        onClose={() => setPicker(null)}
        onPick={(key) => {
          setToken(tokens.find((t) => t.assetId === key) || null);
          setPicker(null);
        }}
      />
    </View>
  );
}

function CoinIcon({ uri, code }: { uri?: string | null; code: string }) {
  if (code === "?") return <Ionicons name="ellipse-outline" size={28} color={COLORS.textMuted} />;
  return <CurrencyLogo code={code.split(" ")[0]} uri={uri} size={28} />;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function PickerSheet({
  visible,
  title,
  items,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: Array<{ key: string; title: string; sub: string; uri: string | null }>;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = q.trim() ? items.filter((i) => `${i.title} ${i.sub}`.toLowerCase().includes(q.trim().toLowerCase())) : items;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafe style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          <View style={styles.search}>
            <Ionicons name="search" size={20} color={COLORS.textSecondary} />
            <TextInput value={q} onChangeText={setQ} placeholder="Search" placeholderTextColor={COLORS.textMuted} style={styles.searchInput} />
          </View>
          <FlatList
            data={shown}
            keyExtractor={(i) => i.key}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <PressableScale onPress={() => onPick(item.key)} depth={0.98} style={styles.option}>
                <CurrencyLogo code={item.title.split(" ")[0]} uri={item.uri} size={32} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.optionTitle}>{item.title}</Text>
                  <Text style={styles.optionSub} numberOfLines={1}>{item.sub}</Text>
                </View>
              </PressableScale>
            )}
            ListEmptyComponent={<Text style={[styles.optionSub, { padding: 16 }]}>Nothing matches that.</Text>}
          />
          <Button title="Close" variant="ghost" onPress={onClose} />
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.md, gap: 8, paddingBottom: 40 },
  label: { ...TYPE.label, color: COLORS.textSecondary, marginTop: 4 },
  select: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 14,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    marginBottom: 8,
    ...DEPTH.raised,
  },
  selectText: { ...TYPE.bodyStrong, color: COLORS.text, flex: 1 },
  placeholder: { color: COLORS.textMuted, fontFamily: FONTS.medium },
  summary: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, padding: 14, gap: 8, marginBottom: 8, ...DEPTH.card },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { ...TYPE.label, color: COLORS.textSecondary },
  rowValue: { ...TYPE.bodyStrong, color: COLORS.text, flexShrink: 1, textAlign: "right" },
  note: { ...TYPE.label, fontSize: 12, color: COLORS.textMuted },
  backdrop: { backgroundColor: "rgba(14, 21, 18, 0.45)", justifyContent: "flex-end" },
  sheet: { height: "85%", backgroundColor: COLORS.page, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.md, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.borderStrong, marginBottom: 12 },
  sheetTitle: { ...TYPE.title, color: COLORS.text, marginBottom: 12 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 14,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: "#8E9A94",
    marginBottom: 8,
  },
  searchInput: { flex: 1, fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text },
  option: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12 },
  optionTitle: { ...TYPE.bodyStrong, color: COLORS.text },
  optionSub: { ...TYPE.label, color: COLORS.textSecondary },
});
