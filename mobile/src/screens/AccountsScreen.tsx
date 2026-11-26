import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import type {
  AccountSummary,
  BusinessExpenseItem,
  BusinessHomeResponse,
  GlobalAccountItem,
  IntentTokenInfo,
  InvoiceItem,
  InvoicePaymentOptionsResponse,
  PaymentLinkItem,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatUsdc,
  Input,
  KeyValueRow,
  Pill,
  SectionHeader,
  shortAddr,
  SuccessBanner,
} from "../components/UI";
import { CurrencyLogo } from "../components/CurrencyLogo";
import { PressableScale, notifyHaptic } from "../components/Touch";
import { getLegacyFileSystem, getSharing } from "../nativeModules";

export type AccountsSection = "accounts" | "global" | "business";

export function AccountsScreen({ initialSection = "accounts" }: { initialSection?: AccountsSection }) {
  const { user, activeAccount, dataVersion, switchAccount, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";

  const [section, setSection] = useState<AccountsSection>(initialSection);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Accounts list
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [fallbackNgnRate, setFallbackNgnRate] = useState<number | null>(null);
  const [bizSetupName, setBizSetupName] = useState("");
  const [bizSetupEmail, setBizSetupEmail] = useState("");

  // Global Neobank accounts
  const [globalAccounts, setGlobalAccounts] = useState<GlobalAccountItem[]>([]);
  const [globalKycStatus, setGlobalKycStatus] = useState<string>("not_started");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [plCurrency, setPlCurrency] = useState("GBP");
  const [plAmount, setPlAmount] = useState("");
  const [plFunding, setPlFunding] = useState<"open-banking" | "interac" | "momo">("open-banking");

  // Business & Invoices
  const [bizHome, setBizHome] = useState<BusinessHomeResponse | null>(null);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [invoiceOptions, setInvoiceOptions] = useState<InvoicePaymentOptionsResponse | null>(null);
  const [invPayMode, setInvPayMode] = useState<"fiat" | "crypto" | "both">("fiat");
  const [invFiatCurrency, setInvFiatCurrency] = useState<string>("NGN");
  const [invCryptoChain, setInvCryptoChain] = useState<string>("sol");
  const [invCryptoToken, setInvCryptoToken] = useState<IntentTokenInfo | null>(null);
  const [invClientEmail, setInvClientEmail] = useState("");
  const [invDueDate, setInvDueDate] = useState("");
  const [createdPaymentDetails, setCreatedPaymentDetails] = useState<{
    invoiceId: number | null;
    invoiceNumber: string;
    fiat: Record<string, unknown> | null;
    crypto: Record<string, unknown> | null;
    paymentAddress: string | null;
    clientCopyText: string | null;
    fiatPendingCurrency: string | null;
  } | null>(null);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<number | null>(null);
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<number | null>(null);
  const [expenses, setExpenses] = useState<BusinessExpenseItem[]>([]);
  const [paymentLinks, setPaymentLinks] = useState<PaymentLinkItem[]>([]);
  const [invClient, setInvClient] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invNotes, setInvNotes] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expAmt, setExpAmt] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [linkAmt, setLinkAmt] = useState("");
  const [payrollCsv, setPayrollCsv] = useState("");
  const [bizProfName, setBizProfName] = useState("");
  const [bizProfEmail, setBizProfEmail] = useState("");
  const [bizProfPhone, setBizProfPhone] = useState("");
  const [bizProfAddr, setBizProfAddr] = useState("");
  const [goalPct, setGoalPct] = useState("");
  const [goalLabel, setGoalLabel] = useState("Tax & Reserve");

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const loadSection = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        if (section === "accounts") {
          const [res, rateRes] = await Promise.all([
            api.listAccounts(),
            api.getBankRates().catch(() => null),
          ]);
          setAccounts(res.accounts || []);
          const r = rateRes?.offRampRate || rateRes?.onRampRate || null;
          if (r) setFallbackNgnRate(r);
        } else if (section === "global") {
          const res = await api.listGlobalAccounts(activeAccount);
          setGlobalAccounts(res.accounts || []);
          setGlobalKycStatus(res.kycStatus || "not_started");
          setSupportedCurrencies(res.supportedCurrencies || []);
        } else if (section === "business") {
          const optsPromise = api.getInvoicePaymentOptions(activeAccount).catch(() => null);
          if (isBiz) {
            const [home, invs, exps, links, opts] = await Promise.all([
              api.getBusinessHome(),
              api.listBusinessInvoices(20),
              api.listBusinessExpenses(20),
              api.listBusinessPaymentLinks(),
              optsPromise,
            ]);
            setBizHome(home);
            if (home.profile) {
              setBizProfName(home.profile.businessName || "");
              setBizProfEmail(home.profile.businessEmail || "");
              setBizProfPhone(home.profile.phone || "");
              setBizProfAddr(home.profile.address || "");
            }
            if (home.summary?.savingsGoal?.percentage !== undefined) {
              setGoalPct(String(home.summary.savingsGoal.percentage));
              if (home.summary.savingsGoal.label) setGoalLabel(home.summary.savingsGoal.label);
            }
            setInvoices(invs.invoices || []);
            setExpenses(exps.expenses || []);
            setPaymentLinks(links.paymentLinks || []);
            if (opts) {
              setInvoiceOptions(opts);
              if (opts.cryptoChains?.length) {
                const defaultChain =
                  opts.cryptoChains.find((c) => c.key === "sol") ||
                  opts.cryptoChains.find((c) => c.key === "base") ||
                  opts.cryptoChains[0];
                setInvCryptoChain((prev) =>
                  prev && opts.cryptoTokensByChain?.[prev]?.length ? prev : defaultChain.key
                );
              }
            }
          } else {
            const [invs, opts] = await Promise.all([api.listPersonalInvoices(20), optsPromise]);
            setInvoices(invs.invoices || []);
            if (opts) {
              setInvoiceOptions(opts);
              if (opts.cryptoChains?.length) {
                const defaultChain =
                  opts.cryptoChains.find((c) => c.key === "sol") ||
                  opts.cryptoChains.find((c) => c.key === "base") ||
                  opts.cryptoChains[0];
                setInvCryptoChain((prev) =>
                  prev && opts.cryptoTokensByChain?.[prev]?.length ? prev : defaultChain.key
                );
              }
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load live data.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [section, activeAccount, isBiz]
  );

  useEffect(() => {
    loadSection(false);
  }, [loadSection, dataVersion]);

  const copy = async (label: string, val: string) => {
    await Clipboard.setStringAsync(val);
    setNotice(`${label} copied`);
    setTimeout(() => setNotice(null), 2000);
  };

  const handleSetupBusiness = async () => {
    setError(null);
    try {
      const res = await requestApproval("business.setup", {
        businessName: bizSetupName.trim() || undefined,
        businessEmail: bizSetupEmail.trim() || undefined,
      });
      setNotice(res.notice || "Business account created!");
      await switchAccount("business");
      loadSection(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Setup failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleProvisionGlobal = async (currency: string) => {
    setError(null);
    setLoading(true);
    try {
      await api.provisionGlobalAccount(currency, activeAccount);
      setNotice(`${currency} receiving account requested!`);
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not open ${currency} account.`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateGlobalLink = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.createGlobalPaymentLink({
        currency: plCurrency,
        amount: Number(plAmount),
        fundingType: plFunding,
        accountType: activeAccount,
      });
      if (res.paymentUrl) {
        Share.share({ message: res.paymentUrl }).catch(() => {});
        setNotice(`Payment link created: ${res.paymentUrl}`);
      } else {
        setNotice("Global payment link created.");
      }
      setPlAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create payment link.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const tokens = invoiceOptions?.cryptoTokensByChain?.[invCryptoChain] || [];
    if (!tokens.length) {
      setInvCryptoToken(null);
      return;
    }
    setInvCryptoToken((prev) => {
      if (prev && tokens.some((t) => t.assetId === prev.assetId)) return prev;
      return tokens.find((t) => t.symbol === "USDC") || tokens.find((t) => t.symbol === "USDT") || tokens[0];
    });
  }, [invCryptoChain, invoiceOptions]);

  const handleCreateInvoice = async () => {
    setError(null);
    if (!invClient.trim()) {
      setError("Enter the client's name.");
      return;
    }
    const amt = Number(invAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid invoice amount.");
      return;
    }
    setLoading(true);
    try {
      const wantsFiat = invPayMode === "fiat" || invPayMode === "both";
      const wantsCrypto = invPayMode === "crypto" || invPayMode === "both";
      const useGlobalBank = Boolean(invoiceOptions?.globalBankEnabled) || invFiatCurrency !== "NGN";
      let paymentChannel: "ngn_bank" | "nuvion_bank" | "crypto_intent" | "both" | "both_nuvion";
      if (wantsFiat && wantsCrypto) {
        paymentChannel = useGlobalBank ? "both_nuvion" : "both";
      } else if (wantsFiat) {
        paymentChannel = useGlobalBank ? "nuvion_bank" : "ngn_bank";
      } else {
        paymentChannel = "crypto_intent";
      }

      const invoiceCurrency = wantsFiat ? invFiatCurrency : "USD";
      const payload: Record<string, unknown> = {
        clientName: invClient.trim(),
        clientEmail: invClientEmail.trim() || undefined,
        amount: amt,
        currency: invoiceCurrency,
        paymentChannel,
        globalBankCurrency: wantsFiat ? invFiatCurrency : undefined,
        cryptoChain: wantsCrypto ? invCryptoChain : undefined,
        cryptoAssetId: wantsCrypto && invCryptoToken && invCryptoChain !== "arc" ? invCryptoToken.assetId : undefined,
        cryptoSymbol: wantsCrypto && invCryptoToken ? invCryptoToken.symbol : undefined,
        cryptoBlockchain: wantsCrypto ? invCryptoChain : undefined,
        dueDate: invDueDate.trim() || undefined,
        notes: invNotes.trim() || undefined,
      };
      const res = isBiz ? await api.createBusinessInvoice(payload) : await api.createPersonalInvoice(payload);
      const pd = (res.paymentDetails || {}) as Record<string, unknown>;
      setCreatedPaymentDetails({
        invoiceId: res.invoice?.id ?? null,
        invoiceNumber: res.invoice?.invoiceNumber || "Invoice",
        fiat: (pd.fiat as Record<string, unknown> | null) || null,
        crypto: (pd.crypto as Record<string, unknown> | null) || null,
        paymentAddress: (pd.paymentAddress as string | null) || res.invoice?.paymentAddress || null,
        clientCopyText: (pd.clientCopyText as string | null) || null,
        fiatPendingCurrency: (pd.fiatPendingCurrency as string | null) || null,
      });
      setNotice(`Invoice ${res.invoice?.invoiceNumber || ""} created with payment details!`);
      setInvClient("");
      setInvClientEmail("");
      setInvAmount("");
      setInvDueDate("");
      setInvNotes("");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invoice.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadInvoice = async (invId: number, invoiceNumber: string) => {
    setError(null);
    setDownloadingInvoiceId(invId);
    const scope = isBiz ? "business" : "personal";
    const token = getAccessToken();
    try {
      let shared = false;
      const Sharing = getSharing();
      const LegacyFS = getLegacyFileSystem();
      if (Sharing && LegacyFS && token && (await Sharing.isAvailableAsync().catch(() => false))) {
        try {
          const safeNum = String(invoiceNumber || invId).replace(/[^A-Za-z0-9._-]/g, "_");
          const target = `${LegacyFS.cacheDirectory}proxim-invoice-${safeNum}.png`;
          const res = await LegacyFS.downloadAsync(api.getInvoiceDownloadUrl(invId, scope), target, {
            headers: { Authorization: `Bearer ${token}`, "X-Proxim-Account": activeAccount },
          });
          if (res.status !== 200) throw new Error("download failed");
          await Sharing.shareAsync(res.uri, {
            mimeType: "image/png",
            dialogTitle: `Save or share invoice ${invoiceNumber}`,
            UTI: "public.png",
          });
          shared = true;
        } catch (_) {
          shared = false;
        }
      }
      if (!shared) {
        const link = await api.getInvoiceDownloadLink(invId, scope);
        await Linking.openURL(link);
      }
      notifyHaptic("success");
      setNotice(`Invoice ${invoiceNumber} ready to save or share`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't download invoice.");
    } finally {
      setDownloadingInvoiceId(null);
    }
  };

  const handleMarkInvoicePaid = async (id: number) => {
    setError(null);
    try {
      if (isBiz) await api.markBusinessInvoicePaid(id);
      else await api.markPersonalInvoicePaid(id);
      setNotice("Invoice marked paid.");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update invoice.");
    }
  };

  const handleLogExpense = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.logBusinessExpense({
        amount: Number(expAmt),
        currency: "USDC",
        description: expDesc.trim(),
      });
      setNotice("Expense logged!");
      setExpAmt("");
      setExpDesc("");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log expense.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBizLink = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.createBusinessPaymentLink({
        title: linkTitle.trim(),
        amount: linkAmt ? Number(linkAmt) : undefined,
        currency: "USD",
      });
      setNotice(`Payment link created: ${res.paymentLink.url}`);
      setLinkTitle("");
      setLinkAmt("");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create payment link.");
    } finally {
      setLoading(false);
    }
  };

  const handleRunPayroll = async () => {
    setError(null);
    try {
      const res = await requestApproval("payroll.run", { csvText: payrollCsv });
      setNotice(res.notice || "Payroll batch submitted!");
      setPayrollCsv("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Payroll failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleSaveBizProfile = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.updateBusinessProfile({
        businessName: bizProfName.trim(),
        businessEmail: bizProfEmail.trim() || undefined,
        phone: bizProfPhone.trim() || undefined,
        address: bizProfAddr.trim() || undefined,
      });
      setNotice("Business profile updated!");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update business profile.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveGoal = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.setBusinessSavingsGoal(Number(goalPct), goalLabel.trim() || "Business Savings");
      setNotice("Business savings goal saved!");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save goal.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateLink = async (linkId: string) => {
    setError(null);
    try {
      await api.deactivateBusinessPaymentLink(linkId);
      setNotice("Payment link deactivated.");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not deactivate payment link.");
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadSection(true)} tintColor={COLORS.primary} />
      }
      keyboardShouldPersistTaps="handled"
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pill label="Balances" active={section === "accounts"} onPress={() => setSection("accounts")} />
          <Pill label="Global Bank" active={section === "global"} onPress={() => setSection("global")} />
          <Pill
            label={isBiz ? "Business Tools" : "Invoices"}
            active={section === "business"}
            tone={isBiz ? "business" : "primary"}
            onPress={() => setSection("business")}
          />
        </View>
      </ScrollView>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

      {loading && !refreshing ? (
        <View style={{ paddingVertical: 16, alignItems: "center" }}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : null}

      {/* 1. PERSONAL & BUSINESS WALLETS */}
      {section === "accounts" ? (
        <>
          {accounts.map((a) => {
            const biz = a.accountType === "business";
            const usdBal = Number(a.balance?.totalUsdc ?? 0);
            const rate = a.balance?.usdToNgnRate || fallbackNgnRate || null;
            const ngnBal =
              a.balance && typeof a.balance.totalNgn === "number"
                ? a.balance.totalNgn
                : a.balance && rate && Number.isFinite(usdBal)
                  ? Math.round(usdBal * rate)
                  : null;
            return (
              <Card
                key={a.accountType}
                style={{ borderColor: a.active ? (biz ? COLORS.businessBorder : COLORS.primaryBorder) : COLORS.border }}
              >
                <SectionHeader
                  title={biz ? a.businessName || "Business Account" : "Personal Account"}
                  right={
                    <Pill
                      label={a.active ? "Active" : "Switch"}
                      active={a.active}
                      tone={biz ? "business" : "primary"}
                      onPress={a.active ? undefined : () => switchAccount(a.accountType)}
                    />
                  }
                />
                <View style={styles.balDualBlock}>
                  {ngnBal !== null ? (
                    <View style={styles.balRow}>
                      <CurrencyLogo code="NGN" size={20} />
                      <Text style={styles.bigVal}>{balanceHidden ? "₦••••" : formatNgn(ngnBal)}</Text>
                      <Text style={styles.balCode}>NGN</Text>
                    </View>
                  ) : null}
                  <View style={styles.balRow}>
                    <CurrencyLogo code="USD" size={16} />
                    <Text style={ngnBal !== null ? styles.ngnVal : styles.bigVal}>
                      {balanceHidden ? "$••••" : a.balance ? formatUsdc(a.balance.totalUsdc) : "—"}
                    </Text>
                    <Text style={styles.ngnCode}>USD</Text>
                  </View>
                </View>
                <KeyValueRow label="Verification" value={`${a.kycStatus} (Tier ${a.kycTier})`} />
                <KeyValueRow
                  label="Your dollar deposit address"
                  value={shortAddr(a.depositAddress, 8, 6)}
                  onCopy={a.depositAddress ? () => copy("Deposit address", a.depositAddress!) : undefined}
                />
                <KeyValueRow
                  label="Your Solana deposit address"
                  value={shortAddr(a.solanaAddress, 8, 6)}
                  onCopy={a.solanaAddress ? () => copy("Solana address", a.solanaAddress!) : undefined}
                />
              </Card>
            );
          })}

          {!user?.hasBusinessAccount ? (
            <Card>
              <SectionHeader title="Open a business account" />
              <Text style={styles.muted}>
                Keep business deposits, payouts, invoices, cards, and payroll strictly isolated from
                your personal wallet.
              </Text>
              <Input
                label="Business Name (optional)"
                placeholder="Acme Studio Ltd"
                value={bizSetupName}
                onChangeText={setBizSetupName}
              />
              <Input
                label="Business Email (optional)"
                placeholder="billing@acme.com"
                value={bizSetupEmail}
                onChangeText={setBizSetupEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Button title="Create Business Account" onPress={handleSetupBusiness} />
            </Card>
          ) : null}
        </>
      ) : null}

      {/* 2. GLOBAL NEOBANK RECEIVING ACCOUNTS */}
      {section === "global" ? (
        <>
          <Card>
            <SectionHeader
              title={`${isBiz ? "Business" : "Personal"} Global Neobank Accounts`}
              right={<Text style={styles.muted}>Status: {globalKycStatus}</Text>}
            />
            {globalAccounts.length === 0 ? (
              <EmptyState
                icon="globe-outline"
                title="No global receiving accounts yet"
                subtitle="Complete ID verification in Profile, then open USD, GBP, EUR, or local receiving accounts below."
              />
            ) : (
              globalAccounts.map((ga, idx) => (
                <View key={ga.id || `${ga.currency}-${idx}`} style={styles.subCard}>
                  <SectionHeader currency={ga.currency || false} title={`${ga.currency} · ${ga.status}`} />
                  {ga.bankName ? <KeyValueRow label="Bank" value={ga.bankName} /> : null}
                  {ga.bankCode ? (
                    <KeyValueRow
                      label="Bank Code"
                      value={ga.bankCode}
                      onCopy={() => copy("Bank code", ga.bankCode!)}
                    />
                  ) : null}
                  {ga.beneficiaryName ? <KeyValueRow label="Beneficiary" value={ga.beneficiaryName} /> : null}
                  {ga.accountNumber ? (
                    <KeyValueRow
                      label="Account No."
                      value={ga.accountNumber}
                      onCopy={() => copy("Account number", ga.accountNumber!)}
                    />
                  ) : null}
                  {ga.routingNumber ? (
                    <KeyValueRow
                      label="Routing No."
                      value={ga.routingNumber}
                      onCopy={() => copy("Routing number", ga.routingNumber!)}
                    />
                  ) : null}
                  {ga.sortCode ? (
                    <KeyValueRow
                      label="Sort Code"
                      value={ga.sortCode}
                      onCopy={() => copy("Sort code", ga.sortCode!)}
                    />
                  ) : null}
                  {ga.iban ? (
                    <KeyValueRow label="IBAN" value={ga.iban} onCopy={() => copy("IBAN", ga.iban!)} />
                  ) : null}
                  {ga.swiftCode ? <KeyValueRow label="SWIFT" value={ga.swiftCode} /> : null}
                </View>
              ))
            )}

            <SectionHeader title="Open New Currency Account" />
            <View style={styles.pillWrap}>
              {supportedCurrencies.map((cur) => (
                <Pill key={cur} currency={cur} label={`+ ${cur}`} onPress={() => handleProvisionGlobal(cur)} />
              ))}
            </View>
          </Card>

          <Card>
            <SectionHeader title="Global Hosted Payment Link" />
            <View style={styles.pillWrap}>
              {(["open-banking", "interac", "momo"] as const).map((f) => (
                <Pill key={f} label={f} active={plFunding === f} onPress={() => setPlFunding(f)} />
              ))}
            </View>
            <Input
              label="Currency (3-letter ISO)"
              currency={/^[A-Z]{3}$/.test(plCurrency) ? plCurrency : false}
              placeholder="GBP, CAD, KES, GHS…"
              value={plCurrency}
              onChangeText={(t) => setPlCurrency(t.toUpperCase())}
              autoCapitalize="characters"
            />
            <Input
              label="Amount"
              placeholder="e.g. 150"
              value={plAmount}
              onChangeText={setPlAmount}
              keyboardType="decimal-pad"
            />
            <Button title="Create & share payment link" onPress={handleCreateGlobalLink} loading={loading} />
          </Card>
        </>
      ) : null}

      {/* 3. BUSINESS TOOLS & INVOICES */}
      {section === "business" ? (
        <>
          {isBiz && bizHome ? (
            <Card style={{ borderColor: COLORS.businessBorder }}>
              <SectionHeader title={bizHome.profile?.businessName || "Business Overview"} />
              <KeyValueRow label="Month Income" value={balanceHidden ? "••••" : formatUsdc(bizHome.summary.monthIncomeUsd)} />
              <KeyValueRow label="Month Expenses" value={balanceHidden ? "••••" : formatUsdc(bizHome.summary.monthExpensesUsd)} />
              <KeyValueRow label="Net Cash Flow" value={balanceHidden ? "••••" : formatUsdc(bizHome.summary.netCashFlowUsd)} />
              <KeyValueRow
                label="Pending Invoices"
                value={
                  balanceHidden
                    ? `${bizHome.summary.pendingInvoiceCount} (••••)`
                    : `${bizHome.summary.pendingInvoiceCount} (${formatUsdc(bizHome.summary.pendingInvoiceTotalUsd)})`
                }
              />
            </Card>
          ) : null}

          <Card>
            <SectionHeader title={isBiz ? "Create Business Invoice" : "Create Personal Invoice"} />
            <Input label="Client Name" placeholder="Client or Company" value={invClient} onChangeText={setInvClient} />
            <Input
              label="Client Email (optional)"
              placeholder="client@company.com"
              value={invClientEmail}
              onChangeText={setInvClientEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />

            {/* Step 1: Payment Method (identical to Telegram bot: Fiat / Crypto / Both) */}
            <Text style={styles.invStepLabel}>How should your client pay?</Text>
            <View style={styles.pillWrap}>
              <Pill label="Bank Transfer (Fiat)" active={invPayMode === "fiat"} onPress={() => setInvPayMode("fiat")} />
              <Pill label="Crypto (NEAR Intents)" active={invPayMode === "crypto"} onPress={() => setInvPayMode("crypto")} />
              <Pill label="Both (Fiat + Crypto)" active={invPayMode === "both"} onPress={() => setInvPayMode("both")} />
            </View>

            {/* Fiat currency grid (Global Neobank / Nuvion currencies + instant NGN) */}
            {invPayMode === "fiat" || invPayMode === "both" ? (
              <View style={styles.invMethodBox}>
                <Text style={styles.invMethodTitle}>Select Fiat Currency</Text>
                <Text style={styles.muted}>
                  {invoiceOptions?.globalBankEnabled
                    ? "Your Global Neobank receiving details for the chosen currency will be provisioned directly on the invoice."
                    : "Naira instant bank account is ready now. Complete ID verification in Profile to receive GBP, EUR, USD & more."}
                </Text>
                <View style={styles.fiatGrid}>
                  {(
                    invoiceOptions?.fiatCurrencies || [
                      { currency: "NGN", label: "Nigerian Naira", provider: "naira_instant", provisioned: true },
                      { currency: "USD", label: "US Dollar", provider: "global_bank", provisioned: false },
                      { currency: "GBP", label: "British Pound", provider: "global_bank", provisioned: false },
                      { currency: "EUR", label: "Euro", provider: "global_bank", provisioned: false },
                    ]
                  ).map((fc) => {
                    const active = invFiatCurrency === fc.currency;
                    return (
                      <PressableScale
                        key={fc.currency}
                        onPress={() => setInvFiatCurrency(fc.currency)}
                        style={[styles.fiatTile, active && styles.fiatTileOn]}
                      >
                        <CurrencyLogo code={fc.currency} size={24} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.fiatCode}>{fc.currency}</Text>
                          <Text style={styles.fiatName} numberOfLines={1}>
                            {fc.label}
                          </Text>
                        </View>
                        {active ? <Ionicons name="checkmark-circle" size={16} color={COLORS.primary} /> : null}
                      </PressableScale>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {/* Crypto chain & token picker (NEAR Intents + Direct USDC) */}
            {invPayMode === "crypto" || invPayMode === "both" ? (
              <View style={styles.invMethodBox}>
                <Text style={styles.invMethodTitle}>Select Crypto Network & Token</Text>
                <Text style={styles.muted}>
                  Exact payment address for your selected network & token is automatically generated on the invoice.
                </Text>
                <View style={styles.pillWrap}>
                  {(invoiceOptions?.cryptoChains || []).slice(0, 14).map((ch) => (
                    <Pill
                      key={ch.key}
                      label={ch.name}
                      active={invCryptoChain === ch.key}
                      onPress={() => setInvCryptoChain(ch.key)}
                    />
                  ))}
                </View>
                {(invoiceOptions?.cryptoTokensByChain?.[invCryptoChain] || []).length > 0 ? (
                  <>
                    <Text style={[styles.invMethodTitle, { marginTop: 4 }]}>Token</Text>
                    <View style={styles.pillWrap}>
                      {(invoiceOptions?.cryptoTokensByChain?.[invCryptoChain] || []).slice(0, 12).map((tk) => {
                        const active = invCryptoToken?.assetId === tk.assetId;
                        return (
                          <PressableScale
                            key={tk.assetId}
                            onPress={() => setInvCryptoToken(tk)}
                            style={[styles.tokenChip, active && styles.tokenChipOn]}
                          >
                            {tk.logoUrl ? (
                              <Image source={{ uri: tk.logoUrl }} style={styles.tokenLogo} resizeMode="contain" />
                            ) : null}
                            <Text style={[styles.tokenChipText, active && { color: COLORS.primaryDark }]}>
                              {tk.symbol}
                            </Text>
                          </PressableScale>
                        );
                      })}
                    </View>
                  </>
                ) : null}
              </View>
            ) : null}

            <Input
              label={`Amount (${invPayMode === "crypto" ? "USD" : invFiatCurrency})`}
              placeholder={invPayMode !== "crypto" && invFiatCurrency === "NGN" ? "e.g. 250000" : "e.g. 250"}
              value={invAmount}
              onChangeText={(t) => setInvAmount(t.replace(/[^\d.]/g, ""))}
              keyboardType="decimal-pad"
              currency={invPayMode === "crypto" ? "USD" : invFiatCurrency}
            />
            <Input label="Due Date (optional)" placeholder="YYYY-MM-DD" value={invDueDate} onChangeText={setInvDueDate} />
            <Input label="Item / Notes (optional)" placeholder="Design sprint or invoice description" value={invNotes} onChangeText={setInvNotes} />
            <Button title="Create & Provision Invoice" onPress={handleCreateInvoice} loading={loading} style={{ marginBottom: 14 }} />

            {/* Provisioned details card for freshly created invoice */}
            {createdPaymentDetails ? (
              <View style={[styles.subCard, { borderColor: COLORS.primaryBorder, backgroundColor: COLORS.deep }]}>
                <SectionHeader
                  title={`Provisioned · ${createdPaymentDetails.invoiceNumber}`}
                  right={
                    <PressableScale onPress={() => setCreatedPaymentDetails(null)}>
                      <Ionicons name="close" size={18} color={COLORS.textMuted} />
                    </PressableScale>
                  }
                />
                {createdPaymentDetails.fiat ? (
                  <>
                    <KeyValueRow
                      label="Bank"
                      value={String(createdPaymentDetails.fiat.bankName || "Partner Bank")}
                    />
                    {createdPaymentDetails.fiat.accountNumber || createdPaymentDetails.fiat.iban ? (
                      <KeyValueRow
                        label={createdPaymentDetails.fiat.iban ? "IBAN / Account" : "Account No."}
                        value={String(createdPaymentDetails.fiat.accountNumber || createdPaymentDetails.fiat.iban)}
                        onCopy={() =>
                          copy(
                            "Invoice account",
                            String(createdPaymentDetails.fiat?.accountNumber || createdPaymentDetails.fiat?.iban || "")
                          )
                        }
                      />
                    ) : null}
                    {createdPaymentDetails.fiat.accountName ? (
                      <KeyValueRow label="Account Name" value={String(createdPaymentDetails.fiat.accountName)} />
                    ) : null}
                  </>
                ) : createdPaymentDetails.fiatPendingCurrency ? (
                  <Text style={styles.muted}>
                    {createdPaymentDetails.fiatPendingCurrency} global bank details are pending activation. Complete ID verification or check Global Bank tab.
                  </Text>
                ) : null}
                {createdPaymentDetails.crypto && createdPaymentDetails.crypto.depositAddress ? (
                  <>
                    <KeyValueRow
                      label="Crypto Method"
                      value={`${String(createdPaymentDetails.crypto.chainLabel || "Crypto")} · ${String(createdPaymentDetails.crypto.tokenSymbol || "USDC")}`}
                    />
                    <KeyValueRow
                      label="Deposit Address"
                      value={shortAddr(String(createdPaymentDetails.crypto.depositAddress), 10, 8)}
                      onCopy={() => copy("Crypto address", String(createdPaymentDetails.crypto?.depositAddress || ""))}
                    />
                  </>
                ) : null}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  {createdPaymentDetails.invoiceId ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Download PNG"
                        onPress={() =>
                          handleDownloadInvoice(createdPaymentDetails.invoiceId!, createdPaymentDetails.invoiceNumber)
                        }
                        loading={downloadingInvoiceId === createdPaymentDetails.invoiceId}
                      />
                    </View>
                  ) : null}
                  {createdPaymentDetails.clientCopyText ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Copy Details"
                        variant="secondary"
                        onPress={() => copy("Invoice payment details", createdPaymentDetails.clientCopyText!)}
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            <SectionHeader title={isBiz ? "Your Business Invoices" : "Your Personal Invoices"} />
            {invoices.length === 0 ? (
              <EmptyState icon="document-text-outline" title="No invoices yet" />
            ) : (
              invoices.map((inv) => {
                const token = getAccessToken();
                const scope = isBiz ? "business" : "personal";
                const showingPreview = previewInvoiceId === inv.id;
                return (
                  <View key={inv.id} style={styles.subCard}>
                    <KeyValueRow
                      label={`${inv.invoiceNumber} · ${inv.clientName}`}
                      value={`${formatUsdc(inv.totalUsdc)} (${inv.status})`}
                    />
                    {inv.fiatAccountNumber ? (
                      <KeyValueRow
                        label={inv.fiatBankName ? `Bank (${inv.fiatBankName})` : "Bank Account"}
                        value={inv.fiatAccountNumber}
                        onCopy={() => copy("Invoice bank account", inv.fiatAccountNumber!)}
                      />
                    ) : null}
                    {inv.paymentAddress ? (
                      <KeyValueRow
                        label="Crypto Address"
                        value={shortAddr(inv.paymentAddress, 8, 6)}
                        onCopy={() => copy("Invoice address", inv.paymentAddress!)}
                      />
                    ) : null}
                    {showingPreview && token ? (
                      <View style={styles.invoicePreviewBox}>
                        <Image
                          source={{
                            uri: api.getInvoiceDownloadUrl(inv.id, scope),
                            headers: { Authorization: `Bearer ${token}`, "X-Proxim-Account": activeAccount },
                          }}
                          style={styles.invoicePreviewImg}
                          resizeMode="contain"
                        />
                      </View>
                    ) : null}
                    <View style={styles.invActionRow}>
                      <View style={{ flex: 1 }}>
                        <Button
                          title="Download / Share"
                          onPress={() => handleDownloadInvoice(inv.id, inv.invoiceNumber)}
                          loading={downloadingInvoiceId === inv.id}
                          style={{ height: 38 }}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button
                          title={showingPreview ? "Hide Preview" : "Preview"}
                          variant="secondary"
                          onPress={() => setPreviewInvoiceId(showingPreview ? null : inv.id)}
                          style={{ height: 38 }}
                        />
                      </View>
                    </View>
                    {inv.status !== "paid" ? (
                      <Button
                        title="Mark Paid"
                        variant="ghost"
                        onPress={() => handleMarkInvoicePaid(inv.id)}
                        style={{ height: 34, marginTop: 4 }}
                      />
                    ) : null}
                  </View>
                );
              })
            )}
          </Card>

          {isBiz ? (
            <>
              <Card>
                <SectionHeader title="Payment Links" />
                <Input label="Title" placeholder="Consulting Retainer" value={linkTitle} onChangeText={setLinkTitle} />
                <Input label="Amount USD (optional)" placeholder="Leave blank for open amount" value={linkAmt} onChangeText={setLinkAmt} keyboardType="decimal-pad" />
                <Button title="Create Payment Link" onPress={handleCreateBizLink} loading={loading} style={{ marginBottom: 12 }} />
                {paymentLinks.map((pl) => (
                  <View key={pl.linkId} style={styles.subCard}>
                    <KeyValueRow
                      label={`${pl.title}${pl.active ? "" : " (inactive)"}`}
                      value={pl.url}
                      onCopy={() => copy("Payment link", pl.url)}
                    />
                    {pl.active ? (
                      <Button
                        title="Deactivate Link"
                        variant="danger"
                        onPress={() => handleDeactivateLink(pl.linkId)}
                        style={{ height: 34, marginTop: 8 }}
                      />
                    ) : null}
                  </View>
                ))}
              </Card>

              <Card>
                <SectionHeader title="Business Profile & Savings Goal" />
                <Input label="Business Name" value={bizProfName} onChangeText={setBizProfName} />
                <Input label="Business Email" value={bizProfEmail} onChangeText={setBizProfEmail} keyboardType="email-address" autoCapitalize="none" />
                <Input label="Phone" value={bizProfPhone} onChangeText={setBizProfPhone} keyboardType="phone-pad" />
                <Input label="Address" value={bizProfAddr} onChangeText={setBizProfAddr} />
                <Button title="Save Business Profile" variant="secondary" onPress={handleSaveBizProfile} loading={loading} style={{ marginBottom: 14 }} />
                <Input label="Auto-Reserve Savings Goal (%)" placeholder="0-90" value={goalPct} onChangeText={setGoalPct} keyboardType="number-pad" />
                <Input label="Goal Label" value={goalLabel} onChangeText={setGoalLabel} />
                <Button title="Save Savings Goal" variant="secondary" onPress={handleSaveGoal} loading={loading} />
              </Card>

              <Card>
                <SectionHeader title="Expenses" />
                <Input label="Description" placeholder="Server hosting" value={expDesc} onChangeText={setExpDesc} />
                <Input label="Amount (USD)" placeholder="e.g. 45" value={expAmt} onChangeText={setExpAmt} keyboardType="decimal-pad" />
                <Button title="Log Expense" variant="secondary" onPress={handleLogExpense} loading={loading} style={{ marginBottom: 12 }} />
                {expenses.map((e) => (
                  <KeyValueRow key={e.id} currency={e.currency || false} label={`${e.description} (${e.category})`} value={`${e.amount} ${e.currency}`} />
                ))}
              </Card>

              <Card>
                <SectionHeader title="Global Payroll (CSV)" />
                <Input
                  label="Paste Payroll CSV"
                  placeholder="name,currency,amount,..."
                  value={payrollCsv}
                  onChangeText={setPayrollCsv}
                  multiline
                />
                <Button title="Quote & Approve Payroll Batch" onPress={handleRunPayroll} />
              </Card>
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 36 },
  balDualBlock: { marginBottom: 10, gap: 4 },
  balRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  bigVal: { color: COLORS.text, fontSize: 28, fontFamily: FONTS.extrabold },
  balCode: { color: COLORS.textMuted, fontSize: 12, fontFamily: FONTS.bold, marginTop: 3 },
  ngnVal: { color: COLORS.primary, fontSize: 16, fontFamily: FONTS.bold },
  ngnCode: { color: COLORS.textMuted, fontSize: 11, fontFamily: FONTS.bold, marginTop: 1 },
  muted: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 12, lineHeight: 18, marginBottom: 10 },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  subCard: {
    backgroundColor: COLORS.page,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    marginBottom: 10,
  },
  invStepLabel: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.text, marginBottom: 8, marginTop: 4 },
  invMethodBox: {
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    marginBottom: 12,
  },
  invMethodTitle: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.text, marginBottom: 4 },
  fiatGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  fiatTile: {
    ...DEPTH.raised,
    flexBasis: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 9,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surface,
  },
  fiatTileOn: { borderColor: COLORS.primary, borderWidth: 2, backgroundColor: COLORS.deep },
  fiatCode: { fontFamily: FONTS.extrabold, fontSize: 13, color: COLORS.text },
  fiatName: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textSecondary },
  tokenChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tokenChipOn: { borderColor: COLORS.primary, borderWidth: 2, backgroundColor: COLORS.deep },
  tokenLogo: { width: 16, height: 16, borderRadius: 8 },
  tokenChipText: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.text },
  invActionRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  invoicePreviewBox: {
    marginTop: 10,
    borderRadius: RADIUS.sm,
    overflow: "hidden",
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  invoicePreviewImg: { width: "100%", height: 340 },
});
