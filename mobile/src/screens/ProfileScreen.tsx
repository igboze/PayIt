import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import { assertPasskey } from "../api/passkey";
import type {
  ContactItem,
  DeviceItem,
  KycStatusResponse,
  RewardsOverview,
  ScheduleItem,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { useAutoOtaUpdates } from "../hooks/useAutoOtaUpdates";
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
  SuccessBanner,
} from "../components/UI";

type ProfileTab = "general" | "kyc" | "security" | "contacts" | "schedules" | "rewards";

export function ProfileScreen() {
  const { user, activeAccount, dataVersion, refreshMe, signOut, requestApproval } = useApp();
  const ota = useAutoOtaUpdates();
  const [tab, setTab] = useState<ProfileTab>("general");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // General
  const [senderName, setSenderName] = useState(user?.savedSenderName || user?.senderName || "");
  const [bizSenderName, setBizSenderName] = useState(user?.bizSenderName || "");

  // KYC/KYB
  const [kyc, setKyc] = useState<KycStatusResponse | null>(null);
  const [kycFormOpen, setKycFormOpen] = useState(false);
  const [kybFormOpen, setKybFormOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [countryCode, setCountryCode] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateRegion, setStateRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [idType, setIdType] = useState("passport");
  const [idNumber, setIdNumber] = useState("");

  // Business KYB fields
  const [bizLegalName, setBizLegalName] = useState("");
  const [bizRegNo, setBizRegNo] = useState("");
  const [bizCountry, setBizCountry] = useState("");
  const [bizIncYear, setBizIncYear] = useState("");
  const [bizIncMonth, setBizIncMonth] = useState("");
  const [bizIndustry, setBizIndustry] = useState("");
  const [bizType, setBizType] = useState<"llc" | "corporation" | "sole_proprietorship" | "partnership">("llc");
  const [bizEmail, setBizEmail] = useState("");
  const [bizPhone, setBizPhone] = useState("");
  const [bizStreet, setBizStreet] = useState("");
  const [bizCity, setBizCity] = useState("");
  const [bizState, setBizState] = useState("");
  const [bizPostal, setBizPostal] = useState("");
  const [officerFirst, setOfficerFirst] = useState("");
  const [officerLast, setOfficerLast] = useState("");
  const [officerEmail, setOfficerEmail] = useState("");
  const [officerDob, setOfficerDob] = useState("");
  const [officerTitle, setOfficerTitle] = useState("Director");

  // Devices
  const [devices, setDevices] = useState<DeviceItem[]>([]);

  // Contacts
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [cName, setCName] = useState("");
  const [cWallet, setCWallet] = useState("");
  const [cBank, setCBank] = useState("");
  const [cAcct, setCAcct] = useState("");

  // Schedules
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [schRecipient, setSchRecipient] = useState("");
  const [schAmt, setSchAmt] = useState("");
  const [schFreq, setSchFreq] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [schDay, setSchDay] = useState("friday");
  const [schTime, setSchTime] = useState("09:00");

  // Rewards
  const [rewards, setRewards] = useState<RewardsOverview | null>(null);
  const [redeemPts, setRedeemPts] = useState("20");
  const [redeemType, setRedeemType] = useState<"airtime" | "bills" | "cashback">("cashback");

  const loadTab = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        if (tab === "general") {
          await refreshMe();
        } else if (tab === "kyc") {
          setKyc(await api.getKycStatus());
        } else if (tab === "security") {
          const r = await api.listDevices();
          setDevices(r.devices || []);
        } else if (tab === "contacts") {
          const r = await api.listContacts();
          setContacts(r.contacts || []);
        } else if (tab === "schedules") {
          const r = await api.listSchedules();
          setSchedules(r.schedules || []);
        } else if (tab === "rewards") {
          setRewards(await api.getRewards(20));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load section.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tab, refreshMe]
  );

  useEffect(() => {
    loadTab(false);
  }, [loadTab, dataVersion]);

  const handleSaveProfile = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.updateProfile({
        ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
        ...(bizSenderName.trim() && user?.hasBusinessAccount ? { bizSenderName: bizSenderName.trim() } : {}),
      });
      await refreshMe();
      setNotice("Profile updated!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update profile.");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAutoEarn = async (val: boolean) => {
    try {
      await api.updateProfile({ autoEarnEnabled: val });
      await refreshMe();
      setNotice(`Auto-Earn ${val ? "enabled" : "disabled"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update Auto-Earn.");
    }
  };

  const handleExportCsv = async () => {
    setLoading(true);
    setError(null);
    try {
      const csv = await api.exportStatementCsv(500, activeAccount);
      await Share.share({ message: csv, title: `proxim-statement-${activeAccount}.csv` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export statement.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitKyc = async () => {
    setError(null);
    setLoading(true);
    try {
      const cc = countryCode.trim().toUpperCase();
      const res = await api.submitKyc({
        countryCode: cc,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phoneNumber: phoneNumber.trim(),
        dateOfBirth: dob.trim(),
        gender,
        address: {
          line1: street.trim(),
          city: city.trim(),
          state: stateRegion.trim(),
          postalCode: postalCode.trim(),
          country: cc,
        },
        idDocument: {
          type: idType,
          number: idNumber.trim(),
          country: cc,
        },
      });
      setNotice(`Verification submitted (status: ${res.status}).`);
      setKycFormOpen(false);
      loadTab(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification submission failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitKyb = async () => {
    setError(null);
    setLoading(true);
    try {
      const cc = bizCountry.trim().toUpperCase();
      const res = await api.submitKyb({
        legalName: bizLegalName.trim(),
        registrationNumber: bizRegNo.trim(),
        incorporationCountry: cc,
        incorporationYear: Number(bizIncYear),
        incorporationMonth: Number(bizIncMonth),
        industry: bizIndustry.trim(),
        businessType: bizType,
        email: bizEmail.trim(),
        phoneNumber: bizPhone.trim(),
        address: {
          line1: bizStreet.trim(),
          city: bizCity.trim(),
          state: bizState.trim(),
          postalCode: bizPostal.trim(),
          country: cc,
        },
        officer: {
          firstName: officerFirst.trim(),
          lastName: officerLast.trim(),
          email: officerEmail.trim(),
          dateOfBirth: officerDob.trim(),
          title: officerTitle.trim(),
        },
      });
      setNotice(`Business KYB submitted (status: ${res.status}).`);
      setKybFormOpen(false);
      loadTab(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Business verification submission failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    setError(null);
    setLoading(true);
    try {
      const intent = await api.deviceRevokeIntent(deviceId);
      const assertion = await assertPasskey(intent.options);
      await api.deviceRevoke(deviceId, intent.challengeId, assertion);
      setNotice("Device removed.");
      loadTab(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not remove device.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleChangePin = async () => {
    setError(null);
    try {
      const res = await requestApproval("pin.change", {});
      setNotice(res.notice || "PIN changed successfully.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "PIN change failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleAddContact = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.upsertContact({
        name: cName.trim(),
        walletAddress: cWallet.trim() || null,
        bankName: cBank.trim() || null,
        accountNumber: cAcct.trim() || null,
      });
      setNotice("Contact saved.");
      setCName("");
      setCWallet("");
      setCBank("");
      setCAcct("");
      loadTab(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save contact.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSchedule = async () => {
    setError(null);
    const isWallet = /^0x[0-9a-fA-F]{40}$/.test(schRecipient.trim());
    try {
      const res = await requestApproval("schedule.create", {
        accountType: activeAccount,
        kind: isWallet ? "transfer.wallet" : "transfer.user",
        ...(isWallet ? { toAddress: schRecipient.trim() } : { recipient: schRecipient.trim() }),
        amountUsdc: Number(schAmt),
        frequency: schFreq,
        day: schFreq === "daily" ? undefined : schDay.trim(),
        time: schTime.trim() || "09:00",
      });
      setNotice(res.notice || "Recurring schedule created!");
      setSchRecipient("");
      setSchAmt("");
      loadTab(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create schedule.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleRedeemRewards = async () => {
    setError(null);
    try {
      const res = await requestApproval("rewards.redeem", {
        points: Number(redeemPts),
        rewardType: redeemType,
      });
      setNotice(res.notice || "Rewards redeemed!");
      loadTab(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Redemption failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadTab(true)} tintColor={COLORS.primary} />
      }
      keyboardShouldPersistTaps="handled"
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pill label="Profile" active={tab === "general"} onPress={() => setTab("general")} />
          <Pill label="Verify ID" active={tab === "kyc"} onPress={() => setTab("kyc")} />
          <Pill label="Security" active={tab === "security"} onPress={() => setTab("security")} />
          <Pill label="Contacts" active={tab === "contacts"} onPress={() => setTab("contacts")} />
          <Pill label="Schedules" active={tab === "schedules"} onPress={() => setTab("schedules")} />
          <Pill label="Rewards" active={tab === "rewards"} onPress={() => setTab("rewards")} />
        </View>
      </ScrollView>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

      {/* GENERAL */}
      {tab === "general" ? (
        <>
          <Card>
            <SectionHeader title="Account Profile" />
            <KeyValueRow label="Account ID" value={user?.id || "—"} />
            <KeyValueRow label="Username" value={user?.username ? `@${user.username}` : "Not set"} />
            <KeyValueRow label="Phone" value={user?.phone || "Not linked"} />
            <KeyValueRow label="Telegram Bot Linked" value={user?.telegramLinked ? "Yes" : "No"} />

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>Auto-Earn Yield</Text>
                <Text style={styles.rowSub}>Automatically put idle USDC to work in savings</Text>
              </View>
              <Switch
                value={Boolean(user?.autoEarnEnabled)}
                onValueChange={handleToggleAutoEarn}
                trackColor={{ true: COLORS.primary, false: COLORS.borderStrong }}
              />
            </View>
          </Card>

          <Card>
            <SectionHeader title="Bank Payout Sender Name" />
            <Input
              label="Personal Sender Name"
              placeholder="Your full name on bank receipts"
              value={senderName}
              onChangeText={setSenderName}
            />
            {user?.hasBusinessAccount ? (
              <Input
                label="Business Sender Name"
                placeholder="Company name on bank receipts"
                value={bizSenderName}
                onChangeText={setBizSenderName}
              />
            ) : null}
            <Button title="Save Profile" onPress={handleSaveProfile} loading={loading} />
          </Card>

          <Card>
            <SectionHeader title="App Updates (Automatic OTA)" />
            <KeyValueRow label="Runtime" value={ota.runtimeVersion ? `v${ota.runtimeVersion}` : "1"} />
            <KeyValueRow
              label="Installed Build"
              value={ota.updateId ? `OTA · ${ota.updateId.slice(0, 8)}` : "Embedded release"}
            />
            {ota.statusMessage ? (
              <Text style={[styles.rowSub, { marginVertical: 8 }]}>{ota.statusMessage}</Text>
            ) : null}
            {ota.updateReady ? (
              <Button title="Apply Downloaded Update" onPress={ota.applyNow} style={{ marginTop: 8 }} />
            ) : (
              <Button
                title="Check for Updates"
                variant="secondary"
                onPress={() => ota.checkNow({ silent: false })}
                loading={ota.checking}
                style={{ marginTop: 8 }}
              />
            )}
          </Card>

          <Card>
            <SectionHeader title="Statements & Session" />
            <Button
              title={`Export ${activeAccount === "business" ? "Business" : "Personal"} Statement (CSV)`}
              variant="secondary"
              onPress={handleExportCsv}
              loading={loading}
              style={{ marginBottom: 10 }}
            />
            <Button
              title="Sign Out"
              variant="danger"
              onPress={() =>
                Alert.alert("Sign Out", "Sign out of Proxim on this device?", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Sign Out", style: "destructive", onPress: () => signOut() },
                ])
              }
            />
          </Card>
        </>
      ) : null}

      {/* KYC / KYB */}
      {tab === "kyc" ? (
        <Card>
          <SectionHeader
            title="ID Verification & Limits"
            right={
              <Pill
                label="Refresh"
                onPress={() =>
                  api
                    .refreshKycStatus(activeAccount)
                    .then((r) => {
                      setKyc(r);
                      setNotice("Verification status synced.");
                    })
                    .catch((e) => setError(e.message))
                }
              />
            }
          />
          {kyc ? (
            <>
              <KeyValueRow label="Personal Status" value={`${kyc.personal.status} (Tier ${kyc.personal.tier})`} />
              <KeyValueRow label="Business Status" value={`${kyc.business.status} (Tier ${kyc.business.tier})`} />
              <KeyValueRow
                label="Hourly Used / Limit"
                value={`${formatUsdc(kyc.limits.usedHourlyUsd)} / ${formatUsdc(kyc.limits.hourlyUsd)}`}
              />
              <KeyValueRow
                label="Daily Used / Limit"
                value={`${formatUsdc(kyc.limits.usedDailyUsd)} / ${formatUsdc(kyc.limits.dailyUsd)}`}
              />
              {kyc.personal.rejectionReason ? (
                <ErrorBanner message={`Reason: ${kyc.personal.rejectionReason}`} />
              ) : null}
            </>
          ) : null}

          <Button
            title={kycFormOpen ? "Hide Verification Form" : "Start Personal KYC Verification"}
            variant="secondary"
            onPress={() => setKycFormOpen((v) => !v)}
            style={{ marginTop: 12 }}
          />

          {kycFormOpen ? (
            <View style={{ marginTop: 14 }}>
              <Input label="First Name" value={firstName} onChangeText={setFirstName} />
              <Input label="Last Name" value={lastName} onChangeText={setLastName} />
              <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
              <Input label="Phone (+international)" value={phoneNumber} onChangeText={setPhoneNumber} keyboardType="phone-pad" />
              <Input label="Date of Birth (YYYY-MM-DD)" placeholder="1995-05-15" value={dob} onChangeText={setDob} />
              <View style={styles.pillRow}>
                <Pill label="Male" active={gender === "male"} onPress={() => setGender("male")} />
                <Pill label="Female" active={gender === "female"} onPress={() => setGender("female")} />
              </View>
              <Input label="2-Letter Country Code (e.g. NG, GB, US)" value={countryCode} onChangeText={setCountryCode} autoCapitalize="characters" maxLength={2} />
              <Input label="Street Address" value={street} onChangeText={setStreet} />
              <Input label="City" value={city} onChangeText={setCity} />
              <Input label="State / Region" value={stateRegion} onChangeText={setStateRegion} />
              <Input label="Postal Code" value={postalCode} onChangeText={setPostalCode} />
              <Input label="ID Document Type (passport, national_id, drivers_license)" value={idType} onChangeText={setIdType} autoCapitalize="none" />
              <Input label="ID Document Number" value={idNumber} onChangeText={setIdNumber} />
              <Button title="Submit Identity Verification" onPress={handleSubmitKyc} loading={loading} />
            </View>
          ) : null}

          {user?.hasBusinessAccount ? (
            <>
              <Button
                title={kybFormOpen ? "Hide Business KYB Form" : "Start Business KYB Verification"}
                variant="secondary"
                onPress={() => setKybFormOpen((v) => !v)}
                style={{ marginTop: 10 }}
              />

              {kybFormOpen ? (
                <View style={{ marginTop: 14 }}>
                  <Input label="Business Legal Name" value={bizLegalName} onChangeText={setBizLegalName} />
                  <Input label="Registration / RC Number" value={bizRegNo} onChangeText={setBizRegNo} />
                  <Input label="2-Letter Incorporation Country (e.g. NG, US, GB)" value={bizCountry} onChangeText={setBizCountry} autoCapitalize="characters" maxLength={2} />
                  <Input label="Incorporation Year (YYYY)" placeholder="2023" value={bizIncYear} onChangeText={setBizIncYear} keyboardType="number-pad" maxLength={4} />
                  <Input label="Incorporation Month (1-12)" placeholder="6" value={bizIncMonth} onChangeText={setBizIncMonth} keyboardType="number-pad" maxLength={2} />
                  <Input label="Industry" placeholder="Software / Consulting / Retail" value={bizIndustry} onChangeText={setBizIndustry} />
                  <View style={styles.pillRow}>
                    {(["llc", "corporation", "sole_proprietorship", "partnership"] as const).map((bt) => (
                      <Pill key={bt} label={bt.replace("_", " ")} active={bizType === bt} onPress={() => setBizType(bt)} />
                    ))}
                  </View>
                  <Input label="Business Email" value={bizEmail} onChangeText={setBizEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Business Phone (+international)" value={bizPhone} onChangeText={setBizPhone} keyboardType="phone-pad" />
                  <Input label="Business Street Address" value={bizStreet} onChangeText={setBizStreet} />
                  <Input label="City" value={bizCity} onChangeText={setBizCity} />
                  <Input label="State / Region" value={bizState} onChangeText={setBizState} />
                  <Input label="Postal Code" value={bizPostal} onChangeText={setBizPostal} />
                  <Input label="Officer First Name" value={officerFirst} onChangeText={setOfficerFirst} />
                  <Input label="Officer Last Name" value={officerLast} onChangeText={setOfficerLast} />
                  <Input label="Officer Email" value={officerEmail} onChangeText={setOfficerEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Officer Date of Birth (YYYY-MM-DD)" placeholder="1990-01-20" value={officerDob} onChangeText={setOfficerDob} />
                  <Input label="Officer Title" value={officerTitle} onChangeText={setOfficerTitle} />
                  <Button title="Submit Business KYB Verification" onPress={handleSubmitKyb} loading={loading} />
                </View>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* SECURITY & DEVICES */}
      {tab === "security" ? (
        <>
          <Card>
            <SectionHeader title="Wallet PIN" />
            <Text style={styles.rowSub}>
              Re-encrypt your Personal and Business keys with a new 4-digit PIN (Passkey required).
            </Text>
            <Button title="Change 4-digit PIN" variant="secondary" onPress={handleChangePin} style={{ marginTop: 12 }} />
          </Card>

          <Card>
            <SectionHeader title="Signed-in Devices" />
            {devices.length === 0 ? (
              <EmptyState icon="phone-portrait-outline" title="No active devices found" />
            ) : (
              devices.map((d) => (
                <View key={d.id} style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>
                      {d.name || d.platform} {d.current ? "(This device)" : ""}
                    </Text>
                    <Text style={styles.rowSub}>
                      {d.platform.toUpperCase()}
                      {d.restrictedUntil ? ` · Limited until ${d.restrictedUntil}` : ""}
                    </Text>
                  </View>
                  {!d.current ? (
                    <Button
                      title="Remove"
                      variant="danger"
                      onPress={() => handleRevokeDevice(d.id)}
                      style={{ height: 34, paddingHorizontal: 12 }}
                    />
                  ) : null}
                </View>
              ))
            )}
          </Card>
        </>
      ) : null}

      {/* CONTACTS */}
      {tab === "contacts" ? (
        <Card>
          <SectionHeader title="Saved Contacts" />
          <Input label="Name" placeholder="Ada" value={cName} onChangeText={setCName} />
          <Input label="Wallet Address (optional 0x...)" value={cWallet} onChangeText={setCWallet} autoCapitalize="none" />
          <Input label="Bank Name (optional)" value={cBank} onChangeText={setCBank} />
          <Input label="10-Digit Account No. (optional)" value={cAcct} onChangeText={setCAcct} keyboardType="number-pad" maxLength={10} />
          <Button title="Save Contact" onPress={handleAddContact} loading={loading} style={{ marginBottom: 14 }} />

          {contacts.length === 0 ? (
            <EmptyState icon="people-outline" title="No contacts yet" />
          ) : (
            contacts.map((c) => (
              <View key={c.name} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{c.name}</Text>
                  <Text style={styles.rowSub}>
                    {c.walletAddress || (c.bankName ? `${c.bankName} · ${c.accountNumber}` : "—")}
                  </Text>
                </View>
                <Button
                  title="Delete"
                  variant="danger"
                  onPress={() =>
                    api
                      .deleteContact(c.name)
                      .then(() => loadTab(true))
                      .catch((e) => setError(e.message))
                  }
                  style={{ height: 32, paddingHorizontal: 10 }}
                />
              </View>
            ))
          )}
        </Card>
      ) : null}

      {/* SCHEDULES */}
      {tab === "schedules" ? (
        <Card>
          <SectionHeader title="Recurring Payments" />
          <Input
            label="Recipient (@username, +phone, or 0x wallet)"
            value={schRecipient}
            onChangeText={setSchRecipient}
            autoCapitalize="none"
          />
          <Input label="Amount (USDC)" value={schAmt} onChangeText={setSchAmt} keyboardType="decimal-pad" />
          <View style={styles.pillRow}>
            {(["daily", "weekly", "monthly"] as const).map((f) => (
              <Pill key={f} label={f} active={schFreq === f} onPress={() => setSchFreq(f)} />
            ))}
          </View>
          {schFreq !== "daily" ? (
            <Input
              label={schFreq === "weekly" ? "Day of week (e.g. friday)" : "Day of month (1-28)"}
              value={schDay}
              onChangeText={setSchDay}
              autoCapitalize="none"
            />
          ) : null}
          <Input label="Time (HH:MM UTC)" value={schTime} onChangeText={setSchTime} />
          <Button title="Create Recurring Schedule" onPress={handleCreateSchedule} style={{ marginBottom: 14 }} />

          {schedules.length === 0 ? (
            <EmptyState icon="calendar-outline" title="No recurring schedules" />
          ) : (
            schedules.map((s) => (
              <View key={s.id} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{s.label || `${s.frequency} · ${s.kind}`}</Text>
                  <Text style={styles.rowSub}>
                    Status: {s.status} {s.nextRunAt ? `· Next: ${s.nextRunAt.slice(0, 16)}` : ""}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {s.status === "active" ? (
                    <Pill
                      label="Pause"
                      onPress={() => api.updateScheduleStatus(s.id, "pause").then(() => loadTab(true)).catch((e) => setError(e.message))}
                    />
                  ) : s.status === "paused" ? (
                    <Pill
                      label="Resume"
                      active
                      onPress={() => api.updateScheduleStatus(s.id, "resume").then(() => loadTab(true)).catch((e) => setError(e.message))}
                    />
                  ) : null}
                  {s.status !== "cancelled" ? (
                    <Pill
                      label="Cancel"
                      tone="danger"
                      active
                      onPress={() => api.updateScheduleStatus(s.id, "cancel").then(() => loadTab(true)).catch((e) => setError(e.message))}
                    />
                  ) : null}
                </View>
              </View>
            ))
          )}
        </Card>
      ) : null}

      {/* REWARDS */}
      {tab === "rewards" ? (
        <Card>
          <SectionHeader title="Proxim Rewards & Referrals" />
          {rewards ? (
            <>
              <Text style={styles.pointsHero}>{rewards.pointsBalance} pts</Text>
              <Text style={styles.rowSub}>
                Value: {formatUsdc(rewards.redeemValueUsd)} ({rewards.pointsPerUsd} pts = $1 · Min {rewards.minRedeemPoints} pts)
              </Text>
              <View style={{ marginVertical: 12 }}>
                <KeyValueRow
                  label="Referral Code"
                  value={rewards.referralCode}
                  onCopy={() => {
                    Clipboard.setStringAsync(rewards.referralCode);
                    setNotice("Referral code copied!");
                  }}
                />
                <KeyValueRow label="Friends Referred" value={String(rewards.referredCount)} />
              </View>
              <Button
                title="Share Referral Link"
                variant="secondary"
                onPress={() => Share.share({ message: rewards.referralLink })}
                style={{ marginBottom: 14 }}
              />
              <View style={styles.pillRow}>
                {(["cashback", "airtime", "bills"] as const).map((rt) => (
                  <Pill key={rt} label={rt} active={redeemType === rt} onPress={() => setRedeemType(rt)} />
                ))}
              </View>
              <Input
                label="Points to Redeem"
                value={redeemPts}
                onChangeText={setRedeemPts}
                keyboardType="number-pad"
              />
              <Button title="Redeem Points" onPress={handleRedeemRewards} />
            </>
          ) : null}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 40 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 12,
    gap: 12,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 10,
  },
  rowTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  rowSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  pointsHero: { color: COLORS.primary, fontSize: 32, fontWeight: "800" },
});
