import React, { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type {
  CryptoDepositIntentResponse,
  CryptoDepositTokensResponse,
  NgnDepositOrder,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, SPACING } from "../theme";
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

type Method = "ngn" | "crypto" | "card";
type IntentChain = "near" | "solana" | "robinhood" | "starknet";

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

  // Crypto state
  const [cryptoMeta, setCryptoMeta] = useState<CryptoDepositTokensResponse | null>(null);
  const [intentChain, setIntentChain] = useState<IntentChain>("solana");
  const [symbol, setSymbol] = useState("USDC");
  const [cryptoAmount, setCryptoAmount] = useState("");
  const [cryptoIntent, setCryptoIntent] = useState<CryptoDepositIntentResponse | null>(null);
  const [cryptoLiveStatus, setCryptoLiveStatus] = useState<string | null>(null);

  useEffect(() => {
    setNgnOrder(null);
    setCryptoIntent(null);
    if (method === "crypto") {
      api
        .listCryptoDepositTokens(activeAccount)
        .then((res) => {
          setCryptoMeta(res);
          const first = res.intents?.[intentChain]?.[0]?.symbol;
          if (first) setSymbol(first);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load crypto deposit addresses."));
    }
  }, [method, activeAccount, intentChain]);

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
    const amt = Number(cryptoAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid crypto deposit amount.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.createCryptoDepositIntent({
        chain: intentChain,
        symbol,
        amount: amt,
        accountType: activeAccount,
      });
      setCryptoIntent(res);
      setCryptoLiveStatus(res.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create cross-chain deposit address.");
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
        setNotice("Crypto deposit settled into your wallet!");
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
          ? `Swept ${res.swept.length} EVM deposit(s) into your ${activeAccount} wallet.`
          : "No pending EVM deposits found to sweep."
      );
      bumpDataVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sweep failed.");
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

  const intentTokens = cryptoMeta?.intents?.[intentChain] || [];

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Add money"
        subtitle={`Depositing into ${isBiz ? "Business" : "Personal"} wallet`}
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
            DESTINATION WALLET: {isBiz ? "BUSINESS ACCOUNT" : "PERSONAL ACCOUNT"}
          </Text>
          <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 2 }}>
            Funds added on this screen credit your {isBiz ? "Business" : "Personal"} balance only.
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
            <SectionHeader title="Naira Bank Transfer (Paj)" />
            <Input
              label="Amount in Naira (NGN)"
              placeholder="e.g. 50000"
              value={amountNgn}
              onChangeText={(t) => setAmountNgn(t.replace(/[^\d.]/g, ""))}
              keyboardType="numeric"
              hint="Minimum ₦500. You will get a dedicated one-time bank account to transfer to."
            />
            <Button
              title="Get bank account to pay into"
              onPress={handleCreateNgnDeposit}
              loading={loading}
            />

            {ngnOrder ? (
              <View style={styles.resultBox}>
                <SectionHeader title={`Virtual Account · ${ngnStatus || ngnOrder.status}`} />
                <KeyValueRow
                  label="Bank"
                  value={ngnOrder.virtualAccount.bankName || "—"}
                />
                <KeyValueRow
                  label="Account Number"
                  value={ngnOrder.virtualAccount.accountNumber || "—"}
                  onCopy={
                    ngnOrder.virtualAccount.accountNumber
                      ? () => copy("Account number", ngnOrder.virtualAccount.accountNumber!)
                      : undefined
                  }
                />
                <KeyValueRow
                  label="Account Name"
                  value={ngnOrder.virtualAccount.accountName || "—"}
                />
                <KeyValueRow
                  label="Exact Amount"
                  value={formatNgn(ngnOrder.virtualAccount.amountNgn)}
                />
                {ngnOrder.estimatedUsdc ? (
                  <KeyValueRow
                    label="Estimated Credit"
                    value={`~$${Number(ngnOrder.estimatedUsdc).toFixed(2)} USDC`}
                  />
                ) : null}
                <KeyValueRow label="Settlement Rail" value={ngnOrder.settlementRail.toUpperCase()} />
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
              <SectionHeader title={`Direct ${isBiz ? "Business" : "Personal"} Deposit Addresses`} />
              {cryptoMeta ? (
                <>
                  <KeyValueRow
                    label="Arc / Base / EVM"
                    value={cryptoMeta.directAddresses.arc || "Unavailable"}
                    onCopy={
                      cryptoMeta.directAddresses.arc
                        ? () => copy("EVM address", cryptoMeta.directAddresses.arc!)
                        : undefined
                    }
                  />
                  <KeyValueRow
                    label="Solana USDC"
                    value={cryptoMeta.directAddresses.solana || "Complete one PIN action to initialize"}
                    onCopy={
                      cryptoMeta.directAddresses.solana
                        ? () => copy("Solana address", cryptoMeta.directAddresses.solana!)
                        : undefined
                    }
                  />
                  <Button
                    title="Sweep Pending EVM Deposits"
                    variant="secondary"
                    onPress={handleSweepEvm}
                    loading={loading}
                    style={{ marginTop: 12 }}
                  />
                </>
              ) : (
                <Text style={styles.mutedText}>Loading live addresses…</Text>
              )}
            </Card>

            <Card>
              <SectionHeader title="Cross-Chain Deposit (NEAR Intents)" />
              <View style={styles.methodRow}>
                {(["solana", "near", "robinhood", "starknet"] as IntentChain[]).map((c) => (
                  <Pill
                    key={c}
                    label={c.toUpperCase()}
                    active={intentChain === c}
                    onPress={() => {
                      setIntentChain(c);
                      setCryptoIntent(null);
                    }}
                  />
                ))}
              </View>

              {intentTokens.length > 0 ? (
                <View style={styles.methodRow}>
                  {intentTokens.slice(0, 8).map((tk) => (
                    <Pill
                      key={tk.symbol}
                      label={tk.symbol}
                      active={symbol === tk.symbol}
                      onPress={() => setSymbol(tk.symbol)}
                    />
                  ))}
                </View>
              ) : (
                <Input
                  label="Token Symbol"
                  value={symbol}
                  onChangeText={(t) => setSymbol(t.toUpperCase())}
                  autoCapitalize="characters"
                />
              )}

              <Input
                label={`Amount (${symbol})`}
                placeholder="e.g. 25"
                value={cryptoAmount}
                onChangeText={setCryptoAmount}
                keyboardType="decimal-pad"
              />
              <Button
                title="Get one-time deposit address"
                onPress={handleCreateCryptoIntent}
                loading={loading}
              />

              {cryptoIntent ? (
                <View style={styles.resultBox}>
                  <SectionHeader title={`Intent #${cryptoIntent.depositId} · ${cryptoLiveStatus || cryptoIntent.status}`} />
                  <KeyValueRow
                    label="Deposit Address"
                    value={cryptoIntent.depositAddress}
                    onCopy={() => copy("Deposit address", cryptoIntent.depositAddress)}
                  />
                  {cryptoIntent.depositMemo ? (
                    <KeyValueRow
                      label="Memo"
                      value={cryptoIntent.depositMemo}
                      onCopy={() => copy("Memo", cryptoIntent.depositMemo!)}
                    />
                  ) : null}
                  <KeyValueRow
                    label="Send Exact Amount"
                    value={`${cryptoIntent.amount} ${cryptoIntent.symbol}`}
                  />
                  <Button
                    title="Check Conversion Status"
                    variant="secondary"
                    onPress={handleCheckCryptoStatus}
                    loading={loading}
                    style={{ marginTop: 12 }}
                  />
                </View>
              ) : null}
            </Card>
          </>
        ) : null}

        {method === "card" ? (
          <Card>
            <SectionHeader title="Debit Card & Apple Pay" />
            <Text style={styles.mutedText}>
              Buy USDC directly into your {isBiz ? "Business" : "Personal"} Proxim wallet with a
              debit card or Apple Pay via our live onramp checkout.
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
