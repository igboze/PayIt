import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type {
  AccountSummary,
  BusinessExpenseItem,
  BusinessHomeResponse,
  GlobalAccountItem,
  InvoiceItem,
  PaymentLinkItem,
  SavingsOverview,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, SPACING } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatUsdc,
  Input,
  KeyValueRow,
  Pill,
  SectionHeader,
  shortAddr,
  SuccessBanner,
} from "../components/UI";

export type AccountsSection = "accounts" | "global" | "business";

export function AccountsScreen({ initialSection = "accounts" }: { initialSection?: AccountsSection }) {
  const { user, activeAccount, dataVersion, switchAccount, requestApproval } = useApp();
  const isBiz = activeAccount === "business";

  const [section, setSection] = useState<AccountsSection>(initialSection);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Accounts list
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [bizSetupName, setBizSetupName] = useState("");
  const [bizSetupEmail, setBizSetupEmail] = useState("");

  // Global Neobank accounts
  const [globalAccounts, setGlobalAccounts] = useState<GlobalAccountItem[]>([]);
  const [globalKycStatus, setGlobalKycStatus] = useState<string>("not_started");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [plCurrency, setPlCurrency] = useState("GBP");
  const [plAmount, setPlAmount] = useState("");
  const [plFunding, setPlFunding] = useState<"open-banking" | "interac" | "momo">("open-banking");

  // Savings
  const [savings, setSavings] = useState<SavingsOverview | null>(null);
  const [saveAmt, setSaveAmt] = useState("");

  // Swap
  const [swapRates, setSwapRates] = useState<Record<string, unknown> | null>(null);
  const [swapDir, setSwapDir] = useState<"USDC_EURC" | "EURC_USDC">("USDC_EURC");
  const [swapAmt, setSwapAmt] = useState("");
  const [swapQuote, setSwapQuote] = useState<Record<string, unknown> | null>(null);

  // Business & Invoices
  const [bizHome, setBizHome] = useState<BusinessHomeResponse | null>(null);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
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
          const res = await api.listAccounts();
          setAccounts(res.accounts || []);
        } else if (section === "global") {
          const res = await api.listGlobalAccounts(activeAccount);
          setGlobalAccounts(res.accounts || []);
          setGlobalKycStatus(res.kycStatus || "not_started");
          setSupportedCurrencies(res.supportedCurrencies || []);
        } else if (section === "business") {
          if (isBiz) {
            const [home, invs, exps, links] = await Promise.all([
              api.getBusinessHome(),
              api.listBusinessInvoices(20),
              api.listBusinessExpenses(20),
              api.listBusinessPaymentLinks(),
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
          } else {
            const invs = await api.listPersonalInvoices(20);
            setInvoices(invs.invoices || []);
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

  const handleSaveDeposit = async () => {
    setError(null);
    try {
      const res = await requestApproval("savings.deposit", {
        accountType: activeAccount,
        amountUsdc: Number(saveAmt),
      });
      setNotice(res.notice || "Deposited into savings!");
      setSaveAmt("");
      loadSection(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Savings deposit failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleSaveWithdraw = async () => {
    setError(null);
    try {
      const res = await requestApproval("savings.withdraw", { accountType: activeAccount });
      setNotice(res.notice || "Withdrew savings back to balance!");
      loadSection(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Savings withdrawal failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleQuoteSwap = async () => {
    setError(null);
    setSwapQuote(null);
    setLoading(true);
    try {
      const tokenIn = swapDir === "USDC_EURC" ? "USDC" : "EURC";
      const tokenOut = swapDir === "USDC_EURC" ? "EURC" : "USDC";
      const res = await api.quoteSwap(tokenIn, tokenOut, Number(swapAmt));
      setSwapQuote(res.quote || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch swap quote.");
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteSwap = async () => {
    setError(null);
    try {
      const tokenIn = swapDir === "USDC_EURC" ? "USDC" : "EURC";
      const tokenOut = swapDir === "USDC_EURC" ? "EURC" : "USDC";
      const res = await requestApproval("swap.execute", {
        accountType: activeAccount,
        tokenIn,
        tokenOut,
        amountIn: Number(swapAmt),
      });
      setNotice(res.notice || "Swap completed!");
      setSwapAmt("");
      setSwapQuote(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleCreateInvoice = async () => {
    setError(null);
    setLoading(true);
    try {
      const payload = {
        clientName: invClient.trim(),
        amount: Number(invAmount),
        notes: invNotes.trim() || undefined,
      };
      if (isBiz) await api.createBusinessInvoice(payload);
      else await api.createPersonalInvoice(payload);
      setNotice("Invoice created!");
      setInvClient("");
      setInvAmount("");
      setInvNotes("");
      loadSection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invoice.");
    } finally {
      setLoading(false);
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
          <Pill label="Wallets" active={section === "accounts"} onPress={() => setSection("accounts")} />
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
                <Text style={styles.bigVal}>{a.balance ? formatUsdc(a.balance.totalUsdc) : "—"}</Text>
                <KeyValueRow label="Verification" value={`${a.kycStatus} (Tier ${a.kycTier})`} />
                <KeyValueRow
                  label="Deposit Address (EVM)"
                  value={shortAddr(a.depositAddress, 8, 6)}
                  onCopy={a.depositAddress ? () => copy("Deposit address", a.depositAddress!) : undefined}
                />
                <KeyValueRow
                  label="Solana Address"
                  value={shortAddr(a.solanaAddress, 8, 6)}
                  onCopy={a.solanaAddress ? () => copy("Solana address", a.solanaAddress!) : undefined}
                />
              </Card>
            );
          })}

          {!user?.hasBusinessAccount ? (
            <Card>
              <SectionHeader title="Open a Dedicated Business Wallet" />
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
                  <SectionHeader title={`${ga.currency} · ${ga.status}`} />
                  {ga.bankName ? <KeyValueRow label="Bank" value={ga.bankName} /> : null}
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
                <Pill key={cur} label={`+ ${cur}`} onPress={() => handleProvisionGlobal(cur)} />
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
              <KeyValueRow label="Month Income" value={formatUsdc(bizHome.summary.monthIncomeUsd)} />
              <KeyValueRow label="Month Expenses" value={formatUsdc(bizHome.summary.monthExpensesUsd)} />
              <KeyValueRow label="Net Cash Flow" value={formatUsdc(bizHome.summary.netCashFlowUsd)} />
              <KeyValueRow
                label="Pending Invoices"
                value={`${bizHome.summary.pendingInvoiceCount} (${formatUsdc(bizHome.summary.pendingInvoiceTotalUsd)})`}
              />
            </Card>
          ) : null}

          <Card>
            <SectionHeader title={isBiz ? "Business Invoices" : "Personal Invoices"} />
            <Input label="Client Name" placeholder="Client or Company" value={invClient} onChangeText={setInvClient} />
            <Input label="Amount (USD)" placeholder="e.g. 250" value={invAmount} onChangeText={setInvAmount} keyboardType="decimal-pad" />
            <Input label="Notes (optional)" placeholder="Design sprint" value={invNotes} onChangeText={setInvNotes} />
            <Button title="Create Invoice" onPress={handleCreateInvoice} loading={loading} style={{ marginBottom: 14 }} />

            {invoices.length === 0 ? (
              <EmptyState icon="document-text-outline" title="No invoices yet" />
            ) : (
              invoices.map((inv) => (
                <View key={inv.id} style={styles.subCard}>
                  <KeyValueRow label={`${inv.invoiceNumber} · ${inv.clientName}`} value={`${formatUsdc(inv.totalUsdc)} (${inv.status})`} />
                  {inv.paymentAddress ? (
                    <KeyValueRow
                      label="Pay Address"
                      value={shortAddr(inv.paymentAddress, 8, 6)}
                      onCopy={() => copy("Invoice address", inv.paymentAddress!)}
                    />
                  ) : null}
                  {inv.status !== "paid" ? (
                    <Button
                      title="Mark Paid"
                      variant="secondary"
                      onPress={() => handleMarkInvoicePaid(inv.id)}
                      style={{ height: 36, marginTop: 8 }}
                    />
                  ) : null}
                </View>
              ))
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
                <Input label="Amount (USDC)" placeholder="e.g. 45" value={expAmt} onChangeText={setExpAmt} keyboardType="decimal-pad" />
                <Button title="Log Expense" variant="secondary" onPress={handleLogExpense} loading={loading} style={{ marginBottom: 12 }} />
                {expenses.map((e) => (
                  <KeyValueRow key={e.id} label={`${e.description} (${e.category})`} value={`${e.amount} ${e.currency}`} />
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
  bigVal: { color: COLORS.text, fontSize: 30, fontWeight: "800", marginBottom: 10 },
  muted: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 10 },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  subCard: {
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    marginBottom: 10,
  },
});
