import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type {
  CryptoDepositIntentResponse,
  CryptoDepositTokensResponse,
  IntentChainInfo,
  IntentTokenInfo,
  NgnDepositOrder,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING } from "../theme";
import {
  Button,
  Card,
  ErrorBanner,
  formatNgn,
  Input,
  KeyValueRow,
  Pill,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";

type Method = "ngn" | "crypto" | "card";

export function AddMoneyScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, bumpDataVersion } = useApp();
  const isBiz = activeAccount === "business";

  const [method, setMethod] = useState<Method>("ngn");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // NGN state
  const [amountNgn, setAmountNgn] = useState("");
  const [ngnOrder, setNgnOrder] = useState<NgnDepositOrder | null>(null);
  const [ngnStatus, setNgnStatus] = useState<string | null>(null);

  // Crypto state (ALL NEAR Intents chains + tokens with logos)
  const [cryptoMeta, setCryptoMeta] = useState<CryptoDepositTokensResponse | null>(null);
  const [loadingCryptoMeta, setLoadingCryptoMeta] = useState(false);
  const [chainQuery, setChainQuery] = useState("");
  const [tokenQuery, setTokenQuery] = useState("");
  const [selectedChainKey, setSelectedChainKey] = useState<string>("sol");
  const [selectedToken, setSelectedToken] = useState<IntentTokenInfo | null>(null);
  const [cryptoAmount, setCryptoAmount] = useState("");
  const [cryptoIntent, setCryptoIntent] = useState<CryptoDepositIntentResponse | null>(null);
  const [cryptoLiveStatus, setCryptoLiveStatus] = useState<string | null>(null);

  useEffect(() => {
    setNgnOrder(null);
    setCryptoIntent(null);
    if (method === "crypto") {
      setLoadingCryptoMeta(true);
      api
        .listCryptoDepositTokens(activeAccount)
        .then((res) => {
          setCryptoMeta(res);
          const chains = res.chains || [];
          const defaultChain = chains.find((c) => c.key === selectedChainKey)?.key || chains[0]?.key || "sol";
          setSelectedChainKey(defaultChain);
          const list = res.tokensByChain?.[defaultChain] || [];
          if (list.length) setSelectedToken(list[0]);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load crypto deposit options."))
        .finally(() => setLoadingCryptoMeta(false));
    }
  }, [method, activeAccount]);

  const allChains: IntentChainInfo[] = useMemo(() => {
    if (cryptoMeta?.chains && cryptoMeta.chains.length > 0) return cryptoMeta.chains;
    return [
      { key: "sol", name: "Solana", short: "SOL", isEvm: false, priority: 1, logoUrl: null, tokenCount: cryptoMeta?.intents?.solana?.length || 0 },
      { key: "near", name: "NEAR", short: "NEAR", isEvm: false, priority: 2, logoUrl: null, tokenCount: cryptoMeta?.intents?.near?.length || 0 },
      { key: "starknet", name: "Starknet", short: "STRK", isEvm: false, priority: 3, logoUrl: null, tokenCount: cryptoMeta?.intents?.starknet?.length || 0 },
      { key: "hood", name: "Robinhood Chain", short: "HOOD", isEvm: true, priority: 4, logoUrl: null, tokenCount: cryptoMeta?.intents?.robinhood?.length || 0 },
    ];
  }, [cryptoMeta]);

  const filteredChains = useMemo(() => {
    const q = chainQuery.trim().toLowerCase();
    if (!q) return allChains;
    return allChains.filter(
      (c) => c.name.toLowerCase().includes(q) || c.short.toLowerCase().includes(q) || c.key.includes(q)
    );
  }, [allChains, chainQuery]);

  const chainTokens: IntentTokenInfo[] = useMemo(() => {
    const byChain = cryptoMeta?.tokensByChain?.[selectedChainKey];
    if (byChain && byChain.length > 0) return byChain;
    if (selectedChainKey === "sol") return cryptoMeta?.intents?.solana || [];
    if (selectedChainKey === "near") return cryptoMeta?.intents?.near || [];
    if (selectedChainKey === "hood") return cryptoMeta?.intents?.robinhood || [];
    if (selectedChainKey === "starknet") return cryptoMeta?.intents?.starknet || [];
    return [];
  }, [cryptoMeta, selectedChainKey]);

  const filteredTokens = useMemo(() => {
    const q = tokenQuery.trim().toLowerCase();
    if (!q) return chainTokens;
    return chainTokens.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
    );
  }, [chainTokens, tokenQuery]);

  const selectedChainObj = allChains.find((c) => c.key === selectedChainKey) || null;

  const handleSelectChain = (chainKey: string) => {
    setSelectedChainKey(chainKey);
    setTokenQuery("");
    setCryptoIntent(null);
    const list = cryptoMeta?.tokensByChain?.[chainKey] || [];
    setSelectedToken(list[0] || null);
  };

  const copy = async (label: string, val: string) => {
    await Clipboard.setStringAsync(val);
    setNotice(`${label} copied to clipboard`);
    setTimeout(() => setNotice(null), 2200);
  };

  const handleCreateNgnDeposit = async () => {
    setError(null);
    setNotice(null);
    const amt = Number(amountNgn.replace(/,/g, ""));
    if (!Number.isFinite(amt) || amt < 500) {
      setError("Enter a Naira amount of at least ₦500.");
      return;
    }
    setLoading(true);
    try {
      const order = await api.createNgnDeposit(amt, activeAccount);
      setNgnOrder(order);
      setNgnStatus(order.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create Naira deposit account.");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckNgnStatus = async () => {
    if (!ngnOrder?.orderId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getNgnDepositStatus(ngnOrder.orderId);
      setNgnStatus(res.status);
      if (/completed|paid|success/i.test(res.status)) {
        setNotice("Deposit confirmed! Refreshing balance.");
        bumpDataVersion();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check deposit status.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCryptoIntent = async () => {
    setError(null);
    setNotice(null);
    if (!selectedToken) {
      setError("Select a token to deposit.");
      return;
    }
    const amt = Number(cryptoAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid deposit amount.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.createCryptoDepositIntent({
        chain: selectedChainKey,
        symbol: selectedToken.symbol,
        assetId: selectedToken.assetId,
        amount: amt,
        accountType: activeAccount,
      });
      setCryptoIntent(res);
      setCryptoLiveStatus(res.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate deposit address.");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckCryptoStatus = async () => {
    if (!cryptoIntent?.depositId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCryptoDepositStatus(cryptoIntent.depositId);
      const st = String(
        (res.liveStatus as { status?: string } | null)?.status ||
          (res.deposit as { status?: string })?.status ||
          "pending"
      );
      setCryptoLiveStatus(st);
      if (/success|completed/i.test(st)) {
        setNotice("Deposit settled into your balance!");
        bumpDataVersion();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check deposit status.");
    } finally {
      setLoading(false);
    }
  };

  const handleSweepEvm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.sweepCryptoDeposits(activeAccount);
      setNotice(
        res.swept.length
          ? `Credited ${res.swept.length} pending deposit(s) into your ${activeAccount} balance.`
          : "No pending deposits found to credit."
      );
      bumpDataVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit check failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCardDeposit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCardDepositLink(activeAccount);
      const targetUrl = String(res.url || res.link || "");
      if (!targetUrl) throw new Error("Card / Apple Pay deposit link is unavailable right now.");
      await Linking.openURL(targetUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open Card / Apple Pay checkout.");
    } finally {
      setLoading(false);
    }
  };

  const evmDirectAddr = cryptoMeta?.directAddresses?.evm || cryptoMeta?.directAddresses?.base || null;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Deposit"
        subtitle={`Into ${isBiz ? "Business" : "Personal"} account`}
        onBack={onBack}
      />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card
          style={{
            borderColor: isBiz ? COLORS.businessBorder : COLORS.primaryBorder,
            backgroundColor: isBiz ? COLORS.businessMuted : COLORS.primaryMuted,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: isBiz ? COLORS.business : COLORS.primary, fontSize: 12, fontWeight: "700" }}>
            DEPOSITING INTO: {isBiz ? "BUSINESS ACCOUNT" : "PERSONAL ACCOUNT"}
          </Text>
          <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 2 }}>
            Funds deposited here credit your {isBiz ? "Business" : "Personal"} balance only.
          </Text>
        </Card>

        <View style={styles.methodRow}>
          <Pill label="Naira Bank" active={method === "ngn"} onPress={() => setMethod("ngn")} />
          <Pill label="Crypto" active={method === "crypto"} onPress={() => setMethod("crypto")} />
          <Pill label="Card / Apple Pay" active={method === "card"} onPress={() => setMethod("card")} />
        </View>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {method === "ngn" ? (
          <Card>
            <SectionHeader title="Naira Bank Deposit" />
            <Input
              label="Amount in Naira (NGN)"
              placeholder="e.g. 50000"
              value={amountNgn}
              onChangeText={(t) => setAmountNgn(t.replace(/[^\d.]/g, ""))}
              keyboardType="numeric"
              hint="Minimum ₦500. You will get a dedicated one-time bank account to transfer into."
            />
            <Button
              title="Get bank account to pay into"
              onPress={handleCreateNgnDeposit}
              loading={loading}
            />

            {ngnOrder ? (
              <View style={styles.resultBox}>
                <SectionHeader title={`Deposit Account · ${ngnStatus || ngnOrder.status}`} />
                <KeyValueRow label="Bank" value={ngnOrder.virtualAccount.bankName || "—"} />
                <KeyValueRow
                  label="Account Number"
                  value={ngnOrder.virtualAccount.accountNumber || "—"}
                  onCopy={
                    ngnOrder.virtualAccount.accountNumber
                      ? () => copy("Account number", ngnOrder.virtualAccount.accountNumber!)
                      : undefined
                  }
                />
                <KeyValueRow label="Account Name" value={ngnOrder.virtualAccount.accountName || "—"} />
                <KeyValueRow label="Exact Amount" value={formatNgn(ngnOrder.virtualAccount.amountNgn)} />
                {ngnOrder.estimatedUsdc ? (
                  <KeyValueRow
                    label="Estimated Credit"
                    value={`~$${Number(ngnOrder.estimatedUsdc).toFixed(2)} USD`}
                  />
                ) : null}
                {ngnOrder.orderId ? (
                  <Button
                    title="Check Deposit Status"
                    variant="secondary"
                    onPress={handleCheckNgnStatus}
                    loading={loading}
                    style={{ marginTop: 12 }}
                  />
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        {method === "crypto" ? (
          <>
            <Card>
              <SectionHeader
                title={`Multi-Chain Crypto Deposit (${allChains.length} Networks)`}
              />

              {loadingCryptoMeta ? (
                <View style={{ paddingVertical: 24, alignItems: "center", gap: 8 }}>
                  <ActivityIndicator color={COLORS.primary} />
                  <Text style={styles.mutedText}>Loading all supported networks & tokens…</Text>
                </View>
              ) : (
                <>
                  <Input
                    label="1. Choose Network"
                    placeholder="Search network (Bitcoin, Ethereum, Solana, Tron, TON, BNB…)"
                    value={chainQuery}
                    onChangeText={setChainQuery}
                  />

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
                    <View style={styles.chipStrip}>
                      {filteredChains.map((c) => {
                        const active = c.key === selectedChainKey;
                        return (
                          <PressableScale
                            key={c.key}
                            onPress={() => handleSelectChain(c.key)}
                            style={[styles.chainChip, active && styles.chainChipActive]}
                          >
                            <CurrencyLogo uri={c.logoUrl} code={c.short} size={22} />
                            <View>
                              <Text style={[styles.chainChipName, active && { color: COLORS.primary }]}>
                                {c.name}
                              </Text>
                              <Text style={styles.chainChipCount}>
                                {c.tokenCount} {c.tokenCount === 1 ? "token" : "tokens"}
                              </Text>
                            </View>
                          </PressableScale>
                        );
                      })}
                    </View>
                  </ScrollView>

                  <Input
                    label={`2. Choose Token on ${selectedChainObj?.name || selectedChainKey}`}
                    placeholder="Search token symbol (USDC, USDT, BTC, ETH, SOL…)"
                    value={tokenQuery}
                    onChangeText={setTokenQuery}
                  />

                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginBottom: 14 }}
                  >
                    <View style={styles.chipStrip}>
                      {filteredTokens.map((tk) => {
                        const active = selectedToken?.assetId === tk.assetId;
                        return (
                          <PressableScale
                            key={tk.assetId}
                            onPress={() => {
                              setSelectedToken(tk);
                              setCryptoIntent(null);
                            }}
                            style={[styles.tokenCard, active && styles.tokenCardActive]}
                          >
                            <CurrencyLogo uri={tk.logoUrl} code={tk.symbol} size={28} />
                            <Text style={[styles.tokenSym, active && { color: COLORS.primary }]} numberOfLines={1}>
                              {tk.symbol}
                            </Text>
                            {tk.priceUsd !== null && tk.priceUsd !== undefined ? (
                              <Text style={styles.tokenPrice}>
                                ${tk.priceUsd >= 1 ? tk.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 }) : tk.priceUsd.toFixed(4)}
                              </Text>
                            ) : null}
                          </PressableScale>
                        );
                      })}
                    </View>
                  </ScrollView>

                  <Input
                    label={`3. Amount (${selectedToken?.symbol || "Token"})`}
                    placeholder="e.g. 25"
                    value={cryptoAmount}
                    onChangeText={(t) => setCryptoAmount(t.replace(/[^\d.]/g, ""))}
                    keyboardType="decimal-pad"
                    hint={
                      selectedToken?.priceUsd && Number(cryptoAmount) > 0
                        ? `Estimated value: ~$${(Number(cryptoAmount) * selectedToken.priceUsd).toFixed(2)} USD`
                        : undefined
                    }
                  />

                  <Button
                    title={`Get ${selectedChainObj?.name || ""} ${selectedToken?.symbol || ""} Deposit Address`}
                    onPress={handleCreateCryptoIntent}
                    loading={loading}
                  />

                  {cryptoIntent ? (
                    <View style={styles.resultBox}>
                      <SectionHeader
                        title={`Deposit #${cryptoIntent.depositId} · ${cryptoLiveStatus || cryptoIntent.status}`}
                      />
                      <KeyValueRow
                        label="Deposit Address"
                        value={cryptoIntent.depositAddress}
                        onCopy={() => copy("Deposit address", cryptoIntent.depositAddress)}
                      />
                      {cryptoIntent.depositMemo ? (
                        <KeyValueRow
                          label="Memo / Tag"
                          value={cryptoIntent.depositMemo}
                          onCopy={() => copy("Memo", cryptoIntent.depositMemo!)}
                        />
                      ) : null}
                      <KeyValueRow
                        label="Send Exact Amount"
                        value={`${cryptoIntent.amount} ${cryptoIntent.symbol}`}
                      />
                      {cryptoIntent.estimatedAmountOutUsdc ? (
                        <KeyValueRow
                          label="Estimated Credit"
                          value={`~$${Number(cryptoIntent.estimatedAmountOutUsdc).toFixed(2)} USD`}
                        />
                      ) : null}
                      <Button
                        title="Check Deposit Status"
                        variant="secondary"
                        onPress={handleCheckCryptoStatus}
                        loading={loading}
                        style={{ marginTop: 12 }}
                      />
                    </View>
                  ) : null}
                </>
              )}
            </Card>

            <Card>
              <SectionHeader title="Direct Deposit Addresses" />
              {cryptoMeta ? (
                <>
                  <KeyValueRow
                    label="EVM (Base, Eth, Arb, OP, Pol)"
                    value={evmDirectAddr || "Unavailable"}
                    onCopy={evmDirectAddr ? () => copy("Deposit address", evmDirectAddr) : undefined}
                  />
                  <KeyValueRow
                    label="Solana (USDC)"
                    value={cryptoMeta.directAddresses.solana || "Complete one PIN action to initialize"}
                    onCopy={
                      cryptoMeta.directAddresses.solana
                        ? () => copy("Solana deposit address", cryptoMeta.directAddresses.solana!)
                        : undefined
                    }
                  />
                  <Button
                    title="Scan & Credit Pending Deposits"
                    variant="secondary"
                    onPress={handleSweepEvm}
                    loading={loading}
                    style={{ marginTop: 12 }}
                  />
                </>
              ) : (
                <Text style={styles.mutedText}>Loading direct deposit addresses…</Text>
              )}
            </Card>
          </>
        ) : null}

        {method === "card" ? (
          <Card>
            <SectionHeader title="Debit Card & Apple Pay Deposit" />
            <Text style={styles.mutedText}>
              Deposit directly into your {isBiz ? "Business" : "Personal"} Proxim balance using a
              debit card or Apple Pay.
            </Text>
            <Button
              title="Continue to Card / Apple Pay"
              onPress={handleOpenCardDeposit}
              loading={loading}
              style={{ marginTop: 14 }}
            />
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  methodRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: SPACING.md,
  },
  chipStrip: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
  },
  chainChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.surfaceSoft,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  chainChipActive: {
    backgroundColor: COLORS.primaryMuted,
    borderColor: COLORS.primaryBorder,
  },
  chainChipName: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "700",
  },
  chainChipCount: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  tokenCard: {
    width: 86,
    alignItems: "center",
    backgroundColor: COLORS.surfaceSoft,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingVertical: 10,
    paddingHorizontal: 6,
    gap: 5,
  },
  tokenCardActive: {
    backgroundColor: COLORS.primaryMuted,
    borderColor: COLORS.primaryBorder,
  },
  tokenSym: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "800",
  },
  tokenPrice: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  resultBox: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  mutedText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
});
