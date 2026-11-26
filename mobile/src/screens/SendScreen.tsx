import React, { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type {
  BankItem,
  BankRatesResponse,
  ContactItem,
  GiftItem,
  GlobalRail,
  GlobalRecipient,
  ResolvedBankAccount,
  WithdrawalChain,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, RADIUS, SPACING, FONTS } from "../theme";
import {
  Button,
  Card,
  ErrorBanner,
  formatUsdc,
  Input,
  KeyValueRow,
  Pill,
  ScreenHeader,
  SectionHeader,
  shortAddr,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale } from "../components/Touch";
import { SendFlow } from "./SendFlow";
import { CryptoSendScreen } from "./CryptoSendScreen";

type SendMode = "user" | "wallet" | "ngn" | "global" | "crypto";

// Provider field keys (account_holder_name, swift_code...) shown as plain labels.
const FIELD_LABELS: Record<string, string> = {
  account_holder_name: "Account holder name",
  bank_code: "Bank code",
  bank_name: "Bank name",
  account_number: "Account number",
  routing_number: "Routing number",
  sort_code: "Sort code",
  iban: "IBAN",
  swift_code: "SWIFT / BIC code",
  bic: "SWIFT / BIC code",
  branch_code: "Branch code",
  ifsc: "IFSC code",
  clabe: "CLABE number",
  phone_number: "Phone number",
  email: "Email",
  address: "Address",
  city: "City",
  postal_code: "Postal code",
  country: "Country",
};
function humanizeField(raw: string): string {
  const key = String(raw || "").trim();
  if (FIELD_LABELS[key.toLowerCase()]) return FIELD_LABELS[key.toLowerCase()];
  if (!/[_]|^[a-z]+[A-Z]/.test(key)) return key;
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SendScreen({
  onBack,
  initialMode = "ngn",
  initialClaimToken = "",
}: {
  onBack: () => void;
  initialMode?: SendMode;
  initialClaimToken?: string;
}) {
  const { activeAccount, requestApproval } = useApp();
  const isBiz = activeAccount === "business";

  const [mode, setMode] = useState<SendMode>(initialMode === "ngn" ? "global" : initialMode);
  // The everyday sends (bank account, Proxim user) use the recipient-first flow; this screen
  // keeps the less common ones: abroad, crypto wallets and gift links.
  const [inFlow, setInFlow] = useState(!initialClaimToken && (initialMode === "ngn" || initialMode === "user"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // User & Gift state
  const [recipientQuery, setRecipientQuery] = useState("");
  const [lookupResult, setLookupResult] = useState<{
    id: string;
    username: string | null;
    displayName: string;
    isSelf: boolean;
  } | null>(null);
  const [userNotFound, setUserNotFound] = useState(false);
  const [userAmount, setUserAmount] = useState("");
  const [userNote, setUserNote] = useState("");
  const [pendingGifts, setPendingGifts] = useState<GiftItem[]>([]);
  const [claimInput, setClaimInput] = useState(initialClaimToken);

  // Wallet state
  const [walletAddr, setWalletAddr] = useState("");
  const [walletAmt, setWalletAmt] = useState("");
  const [walletNote, setWalletNote] = useState("");
  const [contacts, setContacts] = useState<ContactItem[]>([]);

  // Naira Bank state
  const [rates, setRates] = useState<BankRatesResponse | null>(null);
  const [banks, setBanks] = useState<BankItem[]>([]);
  const [bankQuery, setBankQuery] = useState("");
  const [selectedBank, setSelectedBank] = useState<BankItem | null>(null);
  const [acctNumber, setAcctNumber] = useState("");
  const [resolvedAcct, setResolvedAcct] = useState<ResolvedBankAccount | null>(null);
  const [ngnSendAmount, setNgnSendAmount] = useState("");
  const [ngnNarration, setNgnNarration] = useState("");

  const parseNum = (raw: string) => Number(String(raw || "").replace(/,/g, "").trim());

  // Global payout state
  const [rails, setRails] = useState<GlobalRail[]>([]);
  const [selectedRail, setSelectedRail] = useState<GlobalRail | null>(null);
  const [railQuery, setRailQuery] = useState("");
  const [showAllRails, setShowAllRails] = useState(false);
  const [globalRecipients, setGlobalRecipients] = useState<GlobalRecipient[]>([]);
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState<string | null>(null);
  const [globalAmount, setGlobalAmount] = useState("");
  const [globalFields, setGlobalFields] = useState<Record<string, string>>({});
  const [globalNote, setGlobalNote] = useState("");

  // Crypto withdraw & bridge state
  const [chains, setChains] = useState<WithdrawalChain[]>([]);
  const [feeUsd, setFeeUsd] = useState<number | null>(null);
  const [selectedChain, setSelectedChain] = useState<WithdrawalChain | null>(null);
  const [destAddr, setDestAddr] = useState("");
  const [cryptoAmt, setCryptoAmt] = useState("");
  const [bridgeDir, setBridgeDir] = useState<"arc_to_solana" | "solana_to_arc">("arc_to_solana");
  const [bridgeAmt, setBridgeAmt] = useState("");
  const [bridgeMoves, setBridgeMoves] = useState<{
    arcToSolana: Array<Record<string, unknown>>;
    solanaToArc: Array<Record<string, unknown>>;
  } | null>(null);

  useEffect(() => {
    api.getBankRates().then(setRates).catch(() => {});
  }, []);

  useEffect(() => {
    setError(null);
    if (mode === "user") {
      api.getBankRates().then(setRates).catch(() => {});
      api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => {});
    } else if (mode === "wallet") {
      api.listContacts().then((r) => setContacts(r.contacts || [])).catch(() => {});
    } else if (mode === "ngn") {
      api.getBankRates().then(setRates).catch(() => {});
      api.listBanks(bankQuery || undefined).then((r) => setBanks(r.banks || [])).catch(() => {});
    } else if (mode === "global") {
      api
        .listGlobalCorridors()
        .then((r) => {
          setRails(r.rails || []);
          if (!selectedRail && r.rails?.length) setSelectedRail(r.rails[0]);
        })
        .catch(() => {});
      api
        .listGlobalRecipients(undefined, activeAccount)
        .then((r) => setGlobalRecipients(r.recipients || []))
        .catch(() => {});
    } else if (mode === "crypto") {
      api
        .listWithdrawalChains()
        .then((r) => {
          setChains(r.chains || []);
          setFeeUsd(r.feeUsd);
          if (!selectedChain && r.chains?.length) setSelectedChain(r.chains[0]);
        })
        .catch(() => {});
      api.listBridgeMoves().then(setBridgeMoves).catch(() => {});
    }
  }, [mode, activeAccount]);

  useEffect(() => {
    if (mode !== "ngn") return;
    const t = setTimeout(() => {
      api.listBanks(bankQuery.trim() || undefined).then((r) => setBanks(r.banks || [])).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [bankQuery, mode]);

  const handleLookupUser = async () => {
    setError(null);
    setLookupResult(null);
    setUserNotFound(false);
    setLoading(true);
    try {
      const res = await api.lookupUser(recipientQuery.trim());
      setLookupResult(res.user);
    } catch {
      setUserNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSendToUser = async () => {
    const amtNgn = parseNum(userAmount);
    if (!recipientQuery.trim()) {
      setError("Enter a @username or phone number.");
      return;
    }
    if (!Number.isFinite(amtNgn) || amtNgn < 100) {
      setError("Enter an amount of at least ₦100.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("transfer.user", {
        accountType: activeAccount,
        recipient: recipientQuery.trim(),
        amountNgn: Math.round(amtNgn),
        narration: userNote.trim() || undefined,
      });
      setNotice(res.notice || "Transfer completed!");
      setUserAmount("");
      setUserNote("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transfer failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateGift = async () => {
    const amtNgn = parseNum(userAmount);
    if (!recipientQuery.trim()) {
      setError("Enter a @username for the gift link.");
      return;
    }
    if (!Number.isFinite(amtNgn) || amtNgn < 500) {
      setError("Enter an amount of at least ₦500.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("gift.create", {
        accountType: activeAccount,
        targetUsername: recipientQuery.trim(),
        amountNgn: Math.round(amtNgn),
      });
      setNotice(res.notice || "Gift link created!");
      setUserAmount("");
      if (res.shareText || res.claimUrl) {
        Share.share({ message: String(res.shareText || res.claimUrl) }).catch(() => {});
      }
      api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create gift link.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleClaimGift = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.claimGift(claimInput.trim());
      setNotice("Gift claimed into your Proxim balance!");
      setClaimInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not claim gift.");
    } finally {
      setLoading(false);
    }
  };

  const handleSendWallet = async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("transfer.wallet", {
        accountType: activeAccount,
        toAddress: walletAddr.trim(),
        amountUsdc: Number(walletAmt),
        narration: walletNote.trim() || undefined,
      });
      setNotice(res.notice || "Sent successfully!");
      setWalletAmt("");
      setWalletNote("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transfer failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResolveBank = async () => {
    if (!selectedBank) {
      setError("Pick a bank first.");
      return;
    }
    setError(null);
    setResolvedAcct(null);
    setLoading(true);
    try {
      const res = await api.resolveBankAccount(selectedBank.code, acctNumber.trim(), selectedBank.name);
      setResolvedAcct(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify bank account.");
    } finally {
      setLoading(false);
    }
  };

  // Check the account name as soon as all 10 digits are in, without waiting for a tap.
  useEffect(() => {
    if (mode !== "ngn" || !selectedBank || !/^\d{10}$/.test(acctNumber.trim())) return;
    if (resolvedAcct && resolvedAcct.accountNumber === acctNumber.trim()) return;
    const t = setTimeout(() => {
      handleResolveBank();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedBank?.code, acctNumber]);

  const handlePayoutNgn = async () => {
    if (!selectedBank) {
      setError("Select a Nigerian bank.");
      return;
    }
    if (acctNumber.trim().length !== 10) {
      setError("Enter a valid 10-digit account number.");
      return;
    }
    const amtNgn = parseNum(ngnSendAmount);
    if (!Number.isFinite(amtNgn) || amtNgn < 500) {
      setError("Enter an amount of at least ₦500.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("payout.ngn", {
        accountType: activeAccount,
        amountNgn: Math.round(amtNgn),
        bankCode: selectedBank.code,
        accountNumber: acctNumber.trim(),
        accountName: resolvedAcct?.accountName || undefined,
        narration: ngnNarration.trim() || undefined,
      });
      setNotice(res.notice || "Naira payout submitted!");
      setNgnSendAmount("");
      setNgnNarration("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Naira payout failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleGlobalPayout = async () => {
    if (!selectedRail) {
      setError("Select a destination currency rail.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        accountType: activeAccount,
        targetCurrency: selectedRail.currency,
        targetAmount: Number(globalAmount),
        railKey: selectedRail.railKey,
        narration: globalNote.trim() || undefined,
      };
      if (selectedCounterpartyId) {
        payload.savedCounterpartyId = selectedCounterpartyId;
      } else {
        payload.recipientDetails = globalFields;
      }
      const res = await requestApproval("payout.global", payload);
      setNotice(res.notice || "Global payout submitted!");
      setGlobalAmount("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Global payout failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCryptoWithdraw = async () => {
    if (!selectedChain) {
      setError("Select a destination network.");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("withdraw.crypto", {
        accountType: activeAccount,
        destinationChain: selectedChain.key,
        destinationAddress: destAddr.trim(),
        amountUsdc: Number(cryptoAmt),
      });
      setNotice(res.notice || "Cross-chain withdrawal started!");
      setCryptoAmt("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Withdrawal failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleBridgeMove = async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await requestApproval("bridge.move", {
        accountType: activeAccount,
        direction: bridgeDir,
        amountUsdc: Number(bridgeAmt),
      });
      setNotice(res.notice || "Internal chain move submitted!");
      setBridgeAmt("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Chain move failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Android Back from abroad / wallet / gift returns to the main Send flow.
  useEffect(() => {
    if (inFlow || initialClaimToken) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setInFlow(true);
      return true;
    });
    return () => sub.remove();
  }, [inFlow, initialClaimToken]);

  // Wallet and other-network sends use the token-picker crypto screen.
  if (!inFlow && (mode === "wallet" || mode === "crypto")) {
    return <CryptoSendScreen onBack={() => setInFlow(true)} />;
  }

  if (inFlow) {
    return (
      <SendFlow
        onBack={onBack}
        initialTab={initialMode === "user" ? "user" : "bank"}
        onMore={(m) => {
          setMode(m === "gift" ? "user" : m);
          setInFlow(false);
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={mode === "global" ? "Send abroad" : mode === "user" ? "Gift links" : "Send to a wallet"}
        subtitle={`From your ${isBiz ? "business" : "personal"} balance`}
        onBack={() => (initialClaimToken ? onBack() : setInFlow(true))}
      />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.pillRow}>
          <Pill label="Abroad" active={mode === "global"} onPress={() => setMode("global")} />
          <Pill label="Gift link" active={mode === "user"} onPress={() => setMode("user")} />
        </View>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {mode === "ngn" ? (
          <Card>
            <SectionHeader
              title="Cash out to Nigerian Bank"
              right={
                rates?.offRampRate ? (
                  <Text style={styles.rateTag}>$1 = ₦{rates.offRampRate.toLocaleString("en-NG")}</Text>
                ) : null
              }
            />
            <Input
              label="Search bank"
              placeholder="e.g. GTBank, OPay, Kuda, Access…"
              value={bankQuery}
              onChangeText={setBankQuery}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {banks.slice(0, 15).map((b) => (
                  <Pill
                    key={b.code}
                    label={b.name}
                    active={selectedBank?.code === b.code}
                    onPress={() => {
                      setSelectedBank(b);
                      setResolvedAcct(null);
                    }}
                  />
                ))}
              </View>
            </ScrollView>

            <Input
              label="10-digit Account Number"
              placeholder="0123456789"
              value={acctNumber}
              onChangeText={(t) => {
                setAcctNumber(t.replace(/\D/g, "").slice(0, 10));
                setResolvedAcct(null);
              }}
              keyboardType="number-pad"
              maxLength={10}
            />
            <Button
              title={resolvedAcct ? `Verified: ${resolvedAcct.accountName}` : "Verify Account Name"}
              variant="secondary"
              onPress={handleResolveBank}
              loading={loading}
              style={{ marginBottom: 14 }}
            />

            <Input
              label="Amount in Naira (₦)"
              placeholder="e.g. 25000"
              value={ngnSendAmount}
              onChangeText={(t) => setNgnSendAmount(t.replace(/[^0-9.]/g, ""))}
              keyboardType="numeric"
              hint={
                rates?.offRampRate && parseNum(ngnSendAmount) > 0
                  ? `≈ $${(parseNum(ngnSendAmount) / rates.offRampRate).toFixed(2)} USD from your balance`
                  : "Minimum ₦500 · Converted live at checkout"
              }
            />
            <Input
              label="Narration (optional)"
              placeholder="Payment reference"
              value={ngnNarration}
              onChangeText={setNgnNarration}
            />
            <Button title="Review and approve" onPress={handlePayoutNgn} loading={loading} />
          </Card>
        ) : null}

        {mode === "user" ? (
          <>
            <Card>
              <SectionHeader
                title="Send to @username or phone"
                right={
                  rates?.offRampRate ? (
                    <Text style={styles.rateTag}>$1 = ₦{rates.offRampRate.toLocaleString("en-NG")}</Text>
                  ) : null
                }
              />
              <Input
                label="Recipient (@username or +phone)"
                placeholder="@ada or +2348012345678"
                value={recipientQuery}
                onChangeText={(t) => {
                  setRecipientQuery(t);
                  setLookupResult(null);
                  setUserNotFound(false);
                }}
                autoCapitalize="none"
              />
              <Button
                title="Look up Proxim user"
                variant="secondary"
                onPress={handleLookupUser}
                loading={loading}
                style={{ marginBottom: 14 }}
              />

              {lookupResult ? (
                <View style={styles.verifiedBox}>
                  <Text style={styles.verifiedText}>
                    Found: {lookupResult.displayName} {lookupResult.username ? `(@${lookupResult.username})` : ""}
                  </Text>
                </View>
              ) : null}
              {userNotFound ? (
                <View style={styles.giftHintBox}>
                  <Text style={styles.giftHintText}>
                    Not on Proxim yet — you can send a claimable Gift Link to this @username below.
                  </Text>
                </View>
              ) : null}

              <Input
                label="Amount in Naira (₦)"
                placeholder="e.g. 15000"
                value={userAmount}
                onChangeText={(t) => setUserAmount(t.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
                hint={
                  rates?.offRampRate && parseNum(userAmount) > 0
                    ? `≈ $${(parseNum(userAmount) / rates.offRampRate).toFixed(2)} USD from your balance`
                    : userNotFound
                      ? "Converted live from Naira at checkout"
                      : "Minimum ₦100 · Instant & free"
                }
              />
              <Input
                label="Note (optional)"
                placeholder="Dinner split"
                value={userNote}
                onChangeText={setUserNote}
              />

              {userNotFound ? (
                <Button title="Create Claimable Gift Link" onPress={handleCreateGift} loading={loading} />
              ) : (
                <Button title="Review and approve" onPress={handleSendToUser} loading={loading} />
              )}
            </Card>

            <Card>
              <SectionHeader title="Claim a Gift Link" />
              <Input
                label="Gift claim code or link"
                placeholder="Paste gift token or URL"
                value={claimInput}
                onChangeText={setClaimInput}
                autoCapitalize="none"
              />
              <Button title="Claim into balance" variant="secondary" onPress={handleClaimGift} loading={loading} />

              {pendingGifts.length > 0 ? (
                <View style={{ marginTop: 14 }}>
                  <SectionHeader title="Your Pending Sent Gifts" />
                  {pendingGifts.map((g) => (
                    <View key={g.id} style={styles.listRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>@{g.targetHandle}</Text>
                        <Text style={styles.rowSub}>
                          {rates?.offRampRate
                            ? `₦${Math.round(g.amountUsdc * rates.offRampRate).toLocaleString("en-NG")} (${formatUsdc(g.amountUsdc)}) · ${g.status}`
                            : `${formatUsdc(g.amountUsdc)} · ${g.status}`}
                        </Text>
                      </View>
                      <Button
                        title="Cancel"
                        variant="danger"
                        onPress={() =>
                          requestApproval("gift.cancel", { claimToken: g.claimToken })
                            .then(() => {
                              setNotice("Gift cancelled & refunded.");
                              api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => {});
                            })
                            .catch((e) => !/cancel/i.test(String(e?.message)) && setError(e.message))
                        }
                        style={{ height: 34, paddingHorizontal: 12 }}
                      />
                    </View>
                  ))}
                </View>
              ) : null}
            </Card>
          </>
        ) : null}

        {mode === "wallet" ? (
          <Card>
            <SectionHeader title="Send to a wallet address" />
            {contacts.filter((c) => c.walletAddress).length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {contacts
                    .filter((c) => c.walletAddress)
                    .map((c) => (
                      <Pill
                        key={c.name}
                        label={c.name}
                        active={walletAddr.toLowerCase() === c.walletAddress?.toLowerCase()}
                        onPress={() => setWalletAddr(c.walletAddress || "")}
                      />
                    ))}
                </View>
              </ScrollView>
            ) : null}
            <Input
              label="Wallet address"
              placeholder="0x..."
              value={walletAddr}
              onChangeText={setWalletAddr}
              autoCapitalize="none"
            />
            <Input
              label="Amount (USD)"
              placeholder="e.g. 25"
              value={walletAmt}
              onChangeText={setWalletAmt}
              keyboardType="decimal-pad"
            />
            <Input
              label="Narration (optional)"
              placeholder="Reference"
              value={walletNote}
              onChangeText={setWalletNote}
            />
            <Button title="Review and approve" onPress={handleSendWallet} loading={loading} />
            <Button
              title="Sending on Solana, Base or another network?"
              variant="ghost"
              onPress={() => setMode("crypto")}
              style={{ marginTop: 6 }}
            />
          </Card>
        ) : null}

        {mode === "global" ? (
          <Card>
            <SectionHeader title="Choose destination currency" currency={false} />
            <Input
              label="Search country or currency"
              placeholder="GBP, EUR, USD, Canada, Kenya, Ghana…"
              value={railQuery}
              onChangeText={(v) => {
                setRailQuery(v);
                if (v.trim()) setShowAllRails(true);
              }}
              currency={false}
            />

            {(() => {
              const q = railQuery.trim().toLowerCase();
              const filteredRails = q
                ? rails.filter(
                    (r) =>
                      r.currency.toLowerCase().includes(q) ||
                      (r.country || "").toLowerCase().includes(q) ||
                      (r.label || "").toLowerCase().includes(q)
                  )
                : rails;
              const visibleRails = showAllRails || q ? filteredRails : filteredRails.slice(0, 8);
              const hiddenCount = Math.max(0, filteredRails.length - visibleRails.length);
              return (
                <>
                  <View style={styles.currencyGrid}>
                    {visibleRails.map((r) => {
                      const active = selectedRail?.railKey === r.railKey;
                      return (
                        <PressableScale
                          key={r.railKey}
                          haptic="selection"
                          depth={0.96}
                          style={[styles.currencyTile, active && styles.currencyTileOn]}
                          onPress={() => {
                            setSelectedRail(r);
                            setSelectedCounterpartyId(null);
                            setGlobalFields({});
                          }}
                        >
                          <CurrencyLogo code={r.currency} size={28} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.currencyCode, active && { color: COLORS.primaryDark }]}>
                              {r.currency}
                            </Text>
                            <Text style={styles.currencyCountry} numberOfLines={1}>
                              {r.country || r.label}
                            </Text>
                          </View>
                          {active ? (
                            <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} />
                          ) : null}
                        </PressableScale>
                      );
                    })}
                  </View>

                  {filteredRails.length === 0 ? (
                    <Text style={[styles.fieldHint, { marginBottom: 10 }]}>
                      No countries match "{railQuery}". Try GBP, EUR, USD, CAD, or KES.
                    </Text>
                  ) : null}

                  {!q && filteredRails.length > 8 ? (
                    <Button
                      title={showAllRails ? "Show fewer currencies" : `Show all ${filteredRails.length} currencies (+${hiddenCount} more)`}
                      variant="ghost"
                      onPress={() => setShowAllRails((prev) => !prev)}
                      style={{ marginBottom: 10 }}
                    />
                  ) : null}
                </>
              );
            })()}

            {selectedRail ? (
              <View style={styles.selectedRailBanner}>
                <CurrencyLogo code={selectedRail.currency} size={26} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.selectedRailTitle}>
                    Sending {selectedRail.currency} · {selectedRail.country}
                  </Text>
                  <Text style={styles.selectedRailSub}>{selectedRail.label}</Text>
                </View>
              </View>
            ) : null}

            {globalRecipients.filter((g) => !selectedRail || g.currency === selectedRail.currency).length > 0 ? (
              <View style={{ marginBottom: 12 }}>
                <Text style={styles.fieldHint}>Saved recipients</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {globalRecipients
                      .filter((g) => !selectedRail || g.currency === selectedRail.currency)
                      .map((g) => (
                        <Pill
                          key={g.counterpartyId}
                          label={`${g.label} ${g.accountTail ? `••${g.accountTail}` : ""}`}
                          active={selectedCounterpartyId === g.counterpartyId}
                          onPress={() =>
                            setSelectedCounterpartyId(
                              selectedCounterpartyId === g.counterpartyId ? null : g.counterpartyId
                            )
                          }
                        />
                      ))}
                  </View>
                </ScrollView>
              </View>
            ) : null}

            <Input
              label={`Amount they receive (${selectedRail?.currency || "currency"})`}
              placeholder="e.g. 100"
              value={globalAmount}
              onChangeText={setGlobalAmount}
              keyboardType="decimal-pad"
            />

            {!selectedCounterpartyId && selectedRail ? (
              (selectedRail.requiredFields || []).map((f, idx) => {
                const key = typeof f === "string" ? f : f.key || f.name || `field_${idx}`;
                const label = humanizeField(typeof f === "string" ? f : f.label || key);
                return (
                  <Input
                    key={key}
                    label={label}
                    placeholder={typeof f === "object" ? f.placeholder || "" : ""}
                    value={globalFields[key] || ""}
                    onChangeText={(v) => setGlobalFields((prev) => ({ ...prev, [key]: v }))}
                  />
                );
              })
            ) : null}

            <Input
              label="Reference (optional)"
              placeholder="Invoice or memo"
              value={globalNote}
              onChangeText={setGlobalNote}
            />
            <Button title="Quote & approve payout" onPress={handleGlobalPayout} loading={loading} />
          </Card>
        ) : null}

        {mode === "crypto" ? (
          <>
            <Card>
              <SectionHeader
                title="Send on another network"
                right={feeUsd !== null ? <Text style={styles.rateTag}>Fee: ${feeUsd.toFixed(2)}</Text> : null}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {chains.map((c) => (
                    <Pill
                      key={c.key}
                      label={c.label}
                      active={selectedChain?.key === c.key}
                      onPress={() => setSelectedChain(c)}
                    />
                  ))}
                </View>
              </ScrollView>
              <Input
                label={`Destination ${selectedChain?.name || ""} Address`}
                placeholder={selectedChain?.example || "Address"}
                value={destAddr}
                onChangeText={setDestAddr}
                autoCapitalize="none"
              />
              <Input
                label="Amount (USD)"
                placeholder="e.g. 20"
                value={cryptoAmt}
                onChangeText={setCryptoAmt}
                keyboardType="decimal-pad"
              />
              <Button title="Review and approve withdrawal" onPress={handleCryptoWithdraw} loading={loading} />
            </Card>

          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: SPACING.md },
  rateTag: { color: COLORS.primary, fontSize: 12, fontFamily: FONTS.bold },
  verifiedBox: {
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    borderRadius: RADIUS.sm,
    padding: 10,
    marginBottom: 12,
  },
  verifiedText: { color: COLORS.successText, fontSize: 13, fontFamily: FONTS.semibold },
  giftHintBox: {
    backgroundColor: COLORS.businessMuted,
    borderWidth: 1,
    borderColor: COLORS.businessBorder,
    borderRadius: RADIUS.sm,
    padding: 10,
    marginBottom: 12,
  },
  giftHintText: { color: COLORS.warningText, fontFamily: FONTS.regular, fontSize: 12, lineHeight: 18 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  rowTitle: { color: COLORS.text, fontSize: 14, fontFamily: FONTS.semibold },
  rowSub: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 12 },
  fieldHint: { color: COLORS.textSecondary, fontSize: 12, fontFamily: FONTS.semibold, marginBottom: 6 },
  currencyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  currencyTile: {
    ...DEPTH.raised,
    flexBasis: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.page,
  },
  currencyTileOn: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    backgroundColor: COLORS.deep,
  },
  currencyCode: { color: COLORS.text, fontSize: 14, fontFamily: FONTS.extrabold },
  currencyCountry: { color: COLORS.textSecondary, fontSize: 11, fontFamily: FONTS.medium, marginTop: 1 },
  selectedRailBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
    borderRadius: RADIUS.md,
    padding: 10,
    marginBottom: 12,
  },
  selectedRailTitle: { color: COLORS.primaryDark, fontSize: 13, fontFamily: FONTS.bold },
  selectedRailSub: { color: COLORS.textSecondary, fontSize: 11, fontFamily: FONTS.medium, marginTop: 1 },
});
