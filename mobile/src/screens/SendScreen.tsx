import React, { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type {
  BankItem,
  BankRatesResponse,
  ContactItem,
  GiftItem,
  GlobalCorridor,
  GlobalRail,
  GlobalRailField,
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

const POPULAR_INTERNATIONAL_BANKS: Record<string, Array<{ code: string; name: string }>> = {
  GHS: [
    { code: "030100", name: "GCB Bank" },
    { code: "130100", name: "Ecobank" },
    { code: "040100", name: "Stanbic Bank" },
    { code: "020100", name: "Absa Bank" },
    { code: "240100", name: "Fidelity Bank" },
    { code: "120100", name: "Zenith Bank" },
    { code: "010100", name: "Standard Chartered" },
    { code: "280100", name: "Access Bank" },
    { code: "140100", name: "CalBank" },
  ],
  TZS: [
    { code: "015", name: "CRDB Bank" },
    { code: "012", name: "NMB Bank" },
    { code: "011", name: "NBC Bank" },
    { code: "041", name: "Stanbic Tanzania" },
    { code: "002", name: "Standard Chartered" },
    { code: "021", name: "DTB Tanzania" },
    { code: "017", name: "Exim Bank" },
    { code: "026", name: "KCB Tanzania" },
    { code: "051", name: "Equity Bank" },
  ],
  KES: [
    { code: "01", name: "KCB Bank" },
    { code: "68", name: "Equity Bank" },
    { code: "11", name: "Co-op Bank" },
    { code: "02", name: "Standard Chartered" },
    { code: "03", name: "Absa Kenya" },
    { code: "07", name: "NCBA Bank" },
    { code: "31", name: "Stanbic Kenya" },
    { code: "63", name: "DTB Kenya" },
  ],
  UGX: [
    { code: "040147", name: "Stanbic Uganda" },
    { code: "020100", name: "Centenary Bank" },
    { code: "010100", name: "Standard Chartered" },
    { code: "030100", name: "Absa Uganda" },
    { code: "060100", name: "DFCU Bank" },
    { code: "140100", name: "Equity Uganda" },
  ],
  ZAR: [
    { code: "250655", name: "FNB" },
    { code: "051001", name: "Standard Bank" },
    { code: "632005", name: "ABSA" },
    { code: "198765", name: "Nedbank" },
    { code: "470010", name: "Capitec" },
    { code: "580105", name: "Investec" },
  ],
};

// Provider field keys (account_holder_name, swift_bic...) shown as plain labels.
const FIELD_LABELS: Record<string, string> = {
  account_holder_name: "Recipient full name",
  bank_code: "Bank code",
  bank_name: "Bank name",
  account_number: "Account number",
  routing_number: "Routing number (ABA 9 digits)",
  sort_code: "Sort code (6 digits)",
  iban: "IBAN",
  swift_code: "SWIFT / BIC code",
  swift_bic: "SWIFT / BIC code",
  bic: "SWIFT / BIC code",
  branch_code: "Branch code",
  bank_institution_number: "Institution number (3 digits)",
  transit_number: "Transit number (5 digits)",
  scheme: "Mobile money network",
  ifsc: "IFSC code",
  clabe: "CLABE number (18 digits)",
  phone_number: "Phone number",
  email: "Email address",
  address: "Address",
  bank_address_line1: "Bank street address",
  bank_address_city: "Bank city",
  bank_address_state: "Bank state (2-letter)",
  bank_address_postal_code: "Bank postal / ZIP code",
  city: "City",
  postal_code: "Postal code",
  country: "Bank country (2-letter ISO)",
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
  const [corridors, setCorridors] = useState<GlobalCorridor[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);
  const [selectedRail, setSelectedRail] = useState<GlobalRail | null>(null);
  const [railQuery, setRailQuery] = useState("");
  const [showAllRails, setShowAllRails] = useState(false);
  const [globalRecipients, setGlobalRecipients] = useState<GlobalRecipient[]>([]);
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState<string | null>(null);
  const [globalAmount, setGlobalAmount] = useState("");
  const [globalFields, setGlobalFields] = useState<Record<string, string>>({});
  const [globalNote, setGlobalNote] = useState("");
  const [liveGlobalBanks, setLiveGlobalBanks] = useState<
    Array<{ code: string; name: string; swiftBic?: string | null; institutionNumber?: string | null }>
  >([]);
  const [globalBankQuery, setGlobalBankQuery] = useState("");

  useEffect(() => {
    const cur = selectedRail?.currency;
    const needsBankDir = Boolean(
      cur &&
        (selectedRail?.requiredFields || []).some((f) => {
          const k = typeof f === "string" ? f : f.key || f.name || "";
          return k === "bank_code" || k === "bank_institution_number";
        })
    );
    if (!needsBankDir || !cur) {
      setLiveGlobalBanks([]);
      setGlobalBankQuery("");
      return;
    }
    let cancelled = false;
    api
      .getGlobalBankCodes(cur)
      .then((res) => {
        if (!cancelled) setLiveGlobalBanks(res.banks || []);
      })
      .catch(() => {
        if (!cancelled) setLiveGlobalBanks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRail?.railKey, selectedRail?.currency]);

  const selectGlobalRail = (rail: GlobalRail, defaultCountry?: string | null) => {
    setSelectedRail(rail);
    setSelectedCounterpartyId(null);
    const defaults: Record<string, string> = {};
    const fields = rail.requiredFields || [];
    for (const f of fields) {
      const key = typeof f === "string" ? f : f.key || f.name || "";
      if (key === "country" && (rail.country || defaultCountry)) {
        defaults.country = String(rail.country || defaultCountry).toUpperCase();
      } else if (key === "scheme") {
        const opts = (typeof f === "object" && Array.isArray(f.options) ? f.options : rail.schemeOptions) || [];
        if (opts.length > 0) defaults.scheme = opts[0];
      }
    }
    setGlobalFields(defaults);
  };

  const selectGlobalCorridor = (cor: GlobalCorridor) => {
    setSelectedCurrency(cor.currency);
    if (cor.rails.length > 0) {
      selectGlobalRail(cor.rails[0], cor.country);
    } else {
      setSelectedRail(null);
      setGlobalFields({});
    }
  };

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
    api.getBankRates().then(setRates).catch(() => { });
  }, []);

  useEffect(() => {
    setError(null);
    if (mode === "user") {
      api.getBankRates().then(setRates).catch(() => { });
      api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => { });
    } else if (mode === "wallet") {
      api.listContacts().then((r) => setContacts(r.contacts || [])).catch(() => { });
    } else if (mode === "ngn") {
      api.getBankRates().then(setRates).catch(() => { });
      api.listBanks(bankQuery || undefined).then((r) => setBanks(r.banks || [])).catch(() => { });
    } else if (mode === "global") {
      api
        .listGlobalCorridors()
        .then((r) => {
          let nextCorridors: GlobalCorridor[] = Array.isArray(r.corridors) ? r.corridors : [];
          // Backward compatibility if server returned flat rails[] only
          if (!nextCorridors.length && Array.isArray(r.rails)) {
            const byCur = new Map<string, GlobalCorridor>();
            for (const rail of r.rails) {
              if (!rail.currency || rail.currency === "*") continue;
              const cur = rail.currency.toUpperCase();
              if (!byCur.has(cur)) {
                byCur.set(cur, {
                  currency: cur,
                  name: rail.currencyName || cur,
                  symbol: `${cur} `,
                  country: rail.country || cur.slice(0, 2),
                  region: "other",
                  rails: [],
                });
              }
              byCur.get(cur)!.rails.push(rail);
            }
            nextCorridors = [...byCur.values()];
          }
          setCorridors(nextCorridors);
          if (nextCorridors.length > 0) {
            const curMatch = selectedCurrency ? nextCorridors.find((c) => c.currency === selectedCurrency) : null;
            const initial = curMatch || nextCorridors.find((c) => c.currency === "GBP") || nextCorridors[0];
            if (!selectedRail || !curMatch) {
              selectGlobalCorridor(initial);
            }
          }
        })
        .catch(() => { });
      api
        .listGlobalRecipients(undefined, activeAccount)
        .then((r) => setGlobalRecipients(r.recipients || []))
        .catch(() => { });
    } else if (mode === "crypto") {
      api
        .listWithdrawalChains()
        .then((r) => {
          setChains(r.chains || []);
          setFeeUsd(r.feeUsd);
          if (!selectedChain && r.chains?.length) setSelectedChain(r.chains[0]);
        })
        .catch(() => { });
      api.listBridgeMoves().then(setBridgeMoves).catch(() => { });
    }
  }, [mode, activeAccount]);

  useEffect(() => {
    if (mode !== "ngn") return;
    const t = setTimeout(() => {
      api.listBanks(bankQuery.trim() || undefined).then((r) => setBanks(r.banks || [])).catch(() => { });
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
        Share.share({ message: String(res.shareText || res.claimUrl) }).catch(() => { });
      }
      api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => { });
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
      setError("Select a destination currency and transfer method.");
      return;
    }
    const amt = parseNum(globalAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError(`Enter a valid ${selectedRail.currency} amount.`);
      return;
    }
    if (selectedRail.minAmount && amt < selectedRail.minAmount) {
      setError(`Minimum for ${selectedRail.label} is ${selectedRail.minAmount.toLocaleString("en-US")} ${selectedRail.currency}.`);
      return;
    }
    if (selectedRail.maxAmount && amt > selectedRail.maxAmount) {
      setError(`Maximum for ${selectedRail.label} is ${selectedRail.maxAmount.toLocaleString("en-US")} ${selectedRail.currency}.`);
      return;
    }
    if (!selectedCounterpartyId) {
      for (const f of selectedRail.requiredFields || []) {
        const key = typeof f === "string" ? f : f.key || f.name || "";
        const lbl = typeof f === "object" && f.label ? f.label : humanizeField(key);
        if (key && !String(globalFields[key] || "").trim()) {
          setError(`Enter ${lbl} for ${selectedRail.label}.`);
          return;
        }
      }
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        accountType: activeAccount,
        targetCurrency: selectedRail.currency,
        targetAmount: amt,
        railKey: selectedRail.railKey,
        narration: globalNote.trim() || undefined,
      };
      if (selectedCounterpartyId) {
        payload.savedCounterpartyId = selectedCounterpartyId;
      } else {
        const trimmed: Record<string, string> = {};
        for (const [k, v] of Object.entries(globalFields)) {
          if (String(v || "").trim()) trimmed[k] = String(v).trim();
        }
        payload.recipientDetails = trimmed;
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
                  <Text style={styles.rateTag}>
            $1 = ₦{Number(rates.offRampRate).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
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
              label="Description / Narration (optional)"
              placeholder="What is this transfer for? (e.g. Rent, groceries)"
              value={ngnNarration}
              onChangeText={setNgnNarration}
              hint="Shown on your transfer receipt and bank alert"
            />
            <Button title="Review and approve" onPress={handlePayoutNgn} loading={loading} style={{ marginTop: 4 }} />
          </Card>
        ) : null}

        {mode === "user" ? (
          <>
            <Card>
              <SectionHeader
                title="Send to @username or phone"
                right={
                  rates?.offRampRate ? (
                    <Text style={styles.rateTag}>
            $1 = ₦{Number(rates.offRampRate).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
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
                              api.listPendingGifts().then((r) => setPendingGifts(r.gifts || [])).catch(() => { });
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
            <SectionHeader title="1. Choose destination currency" currency={false} />
            <Input
              label="Search country or currency"
              placeholder="GBP, EUR, USD, Canada, Kenya, Ghana, UAE…"
              value={railQuery}
              onChangeText={(v) => {
                setRailQuery(v);
                if (v.trim()) setShowAllRails(true);
              }}
              currency={false}
            />

            {(() => {
              const q = railQuery.trim().toLowerCase();
              const filteredCorridors = q
                ? corridors.filter(
                  (c) =>
                    c.currency.toLowerCase().includes(q) ||
                    c.name.toLowerCase().includes(q) ||
                    c.country.toLowerCase().includes(q) ||
                    c.rails.some((r) => (r.label || "").toLowerCase().includes(q))
                )
                : corridors;
              const visibleCorridors = showAllRails || q ? filteredCorridors : filteredCorridors.slice(0, 8);
              const hiddenCount = Math.max(0, filteredCorridors.length - visibleCorridors.length);
              const activeCorridor = corridors.find((c) => c.currency === selectedCurrency) || null;

              return (
                <>
                  <View style={styles.currencyGrid}>
                    {visibleCorridors.map((cor) => {
                      const active = selectedCurrency === cor.currency;
                      return (
                        <PressableScale
                          key={cor.currency}
                          haptic="selection"
                          depth={0.96}
                          style={[styles.currencyTile, active && styles.currencyTileOn]}
                          onPress={() => selectGlobalCorridor(cor)}
                        >
                          <CurrencyLogo code={cor.currency} size={28} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.currencyCode, active && { color: COLORS.primaryDark }]}>
                              {cor.currency}
                            </Text>
                            <Text style={styles.currencyCountry} numberOfLines={1}>
                              {cor.name}
                            </Text>
                          </View>
                          {active ? (
                            <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} />
                          ) : null}
                        </PressableScale>
                      );
                    })}
                  </View>

                  {filteredCorridors.length === 0 ? (
                    <Text style={[styles.fieldHint, { marginBottom: 10 }]}>
                      No countries match "{railQuery}". Try GBP, EUR, USD, CAD, AED, or KES.
                    </Text>
                  ) : null}

                  {!q && filteredCorridors.length > 8 ? (
                    <Button
                      title={
                        showAllRails
                          ? "Show fewer currencies"
                          : `Show all ${filteredCorridors.length} currencies (+${hiddenCount} more)`
                      }
                      variant="ghost"
                      onPress={() => setShowAllRails((prev) => !prev)}
                      style={{ marginBottom: 10 }}
                    />
                  ) : null}

                  {/* Step 2: Transfer rail / method selector when this currency has multiple rails */}
                  {activeCorridor && activeCorridor.rails.length > 1 ? (
                    <View style={{ marginBottom: 12 }}>
                      <Text style={styles.fieldHint}>2. Choose {activeCorridor.currency} transfer method</Text>
                      <View style={styles.pillRow}>
                        {activeCorridor.rails.map((r) => {
                          const shortLabel = r.label
                            .replace(new RegExp(`^${activeCorridor.currency}\\s+`, "i"), "")
                            .replace(/\s*\([^)]*\)$/, (m) => ` ${m.trim()}`);
                          return (
                            <Pill
                              key={r.railKey}
                              label={`${shortLabel}${r.settlement ? ` · ${r.settlement}` : ""}`}
                              active={selectedRail?.railKey === r.railKey}
                              onPress={() => selectGlobalRail(r, activeCorridor.country)}
                            />
                          );
                        })}
                      </View>
                    </View>
                  ) : null}
                </>
              );
            })()}

            {selectedRail ? (
              <View style={styles.selectedRailBanner}>
                <CurrencyLogo code={selectedRail.currency} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.selectedRailTitle}>
                    {selectedRail.currency} · {selectedRail.label}
                  </Text>
                  <Text style={styles.selectedRailSub}>
                    {[
                      selectedRail.settlement ? `Arrival: ${selectedRail.settlement}` : null,
                      selectedRail.minAmount ? `Min ${selectedRail.minAmount.toLocaleString("en-US")} ${selectedRail.currency}` : null,
                      selectedRail.maxAmount ? `Max ${selectedRail.maxAmount.toLocaleString("en-US")} ${selectedRail.currency}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </View>
            ) : null}

            {globalRecipients.filter((g) => !selectedRail || g.currency === selectedRail.currency).length > 0 ? (
              <View style={{ marginBottom: 12 }}>
                <Text style={styles.fieldHint}>Saved {selectedRail?.currency || ""} recipients</Text>
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
              key={`amt:${selectedRail?.railKey || "none"}`}
              label={`Amount they receive (${selectedRail?.currency || "currency"})`}
              currency={selectedRail?.currency || false}
              placeholder={selectedRail?.minAmount ? `Min ${selectedRail.minAmount}` : "e.g. 100"}
              value={globalAmount}
              onChangeText={(v) => setGlobalAmount(v.replace(/[^\d.]/g, ""))}
              keyboardType="decimal-pad"
            />
            <Text style={[styles.fieldHint, { marginTop: -4, marginBottom: 10 }]}>
              Recipient receives this exact amount. Proxim's fee (1%, capped at $0.50 under $100; 1% for $100+) and the partner network fee are calculated together on the confirmation screen.
            </Text>

            {!selectedCounterpartyId && selectedRail ? (
              <>
                <Text style={styles.fieldHint}>
                  Recipient {selectedRail.currency} bank details ({selectedRail.requiredFields.length} required)
                </Text>

                {(() => {
                  const bankList =
                    liveGlobalBanks.length > 0
                      ? liveGlobalBanks
                      : (POPULAR_INTERNATIONAL_BANKS[selectedRail.currency] || []).map((b) => ({
                          code: b.code,
                          name: b.name,
                          swiftBic: null,
                          institutionNumber: null,
                        }));
                  if (!bankList.length) return null;
                  const q = globalBankQuery.trim().toLowerCase();
                  const filtered = q
                    ? bankList.filter(
                        (b) =>
                          b.name.toLowerCase().includes(q) ||
                          (b.code || "").toLowerCase().includes(q)
                      )
                    : bankList;
                  return (
                    <View style={{ marginBottom: 14 }}>
                      <Text style={[styles.fieldHint, { color: COLORS.textSecondary }]}>
                        Select {selectedRail.currency} bank (auto-fills bank code):
                      </Text>
                      {bankList.length > 8 ? (
                        <Input
                          placeholder={`Search ${selectedRail.currency} bank (e.g. First Bank, Choice, Mwanga…)`}
                          value={globalBankQuery}
                          onChangeText={setGlobalBankQuery}
                          currency={false}
                        />
                      ) : null}
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          {filtered.slice(0, 20).map((b, i) => {
                            const effectiveCode = b.institutionNumber || b.code || "";
                            const isChosen =
                              (globalFields.bank_name || "").toLowerCase() === b.name.toLowerCase() ||
                              (effectiveCode && (globalFields.bank_code === effectiveCode || globalFields.bank_institution_number === effectiveCode));
                            return (
                              <Pill
                                key={`${b.code || b.name}-${i}`}
                                label={effectiveCode ? `${b.name} (${effectiveCode})` : b.name}
                                active={Boolean(isChosen)}
                                onPress={() => {
                                  setGlobalFields((prev) => ({
                                    ...prev,
                                    bank_name: b.name,
                                    ...(b.institutionNumber
                                      ? { bank_institution_number: b.institutionNumber }
                                      : effectiveCode
                                        ? { bank_code: effectiveCode }
                                        : {}),
                                    ...(b.swiftBic && (selectedRail.requiredFields || []).some((rf) => (typeof rf === "string" ? rf : rf.key) === "swift_bic")
                                      ? { swift_bic: b.swiftBic }
                                      : {}),
                                  }));
                                }}
                              />
                            );
                          })}
                        </View>
                      </ScrollView>
                    </View>
                  );
                })()}

                {(selectedRail.requiredFields || []).map((f, idx) => {
                  const obj: GlobalRailField = typeof f === "string" ? { key: f } : f;
                  const key = obj.key || obj.name || `field_${idx}`;
                  const label = obj.label || humanizeField(key);
                  const options = obj.options || (key === "scheme" ? selectedRail.schemeOptions || undefined : undefined);

                  if (options && options.length > 0) {
                    return (
                      <View key={`${selectedRail.railKey}:${key}`} style={{ marginBottom: 12 }}>
                        <Text style={styles.fieldHint}>{label}</Text>
                        <View style={styles.pillRow}>
                          {options.map((opt) => (
                            <Pill
                              key={opt}
                              label={opt.toUpperCase()}
                              active={(globalFields[key] || "").toLowerCase() === opt.toLowerCase()}
                              onPress={() => setGlobalFields((prev) => ({ ...prev, [key]: opt }))}
                            />
                          ))}
                        </View>
                      </View>
                    );
                  }

                  return (
                    <Input
                      key={`${selectedRail.railKey}:${key}`}
                      label={label}
                      currency={false}
                      placeholder={obj.placeholder || ""}
                      value={globalFields[key] || ""}
                      keyboardType={obj.keyboardType || "default"}
                      autoCapitalize={obj.autoCapitalize || (key === "account_holder_name" || key === "bank_name" ? "words" : "none")}
                      onChangeText={(v) => setGlobalFields((prev) => ({ ...prev, [key]: v }))}
                    />
                  );
                })}
                {selectedRail.example ? (
                  <Text style={[styles.rowSub, { marginBottom: 12, marginTop: -4 }]}>
                    Example: {selectedRail.example}
                  </Text>
                ) : null}
              </>
            ) : null}

            <Input
              label="Reference (optional)"
              currency={false}
              placeholder="Invoice or memo"
              value={globalNote}
              onChangeText={setGlobalNote}
            />
            <Button
              title={selectedRail ? `Quote & send ${selectedRail.currency}` : "Quote & approve payout"}
              onPress={handleGlobalPayout}
              loading={loading}
            />
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
