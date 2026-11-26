import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
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
import { getDocumentPicker, getImagePicker, getLegacyFileSystem } from "../nativeModules";
import { toUserError } from "../utils/errors";
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
import { COLORS, SPACING, FONTS } from "../theme";
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
import { EditableAvatar } from "../components/Avatar";

type ProfileTab = "general" | "kyc" | "security" | "contacts" | "schedules" | "rewards";
type PickedDoc = { base64: string; mimeType: string; name: string };
type DocSlot =
  | "kyc_front"
  | "kyc_back"
  | "kyc_poa"
  | "kyb_coi"
  | "kyb_memart"
  | "kyb_biz_poa"
  | "kyb_officer_id_front"
  | "kyb_officer_id_back"
  | "kyb_officer_poa";

const MAX_DOC_BASE64_CHARS = Math.ceil(6 * 1024 * 1024 * 1.37); // ~6MB raw file per document

function inferMimeFromName(name: string, fallback: string): string {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return fallback;
}

export function ProfileScreen({
  initialTab = "general",
  initialVerifyMode = null,
}: {
  initialTab?: ProfileTab;
  initialVerifyMode?: "kyc" | "kyb" | null;
} = {}) {
  const { user, activeAccount, dataVersion, refreshMe, signOut, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";
  const ota = useAutoOtaUpdates();
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // General
  const [senderName, setSenderName] = useState(user?.savedSenderName || user?.senderName || "");
  const [bizSenderName, setBizSenderName] = useState(user?.bizSenderName || "");

  // KYC/KYB
  const [kyc, setKyc] = useState<KycStatusResponse | null>(null);
  const [kycFormOpen, setKycFormOpen] = useState(initialVerifyMode === "kyc");
  const [kybFormOpen, setKybFormOpen] = useState(initialVerifyMode === "kyb");
  useEffect(() => {
    if (initialVerifyMode === "kyc") {
      setKycFormOpen(true);
      setKybFormOpen(false);
    } else if (initialVerifyMode === "kyb") {
      setKybFormOpen(true);
      setKycFormOpen(false);
    }
  }, [initialVerifyMode]);

  // Personal KYC fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [countryCode, setCountryCode] = useState("NG");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateRegion, setStateRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [idType, setIdType] = useState<"international_passport" | "national_id" | "drivers_license">("international_passport");
  const [idNumber, setIdNumber] = useState("");
  const [idIssueDate, setIdIssueDate] = useState("");
  const [idExpiryDate, setIdExpiryDate] = useState("");
  const [idIssuingAuthority, setIdIssuingAuthority] = useState("");
  const [bvn, setBvn] = useState("");
  const [nin, setNin] = useState("");
  const [ssn, setSsn] = useState("");
  const [docIdFront, setDocIdFront] = useState<PickedDoc | null>(null);
  const [docIdBack, setDocIdBack] = useState<PickedDoc | null>(null);
  const [docPoa, setDocPoa] = useState<PickedDoc | null>(null);

  // Business KYB fields (full Nuvion 2026-02-06 schema)
  const [bizLegalName, setBizLegalName] = useState("");
  const [bizTradeName, setBizTradeName] = useState("");
  const [bizRegNo, setBizRegNo] = useState("");
  const [bizTaxId, setBizTaxId] = useState("");
  const [bizCountry, setBizCountry] = useState("NG");
  const [bizIncState, setBizIncState] = useState("");
  const [bizIncYear, setBizIncYear] = useState("");
  const [bizIncMonth, setBizIncMonth] = useState("");
  const [bizIndustry, setBizIndustry] = useState("");
  const [bizDescription, setBizDescription] = useState("");
  const [bizType, setBizType] = useState<"llc" | "corporation" | "sole_proprietorship" | "partnership">("llc");
  const [bizEmail, setBizEmail] = useState("");
  const [bizPhone, setBizPhone] = useState("");
  const [bizWebsite, setBizWebsite] = useState("");
  const [bizStreet, setBizStreet] = useState("");
  const [bizCity, setBizCity] = useState("");
  const [bizState, setBizState] = useState("");
  const [bizPostal, setBizPostal] = useState("");
  // Controlling officer / beneficial owner (>=25%)
  const [officerFirst, setOfficerFirst] = useState("");
  const [officerLast, setOfficerLast] = useState("");
  const [officerEmail, setOfficerEmail] = useState("");
  const [officerPhone, setOfficerPhone] = useState("");
  const [officerDob, setOfficerDob] = useState("");
  const [officerGender, setOfficerGender] = useState<"male" | "female">("male");
  const [officerNationality, setOfficerNationality] = useState("NG");
  const [officerTitle, setOfficerTitle] = useState("Director");
  const [officerOwnership, setOfficerOwnership] = useState("100");
  const [officerIdType, setOfficerIdType] = useState<"international_passport" | "national_id" | "drivers_license">("international_passport");
  const [officerIdNumber, setOfficerIdNumber] = useState("");
  const [officerIdIssueDate, setOfficerIdIssueDate] = useState("");
  const [officerIdExpiryDate, setOfficerIdExpiryDate] = useState("");
  const [officerIdAuthority, setOfficerIdAuthority] = useState("");
  const [officerBvn, setOfficerBvn] = useState("");
  const [officerNin, setOfficerNin] = useState("");
  const [officerSsn, setOfficerSsn] = useState("");
  // Required KYB documents (all 5)
  const [docKybCoi, setDocKybCoi] = useState<PickedDoc | null>(null);
  const [docKybMemart, setDocKybMemart] = useState<PickedDoc | null>(null);
  const [docKybBizPoa, setDocKybBizPoa] = useState<PickedDoc | null>(null);
  const [docKybOfficerIdFront, setDocKybOfficerIdFront] = useState<PickedDoc | null>(null);
  const [docKybOfficerIdBack, setDocKybOfficerIdBack] = useState<PickedDoc | null>(null);
  const [docKybOfficerPoa, setDocKybOfficerPoa] = useState<PickedDoc | null>(null);

  const assignPickedDoc = (slot: DocSlot, picked: PickedDoc) => {
    switch (slot) {
      case "kyc_front": setDocIdFront(picked); break;
      case "kyc_back": setDocIdBack(picked); break;
      case "kyc_poa": setDocPoa(picked); break;
      case "kyb_coi": setDocKybCoi(picked); break;
      case "kyb_memart": setDocKybMemart(picked); break;
      case "kyb_biz_poa": setDocKybBizPoa(picked); break;
      case "kyb_officer_id_front": setDocKybOfficerIdFront(picked); break;
      case "kyb_officer_id_back": setDocKybOfficerIdBack(picked); break;
      case "kyb_officer_poa": setDocKybOfficerPoa(picked); break;
    }
  };

  const pickFileDocument = async (slot: DocSlot, mimeTypes: string[], fallbackMime: string) => {
    if (Platform.OS === "web") {
      setError("Use the Proxim mobile app to upload verification documents.");
      return;
    }
    const DocPicker = getDocumentPicker();
    const FS = getLegacyFileSystem();
    if (!DocPicker || !FS?.readAsStringAsync) {
      Alert.alert(
        "Update Proxim APK for PDF / File Uploads",
        "Your installed Proxim build doesn't include PDF/document file upload yet. Install the latest Proxim APK once to attach PDFs and DOCX files.",
        [
          { text: "Not now", style: "cancel" },
          {
            text: "Download APK",
            onPress: () =>
              Linking.openURL("https://github.com/igboze/PayIt/releases/download/android-latest/Proxim.apk").catch(
                () => {}
              ),
          },
        ]
      );
      return;
    }
    try {
      const res = await DocPicker.getDocumentAsync({
        type: mimeTypes,
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = res.assets?.[0];
      if (res.canceled || !asset?.uri) return;
      const base64 = await FS.readAsStringAsync(asset.uri, { encoding: "base64" as never });
      if (!base64) {
        setError("Couldn't read that file. Please try another file.");
        return;
      }
      if (base64.length > MAX_DOC_BASE64_CHARS) {
        setError("That file is too large (max 6 MB per document). Please compress it and try again.");
        return;
      }
      const name = asset.name || `${slot}.pdf`;
      const mimeType = (asset.mimeType || inferMimeFromName(name, fallbackMime)).toLowerCase();
      if (!mimeTypes.includes(mimeType) && !mimeTypes.includes("*/*")) {
        setError(`Unsupported file type (${mimeType}). Please select one of: ${mimeTypes.join(", ")}`);
        return;
      }
      assignPickedDoc(slot, { base64, mimeType, name });
      setError(null);
    } catch (err) {
      setError(toUserError(err, "Could not attach document file."));
    }
  };

  const pickPhotoDocument = async (slot: DocSlot, fromCamera = false) => {
    if (Platform.OS === "web") {
      setError("Use the Proxim mobile app to upload verification documents.");
      return;
    }
    const Picker = getImagePicker();
    if (!Picker) {
      Alert.alert(
        "Reinstall latest APK",
        "Your installed Proxim build doesn't include photo upload yet. Download and install the latest APK once.",
        [
          { text: "Not now", style: "cancel" },
          {
            text: "Download APK",
            onPress: () =>
              Linking.openURL("https://github.com/igboze/PayIt/releases/download/android-latest/Proxim.apk").catch(
                () => {}
              ),
          },
        ]
      );
      return;
    }
    try {
      const perm = fromCamera
        ? await Picker.requestCameraPermissionsAsync()
        : await Picker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError(fromCamera ? "Allow camera access to take a document photo." : "Allow photo library access to attach a document.");
        return;
      }
      const opts = { mediaTypes: ["images"] as never, allowsEditing: false, quality: 0.65, base64: true };
      const res = fromCamera ? await Picker.launchCameraAsync(opts) : await Picker.launchImageLibraryAsync(opts);
      const asset = res.assets?.[0];
      if (res.canceled || !asset) return;
      let base64 = asset.base64 || null;
      if (!base64 && asset.uri) {
        const FS = getLegacyFileSystem();
        if (FS?.readAsStringAsync) {
          base64 = await FS.readAsStringAsync(asset.uri, { encoding: "base64" as never });
        }
      }
      if (!base64) {
        setError("Couldn't read that photo. Please pick another image.");
        return;
      }
      if (base64.length > MAX_DOC_BASE64_CHARS) {
        setError("That photo is too large (max 6 MB). Please choose a smaller image.");
        return;
      }
      const name = asset.fileName || `${slot}.jpg`;
      assignPickedDoc(slot, {
        base64,
        mimeType: (asset.mimeType || inferMimeFromName(name, "image/jpeg")).toLowerCase(),
        name,
      });
      setError(null);
    } catch (err) {
      setError(toUserError(err, "Could not attach document photo."));
    }
  };

  const promptPickImageOrPdf = (slot: DocSlot, title: string) => {
    const imgPdfMimes = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
    Alert.alert(title, "Choose how to attach this document (PDF, JPG, or PNG):", [
      { text: "Cancel", style: "cancel" },
      { text: "📄 Pick File (PDF / Image)", onPress: () => pickFileDocument(slot, imgPdfMimes, "application/pdf") },
      { text: "🖼️ Photo Library", onPress: () => pickPhotoDocument(slot, false) },
      { text: "📷 Take Photo", onPress: () => pickPhotoDocument(slot, true) },
    ]);
  };

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
    const cc = (countryCode || "NG").trim().toUpperCase();
    if (!firstName.trim() || !lastName.trim()) {
      setError("Please enter your legal first and last name.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!phoneNumber.trim()) {
      setError("Please enter your phone number.");
      return;
    }
    if (!dob.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dob.trim())) {
      setError("Please enter your date of birth as YYYY-MM-DD (e.g. 1995-05-15).");
      return;
    }
    if (!street.trim() || !city.trim()) {
      setError("Please enter your residential street address and city.");
      return;
    }
    if (!idNumber.trim()) {
      setError("Please enter your ID document number.");
      return;
    }
    if (!stateRegion.trim() || !postalCode.trim()) {
      setError("Please enter your State / Region and Postal Code.");
      return;
    }
    if (cc === "NG" && (bvn.trim().length !== 11 || nin.trim().length !== 11)) {
      setError("Nigerian verification requires both your 11-digit BVN and 11-digit NIN.");
      return;
    }
    if (cc === "US" && !ssn.trim()) {
      setError("US verification requires your SSN.");
      return;
    }
    if (!docIdFront || !docPoa) {
      setError("Please attach photos of both your Government ID (front) and Proof of Address.");
      return;
    }

    setLoading(true);
    try {
      const res = await api.submitKyc({
        countryCode: cc,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phoneNumber: phoneNumber.trim(),
        dateOfBirth: dob.trim(),
        gender,
        ...(cc === "NG" ? { bvn: bvn.trim(), nin: nin.trim() } : {}),
        ...(cc === "US" && ssn.trim() ? { ssn: ssn.trim() } : {}),
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
          ...(idIssueDate.trim() ? { issueDate: idIssueDate.trim() } : {}),
          ...(idExpiryDate.trim() ? { expiryDate: idExpiryDate.trim() } : {}),
          ...(idIssuingAuthority.trim() ? { issuingAuthority: idIssuingAuthority.trim() } : {}),
          country: cc,
        },
        documents: {
          idFrontBase64: docIdFront.base64,
          idFrontMimeType: docIdFront.mimeType,
          ...(docIdBack ? { idBackBase64: docIdBack.base64 } : {}),
          proofOfAddressBase64: docPoa.base64,
          proofOfAddressMimeType: docPoa.mimeType,
        },
      });
      setNotice(`Personal KYC submitted! (Status: ${res.status.toUpperCase()}).`);
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
    const cc = (bizCountry || "NG").trim().toUpperCase();
    const offNat = (officerNationality || cc).trim().toUpperCase();
    const yr = Number(bizIncYear);
    const mo = Number(bizIncMonth);
    const ownPct = Number(officerOwnership || "100");
    const curYr = new Date().getUTCFullYear();

    if (!bizLegalName.trim()) {
      setError("Please enter your registered Business Legal Name.");
      return;
    }
    if (!bizRegNo.trim()) {
      setError("Please enter your Registration / RC Number.");
      return;
    }
    if (!bizTaxId.trim()) {
      setError("Please enter your Business Tax ID (TIN).");
      return;
    }
    if (!/^[A-Z]{2}$/.test(cc)) {
      setError("Enter a valid 2-letter Incorporation Country code (e.g. NG, US, GB).");
      return;
    }
    if (!bizIncState.trim()) {
      setError("Please enter your Incorporation State / Province.");
      return;
    }
    if (!Number.isInteger(yr) || yr < 1900 || yr > curYr) {
      setError(`Incorporation Year must be between 1900 and ${curYr}.`);
      return;
    }
    if (!Number.isInteger(mo) || mo < 1 || mo > 12) {
      setError("Incorporation Month must be between 1 and 12.");
      return;
    }
    if (!bizIndustry.trim()) {
      setError("Please enter your business industry (e.g. Technology, Retail, Consulting).");
      return;
    }
    if (!bizDescription.trim() || bizDescription.trim().length < 5) {
      setError("Please enter a short description of what your business does.");
      return;
    }
    if (!bizEmail.trim() || !bizEmail.includes("@")) {
      setError("Please enter a valid business email address.");
      return;
    }
    if (!bizPhone.trim()) {
      setError("Please enter a business phone number in international format (e.g. +2348012345678).");
      return;
    }
    if (bizStreet.trim().length < 4 || !bizCity.trim() || !bizState.trim() || !bizPostal.trim()) {
      setError("Please enter your full registered business address (Street 4+ chars, City, State, Postal Code).");
      return;
    }
    if (!officerFirst.trim() || !officerLast.trim()) {
      setError("Please enter the controlling officer / director's First and Last Name.");
      return;
    }
    if (!officerEmail.trim() || !officerEmail.includes("@")) {
      setError("Please enter a valid email address for the controlling officer.");
      return;
    }
    if (!officerPhone.trim()) {
      setError("Please enter the controlling officer's phone number (+international).");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(officerDob.trim())) {
      setError("Please enter the officer's Date of Birth as YYYY-MM-DD (e.g. 1990-01-20).");
      return;
    }
    if (!officerTitle.trim()) {
      setError("Please enter the officer's Job Title (e.g. Director, CEO).");
      return;
    }
    if (!Number.isFinite(ownPct) || ownPct < 0 || ownPct > 100) {
      setError("Officer Ownership Percentage must be between 0 and 100.");
      return;
    }
    if (!officerIdNumber.trim()) {
      setError("Please enter the officer's Government ID Number.");
      return;
    }
    if ((offNat === "NG" || cc === "NG") && (officerBvn.trim().length !== 11 || officerNin.trim().length !== 11)) {
      setError("Nigerian directors/owners require both an 11-digit BVN and 11-digit NIN.");
      return;
    }
    if ((offNat === "US" || cc === "US") && !/^\d{9,}$/.test(officerSsn.trim().replace(/-/g, ""))) {
      setError("U.S. directors/owners require a valid 9-digit SSN.");
      return;
    }
    if (!docKybCoi || !docKybMemart || !docKybBizPoa || !docKybOfficerIdFront || !docKybOfficerPoa) {
      setError(
        "Please upload all 5 required KYB documents: Certificate of Incorporation (PDF), Memorandum & Articles of Association (PDF/DOCX), Business Proof of Address, Officer ID, and Officer Proof of Address."
      );
      return;
    }

    setLoading(true);
    try {
      const res = await api.submitKyb({
        legalName: bizLegalName.trim(),
        ...(bizTradeName.trim() ? { tradeName: bizTradeName.trim() } : {}),
        registrationNumber: bizRegNo.trim(),
        taxId: bizTaxId.trim(),
        incorporationCountry: cc,
        incorporationState: bizIncState.trim(),
        incorporationYear: yr,
        incorporationMonth: mo,
        industry: bizIndustry.trim(),
        description: bizDescription.trim(),
        businessType: bizType,
        email: bizEmail.trim(),
        phoneNumber: bizPhone.trim(),
        ...(bizWebsite.trim() ? { website: bizWebsite.trim() } : {}),
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
          phoneNumber: officerPhone.trim(),
          dateOfBirth: officerDob.trim(),
          gender: officerGender,
          nationality: offNat,
          jobTitle: officerTitle.trim(),
          ownershipPercentage: ownPct,
          isControlPerson: true,
          isBeneficialOwner: ownPct >= 25,
          ...(offNat === "NG" || cc === "NG" ? { bvn: officerBvn.trim(), nin: officerNin.trim() } : {}),
          ...(offNat === "US" || cc === "US" ? { ssn: officerSsn.trim() } : {}),
          idDocument: {
            type: officerIdType,
            number: officerIdNumber.trim(),
            ...(officerIdIssueDate.trim() ? { issueDate: officerIdIssueDate.trim() } : {}),
            ...(officerIdExpiryDate.trim() ? { expiryDate: officerIdExpiryDate.trim() } : {}),
            ...(officerIdAuthority.trim() ? { issuingAuthority: officerIdAuthority.trim() } : {}),
            country: offNat,
          },
        },
        documents: {
          coiBase64: docKybCoi.base64,
          coiMimeType: docKybCoi.mimeType,
          memartBase64: docKybMemart.base64,
          memartMimeType: docKybMemart.mimeType,
          businessPoaBase64: docKybBizPoa.base64,
          businessPoaMimeType: docKybBizPoa.mimeType,
          officerIdFrontBase64: docKybOfficerIdFront.base64,
          officerIdMimeType: docKybOfficerIdFront.mimeType,
          ...(docKybOfficerIdBack ? { officerIdBackBase64: docKybOfficerIdBack.base64 } : {}),
          officerPoaBase64: docKybOfficerPoa.base64,
          officerPoaMimeType: docKybOfficerPoa.mimeType,
        },
      });
      setNotice(`Business KYB submitted! (Status: ${res.status.toUpperCase()}).`);
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
      <View style={{ alignItems: "center", gap: 6, marginBottom: 16 }}>
        <EditableAvatar size={96} />
        <Text style={{ fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text, marginTop: 6 }}>
          {isBiz
            ? user?.bizSenderName || "Business Account"
            : user?.senderName || (user?.username ? `@${user.username}` : "Your profile")}
        </Text>
        <Text style={{ fontFamily: FONTS.medium, fontSize: 13, color: isBiz ? COLORS.business : COLORS.textSecondary }}>
          {isBiz ? "Business Workspace · Tap photo to change" : "Personal Account · Tap photo to change"}
        </Text>
      </View>
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
                <Text style={styles.rowSub}>Automatically put idle money to work in savings</Text>
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

      {/* KYC / KYB — strictly separated Personal KYC & Business KYB cards */}
      {tab === "kyc" ? (
        <>
          <Card>
            <SectionHeader
              title="Verification Status & Limits"
              right={
                <Pill
                  label="Sync Status"
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
                <KeyValueRow
                  label="Personal KYC Status"
                  value={`${kyc.personal.status.toUpperCase()} (Tier ${kyc.personal.tier})`}
                />
                <KeyValueRow
                  label="Business KYB Status"
                  value={
                    user?.hasBusinessAccount
                      ? `${kyc.business.status.toUpperCase()} (Tier ${kyc.business.tier})`
                      : "No Business Account"
                  }
                />
                <KeyValueRow
                  label="Hourly Used / Limit"
                  value={
                    balanceHidden
                      ? `•••• / ${formatUsdc(kyc.limits.hourlyUsd)}`
                      : `${formatUsdc(kyc.limits.usedHourlyUsd)} / ${formatUsdc(kyc.limits.hourlyUsd)}`
                  }
                />
                <KeyValueRow
                  label={isBiz ? "Business Daily Limit" : "Personal Daily Used / Limit"}
                  value={
                    isBiz
                      ? formatUsdc(kyc.limits.businessDailyUsd)
                      : balanceHidden
                        ? `•••• / ${formatUsdc(kyc.limits.dailyUsd)}`
                        : `${formatUsdc(kyc.limits.usedDailyUsd)} / ${formatUsdc(kyc.limits.dailyUsd)}`
                  }
                />
                {kyc.personal.rejectionReason ? (
                  <ErrorBanner message={`Personal KYC note: ${kyc.personal.rejectionReason}`} />
                ) : null}
                {kyc.business.rejectionReason ? (
                  <ErrorBanner message={`Business KYB note: ${kyc.business.rejectionReason}`} />
                ) : null}
              </>
            ) : null}
          </Card>

          {/* Business KYB Card (shown FIRST when in Business workspace) */}
          {isBiz ? (
            <Card style={{ borderColor: COLORS.businessBorder }}>
              <SectionHeader
                title="Business Verification (KYB)"
                right={
                  <Text style={[styles.rowSub, { color: COLORS.business, fontFamily: FONTS.bold }]}>
                    {kyc ? `Tier ${kyc.business.tier} · ${kyc.business.status}` : ""}
                  </Text>
                }
              />
              <Text style={styles.rowSub}>
                Unlocks named Company Global Accounts (USD, GBP, EUR, CAD, AED, GHS, KES, TZS), Team USD Cards, and 27-currency payroll.
              </Text>
              <Button
                title={kybFormOpen ? "Hide Business KYB Form" : "Start Business KYB Verification"}
                variant={kybFormOpen ? "secondary" : "primary"}
                onPress={() => setKybFormOpen((v) => !v)}
                style={{ marginTop: 12 }}
              />
              {kybFormOpen ? (
                <View style={{ marginTop: 14 }}>
                  <Text style={styles.sectionSubHead}>1. Company Information</Text>
                  <Input label="Registered Business Legal Name *" placeholder="e.g. Acme Technologies Ltd" value={bizLegalName} onChangeText={setBizLegalName} />
                  <Input label="Trade / DBA Name (optional)" placeholder="Defaults to Legal Name" value={bizTradeName} onChangeText={setBizTradeName} />
                  <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Business Entity Type *</Text>
                  <View style={styles.pillRow}>
                    {(["llc", "corporation", "sole_proprietorship", "partnership"] as const).map((bt) => (
                      <Pill key={bt} label={bt.replace("_", " ")} active={bizType === bt} onPress={() => setBizType(bt)} />
                    ))}
                  </View>
                  <Input label="Registration / RC Number *" placeholder="e.g. RC1234567" value={bizRegNo} onChangeText={setBizRegNo} />
                  <Input label="Tax ID / TIN *" placeholder="e.g. 10293847-0001" value={bizTaxId} onChangeText={setBizTaxId} />
                  <Input label="Industry *" placeholder="e.g. Technology / Consulting / Retail" value={bizIndustry} onChangeText={setBizIndustry} />
                  <Input
                    label="Business Description *"
                    placeholder="Briefly describe your company's products or services"
                    value={bizDescription}
                    onChangeText={setBizDescription}
                    multiline
                  />
                  <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Incorporation Country *</Text>
                  <View style={styles.pillRow}>
                    {[
                      { code: "NG", label: "🇳🇬 NG" },
                      { code: "US", label: "🇺🇸 US" },
                      { code: "GB", label: "🇬🇧 GB" },
                      { code: "CA", label: "🇨🇦 CA" },
                      { code: "GH", label: "🇬🇭 GH" },
                      { code: "KE", label: "🇰🇪 KE" },
                      { code: "AE", label: "🇦🇪 AE" },
                    ].map((c) => (
                      <Pill
                        key={c.code}
                        label={c.label}
                        active={bizCountry === c.code}
                        onPress={() => {
                          setBizCountry(c.code);
                          setOfficerNationality(c.code);
                        }}
                      />
                    ))}
                  </View>
                  <Input label="2-Letter Country Code *" value={bizCountry} onChangeText={(t) => setBizCountry(t.toUpperCase())} autoCapitalize="characters" maxLength={2} />
                  <Input label="Incorporation State / Province *" placeholder="e.g. Lagos, Delaware, England" value={bizIncState} onChangeText={setBizIncState} />
                  <Input label="Incorporation Year (YYYY) *" placeholder="2023" value={bizIncYear} onChangeText={setBizIncYear} keyboardType="number-pad" maxLength={4} />
                  <Input label="Incorporation Month (1-12) *" placeholder="6" value={bizIncMonth} onChangeText={setBizIncMonth} keyboardType="number-pad" maxLength={2} />
                  <Input label="Business Contact Email *" placeholder="finance@company.com" value={bizEmail} onChangeText={setBizEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Business Phone (+international) *" placeholder="+2348012345678" value={bizPhone} onChangeText={setBizPhone} keyboardType="phone-pad" />
                  <Input label="Business Website (optional)" placeholder="https://company.com" value={bizWebsite} onChangeText={setBizWebsite} autoCapitalize="none" />

                  <Text style={styles.sectionSubHead}>2. Registered Business Address</Text>
                  <Input label="Street Address (4+ chars) *" placeholder="14 Admiralty Way, Lekki Phase 1" value={bizStreet} onChangeText={setBizStreet} />
                  <Input label="City *" value={bizCity} onChangeText={setBizCity} />
                  <Input label="State / Region *" value={bizState} onChangeText={setBizState} />
                  <Input label="Postal Code *" value={bizPostal} onChangeText={setBizPostal} />

                  <Text style={styles.sectionSubHead}>3. Controlling Officer / Beneficial Owner (≥25%)</Text>
                  <Input label="Officer Legal First Name *" value={officerFirst} onChangeText={setOfficerFirst} />
                  <Input label="Officer Legal Last Name *" value={officerLast} onChangeText={setOfficerLast} />
                  <Input label="Officer Job Title *" placeholder="Director / CEO / Managing Partner" value={officerTitle} onChangeText={setOfficerTitle} />
                  <Input label="Ownership Percentage (0–100) *" placeholder="100" value={officerOwnership} onChangeText={setOfficerOwnership} keyboardType="number-pad" maxLength={3} />
                  <Input label="Officer Email *" value={officerEmail} onChangeText={setOfficerEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Officer Phone (+international) *" placeholder="+2348012345678" value={officerPhone} onChangeText={setOfficerPhone} keyboardType="phone-pad" />
                  <Input label="Officer Date of Birth (YYYY-MM-DD) *" placeholder="1990-01-20" value={officerDob} onChangeText={setOfficerDob} />
                  <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Officer Gender *</Text>
                  <View style={styles.pillRow}>
                    <Pill label="Male" active={officerGender === "male"} onPress={() => setOfficerGender("male")} />
                    <Pill label="Female" active={officerGender === "female"} onPress={() => setOfficerGender("female")} />
                  </View>
                  <Input label="Officer Nationality (2-letter ISO) *" placeholder="NG, US, GB..." value={officerNationality} onChangeText={(t) => setOfficerNationality(t.toUpperCase())} autoCapitalize="characters" maxLength={2} />
                  <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Officer Government ID *</Text>
                  <View style={styles.pillRow}>
                    <Pill label="🛂 Passport" active={officerIdType === "international_passport"} onPress={() => setOfficerIdType("international_passport")} />
                    <Pill label="🪪 National ID" active={officerIdType === "national_id"} onPress={() => setOfficerIdType("national_id")} />
                    <Pill label="🚗 Driver's License" active={officerIdType === "drivers_license"} onPress={() => setOfficerIdType("drivers_license")} />
                  </View>
                  <Input label="Officer ID Number *" placeholder="e.g. A12345678" value={officerIdNumber} onChangeText={setOfficerIdNumber} />
                  <Input label="ID Issue Date (YYYY-MM-DD)" placeholder="2022-01-01" value={officerIdIssueDate} onChangeText={setOfficerIdIssueDate} />
                  <Input label="ID Expiry Date (YYYY-MM-DD)" placeholder="2032-01-01" value={officerIdExpiryDate} onChangeText={setOfficerIdExpiryDate} />
                  <Input label="ID Issuing Authority" placeholder="e.g. Nigeria Immigration Service" value={officerIdAuthority} onChangeText={setOfficerIdAuthority} />
                  {officerNationality.toUpperCase() === "NG" || bizCountry.toUpperCase() === "NG" ? (
                    <>
                      <Input label="Officer BVN (11 digits) *" placeholder="11-digit BVN" value={officerBvn} onChangeText={setOfficerBvn} keyboardType="number-pad" maxLength={11} />
                      <Input label="Officer NIN (11 digits) *" placeholder="11-digit NIN" value={officerNin} onChangeText={setOfficerNin} keyboardType="number-pad" maxLength={11} />
                    </>
                  ) : null}
                  {officerNationality.toUpperCase() === "US" || bizCountry.toUpperCase() === "US" ? (
                    <Input label="Officer SSN (9 digits) *" placeholder="123-45-6789" value={officerSsn} onChangeText={setOfficerSsn} keyboardType="number-pad" maxLength={11} />
                  ) : null}

                  <Text style={styles.sectionSubHead}>4. Required Business Documents (All 5 Required)</Text>
                  <Text style={[styles.rowSub, { marginBottom: 10 }]}>
                    Attach clear, readable documents. COI must be PDF; Memorandum & Articles must be PDF, DOC, or DOCX.
                  </Text>
                  <View style={styles.pillRow}>
                    <Pill
                      label={docKybCoi ? `COI (${docKybCoi.name.slice(0, 14)}) ✅` : "📄 Certificate of Incorp. (PDF) *"}
                      active={Boolean(docKybCoi)}
                      onPress={() => pickFileDocument("kyb_coi", ["application/pdf"], "application/pdf")}
                    />
                    <Pill
                      label={docKybMemart ? `MemArt (${docKybMemart.name.slice(0, 12)}) ✅` : "📄 Memo & Articles (PDF/DOCX) *"}
                      active={Boolean(docKybMemart)}
                      onPress={() =>
                        pickFileDocument(
                          "kyb_memart",
                          [
                            "application/pdf",
                            "application/msword",
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                          ],
                          "application/pdf"
                        )
                      }
                    />
                    <Pill
                      label={docKybBizPoa ? `Biz POA ✅` : "🧾 Business Proof of Address *"}
                      active={Boolean(docKybBizPoa)}
                      onPress={() => promptPickImageOrPdf("kyb_biz_poa", "Business Proof of Address")}
                    />
                    <Pill
                      label={docKybOfficerIdFront ? `Officer ID Front ✅` : "🪪 Officer ID (Front) *"}
                      active={Boolean(docKybOfficerIdFront)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_id_front", "Officer Government ID (Front)")}
                    />
                    <Pill
                      label={docKybOfficerIdBack ? `Officer ID Back ✅` : "🪪 Officer ID Back (optional)"}
                      active={Boolean(docKybOfficerIdBack)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_id_back", "Officer Government ID (Back)")}
                    />
                    <Pill
                      label={docKybOfficerPoa ? `Officer POA ✅` : "🧾 Officer Proof of Address *"}
                      active={Boolean(docKybOfficerPoa)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_poa", "Officer Proof of Address")}
                    />
                  </View>

                  <Button title="Submit Business KYB Verification" onPress={handleSubmitKyb} loading={loading} style={{ marginTop: 8 }} />
                </View>
              ) : null}
            </Card>
          ) : null}

          {/* Personal KYC Card */}
          <Card>
            <SectionHeader
              title="Personal Identity Verification (KYC)"
              right={
                <Text style={[styles.rowSub, { color: COLORS.primary, fontFamily: FONTS.bold }]}>
                  {kyc ? `Tier ${kyc.personal.tier} · ${kyc.personal.status}` : ""}
                </Text>
              }
            />
            <Text style={styles.rowSub}>
              Unlocks named Personal Global Accounts (USD, GBP, EUR, CAD, AED, GHS, KES, TZS) and Virtual USD Cards.
            </Text>
            <Button
              title={kycFormOpen ? "Hide Personal KYC Form" : "Start Personal KYC Verification"}
              variant={isBiz ? "secondary" : kycFormOpen ? "secondary" : "primary"}
              onPress={() => setKycFormOpen((v) => !v)}
              style={{ marginTop: 12 }}
            />

            {kycFormOpen ? (
              <View style={{ marginTop: 14 }}>
                <Input label="Legal First Name *" value={firstName} onChangeText={setFirstName} />
                <Input label="Legal Last Name *" value={lastName} onChangeText={setLastName} />
                <Input label="Email Address *" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
                <Input label="Phone (+international format) *" placeholder="+2348012345678" value={phoneNumber} onChangeText={setPhoneNumber} keyboardType="phone-pad" />
                <Input label="Date of Birth (YYYY-MM-DD) *" placeholder="1995-05-15" value={dob} onChangeText={setDob} />

                <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Gender *</Text>
                <View style={[styles.pillRow, { marginBottom: 10 }]}>
                  <Pill label="Male" active={gender === "male"} onPress={() => setGender("male")} />
                  <Pill label="Female" active={gender === "female"} onPress={() => setGender("female")} />
                </View>

                <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Verification Country *</Text>
                <View style={[styles.pillRow, { marginBottom: 10 }]}>
                  {[
                    { code: "NG", label: "🇳🇬 Nigeria" },
                    { code: "US", label: "🇺🇸 United States" },
                    { code: "GB", label: "🇬🇧 United Kingdom" },
                    { code: "CA", label: "🇨🇦 Canada" },
                    { code: "GH", label: "🇬🇭 Ghana" },
                    { code: "KE", label: "🇰🇪 Kenya" },
                  ].map((c) => (
                    <Pill
                      key={c.code}
                      label={c.label}
                      active={countryCode === c.code}
                      onPress={() => setCountryCode(c.code)}
                    />
                  ))}
                </View>
                <Input label="2-Letter Country Code *" value={countryCode} onChangeText={(t) => setCountryCode(t.toUpperCase())} autoCapitalize="characters" maxLength={2} />

                <Input label="Street Address *" value={street} onChangeText={setStreet} />
                <Input label="City *" value={city} onChangeText={setCity} />
                <Input label="State / Region *" value={stateRegion} onChangeText={setStateRegion} />
                <Input label="Postal Code *" value={postalCode} onChangeText={setPostalCode} />

                <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Government ID Document *</Text>
                <View style={[styles.pillRow, { marginBottom: 10 }]}>
                  <Pill label="🛂 Passport" active={idType === "international_passport"} onPress={() => setIdType("international_passport")} />
                  <Pill label="🪪 National ID" active={idType === "national_id"} onPress={() => setIdType("national_id")} />
                  <Pill label="🚗 Driver's License" active={idType === "drivers_license"} onPress={() => setIdType("drivers_license")} />
                </View>

                <Input label="ID Document Number *" placeholder="e.g. A12345678" value={idNumber} onChangeText={setIdNumber} />
                <Input label="Issue Date (YYYY-MM-DD)" placeholder="2022-01-01" value={idIssueDate} onChangeText={setIdIssueDate} />
                <Input label="Expiry Date (YYYY-MM-DD)" placeholder="2032-01-01" value={idExpiryDate} onChangeText={setIdExpiryDate} />
                <Input label="Issuing Authority (optional)" placeholder="e.g. Nigeria Immigration Service" value={idIssuingAuthority} onChangeText={setIdIssuingAuthority} />
                {countryCode === "NG" ? (
                  <>
                    <Input label="BVN (11 digits) *" placeholder="11-digit Bank Verification Number" value={bvn} onChangeText={setBvn} keyboardType="number-pad" maxLength={11} />
                    <Input label="NIN (11 digits) *" placeholder="11-digit National Identity Number" value={nin} onChangeText={setNin} keyboardType="number-pad" maxLength={11} />
                  </>
                ) : null}
                {countryCode === "US" ? (
                  <Input label="SSN (9 digits) *" placeholder="123-45-6789" value={ssn} onChangeText={setSsn} keyboardType="number-pad" maxLength={11} />
                ) : null}

                <Text style={[styles.sectionSubHead, { marginTop: 8 }]}>Required Verification Documents (Photo or PDF)</Text>
                <View style={[styles.pillRow, { marginBottom: 10 }]}>
                  <Pill
                    label={docIdFront ? `ID Front (${docIdFront.name.slice(0, 12)}) ✅` : "📷 Upload ID Front *"}
                    active={Boolean(docIdFront)}
                    onPress={() => promptPickImageOrPdf("kyc_front", "Government ID (Front)")}
                  />
                  <Pill
                    label={docIdBack ? `ID Back ✅` : "📷 ID Back (optional)"}
                    active={Boolean(docIdBack)}
                    onPress={() => promptPickImageOrPdf("kyc_back", "Government ID (Back)")}
                  />
                  <Pill
                    label={docPoa ? `Proof of Address ✅` : "🧾 Proof of Address *"}
                    active={Boolean(docPoa)}
                    onPress={() => promptPickImageOrPdf("kyc_poa", "Proof of Address (< 3 months)")}
                  />
                </View>

                <Button title="Submit Personal KYC Verification" onPress={handleSubmitKyc} loading={loading} style={{ marginTop: 8 }} />
              </View>
            ) : null}
          </Card>

          {/* Business KYB Card (also accessible from Personal mode if business account exists) */}
          {!isBiz && user?.hasBusinessAccount ? (
            <Card style={{ borderColor: COLORS.businessBorder }}>
              <SectionHeader
                title="Business Verification (KYB)"
                right={
                  <Text style={[styles.rowSub, { color: COLORS.business, fontFamily: FONTS.bold }]}>
                    {kyc ? `Tier ${kyc.business.tier} · ${kyc.business.status}` : ""}
                  </Text>
                }
              />
              <Text style={styles.rowSub}>
                Business KYB is verified separately from your Personal KYC. Switch to your Business account above or expand below to submit full company verification.
              </Text>
              <Button
                title={kybFormOpen ? "Hide Business KYB Form" : "Start Business KYB Verification"}
                variant="secondary"
                onPress={() => setKybFormOpen((v) => !v)}
                style={{ marginTop: 12 }}
              />
              {kybFormOpen ? (
                <View style={{ marginTop: 14 }}>
                  <Text style={styles.sectionSubHead}>1. Company Information</Text>
                  <Input label="Registered Business Legal Name *" placeholder="e.g. Acme Technologies Ltd" value={bizLegalName} onChangeText={setBizLegalName} />
                  <Input label="Trade / DBA Name (optional)" placeholder="Defaults to Legal Name" value={bizTradeName} onChangeText={setBizTradeName} />
                  <Text style={[styles.rowSub, { marginTop: 4, marginBottom: 6 }]}>Business Entity Type *</Text>
                  <View style={styles.pillRow}>
                    {(["llc", "corporation", "sole_proprietorship", "partnership"] as const).map((bt) => (
                      <Pill key={bt} label={bt.replace("_", " ")} active={bizType === bt} onPress={() => setBizType(bt)} />
                    ))}
                  </View>
                  <Input label="Registration / RC Number *" placeholder="e.g. RC1234567" value={bizRegNo} onChangeText={setBizRegNo} />
                  <Input label="Tax ID / TIN *" placeholder="e.g. 10293847-0001" value={bizTaxId} onChangeText={setBizTaxId} />
                  <Input label="Industry *" placeholder="e.g. Technology / Consulting / Retail" value={bizIndustry} onChangeText={setBizIndustry} />
                  <Input label="Business Description *" placeholder="Briefly describe your company's products or services" value={bizDescription} onChangeText={setBizDescription} multiline />
                  <Input label="2-Letter Incorporation Country *" value={bizCountry} onChangeText={(t) => setBizCountry(t.toUpperCase())} autoCapitalize="characters" maxLength={2} />
                  <Input label="Incorporation State / Province *" placeholder="e.g. Lagos, Delaware" value={bizIncState} onChangeText={setBizIncState} />
                  <Input label="Incorporation Year (YYYY) *" placeholder="2023" value={bizIncYear} onChangeText={setBizIncYear} keyboardType="number-pad" maxLength={4} />
                  <Input label="Incorporation Month (1-12) *" placeholder="6" value={bizIncMonth} onChangeText={setBizIncMonth} keyboardType="number-pad" maxLength={2} />
                  <Input label="Business Contact Email *" value={bizEmail} onChangeText={setBizEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Business Phone (+international) *" placeholder="+2348012345678" value={bizPhone} onChangeText={setBizPhone} keyboardType="phone-pad" />
                  <Input label="Business Website (optional)" placeholder="https://company.com" value={bizWebsite} onChangeText={setBizWebsite} autoCapitalize="none" />

                  <Text style={styles.sectionSubHead}>2. Registered Business Address</Text>
                  <Input label="Street Address (4+ chars) *" value={bizStreet} onChangeText={setBizStreet} />
                  <Input label="City *" value={bizCity} onChangeText={setBizCity} />
                  <Input label="State / Region *" value={bizState} onChangeText={setBizState} />
                  <Input label="Postal Code *" value={bizPostal} onChangeText={setBizPostal} />

                  <Text style={styles.sectionSubHead}>3. Controlling Officer / Beneficial Owner (≥25%)</Text>
                  <Input label="Officer First Name *" value={officerFirst} onChangeText={setOfficerFirst} />
                  <Input label="Officer Last Name *" value={officerLast} onChangeText={setOfficerLast} />
                  <Input label="Officer Job Title *" placeholder="Director / CEO" value={officerTitle} onChangeText={setOfficerTitle} />
                  <Input label="Ownership Percentage (0–100) *" placeholder="100" value={officerOwnership} onChangeText={setOfficerOwnership} keyboardType="number-pad" maxLength={3} />
                  <Input label="Officer Email *" value={officerEmail} onChangeText={setOfficerEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Officer Phone (+international) *" value={officerPhone} onChangeText={setOfficerPhone} keyboardType="phone-pad" />
                  <Input label="Officer Date of Birth (YYYY-MM-DD) *" placeholder="1990-01-20" value={officerDob} onChangeText={setOfficerDob} />
                  <View style={styles.pillRow}>
                    <Pill label="Male" active={officerGender === "male"} onPress={() => setOfficerGender("male")} />
                    <Pill label="Female" active={officerGender === "female"} onPress={() => setOfficerGender("female")} />
                  </View>
                  <Input label="Officer Nationality (2-letter ISO) *" value={officerNationality} onChangeText={(t) => setOfficerNationality(t.toUpperCase())} autoCapitalize="characters" maxLength={2} />
                  <View style={styles.pillRow}>
                    <Pill label="🛂 Passport" active={officerIdType === "international_passport"} onPress={() => setOfficerIdType("international_passport")} />
                    <Pill label="🪪 National ID" active={officerIdType === "national_id"} onPress={() => setOfficerIdType("national_id")} />
                    <Pill label="🚗 Driver's License" active={officerIdType === "drivers_license"} onPress={() => setOfficerIdType("drivers_license")} />
                  </View>
                  <Input label="Officer ID Number *" value={officerIdNumber} onChangeText={setOfficerIdNumber} />
                  <Input label="ID Issue Date (YYYY-MM-DD)" placeholder="2022-01-01" value={officerIdIssueDate} onChangeText={setOfficerIdIssueDate} />
                  <Input label="ID Expiry Date (YYYY-MM-DD)" placeholder="2032-01-01" value={officerIdExpiryDate} onChangeText={setOfficerIdExpiryDate} />
                  <Input label="ID Issuing Authority" placeholder="e.g. Nigeria Immigration Service" value={officerIdAuthority} onChangeText={setOfficerIdAuthority} />
                  {officerNationality.toUpperCase() === "NG" || bizCountry.toUpperCase() === "NG" ? (
                    <>
                      <Input label="Officer BVN (11 digits) *" value={officerBvn} onChangeText={setOfficerBvn} keyboardType="number-pad" maxLength={11} />
                      <Input label="Officer NIN (11 digits) *" value={officerNin} onChangeText={setOfficerNin} keyboardType="number-pad" maxLength={11} />
                    </>
                  ) : null}
                  {officerNationality.toUpperCase() === "US" || bizCountry.toUpperCase() === "US" ? (
                    <Input label="Officer SSN (9 digits) *" value={officerSsn} onChangeText={setOfficerSsn} keyboardType="number-pad" maxLength={11} />
                  ) : null}

                  <Text style={styles.sectionSubHead}>4. Required Business Documents (All 5 Required)</Text>
                  <View style={styles.pillRow}>
                    <Pill
                      label={docKybCoi ? `COI ✅` : "📄 Certificate of Incorp. (PDF) *"}
                      active={Boolean(docKybCoi)}
                      onPress={() => pickFileDocument("kyb_coi", ["application/pdf"], "application/pdf")}
                    />
                    <Pill
                      label={docKybMemart ? `MemArt ✅` : "📄 Memo & Articles (PDF/DOCX) *"}
                      active={Boolean(docKybMemart)}
                      onPress={() =>
                        pickFileDocument(
                          "kyb_memart",
                          [
                            "application/pdf",
                            "application/msword",
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                          ],
                          "application/pdf"
                        )
                      }
                    />
                    <Pill
                      label={docKybBizPoa ? `Biz POA ✅` : "🧾 Business Proof of Address *"}
                      active={Boolean(docKybBizPoa)}
                      onPress={() => promptPickImageOrPdf("kyb_biz_poa", "Business Proof of Address")}
                    />
                    <Pill
                      label={docKybOfficerIdFront ? `Officer ID Front ✅` : "🪪 Officer ID (Front) *"}
                      active={Boolean(docKybOfficerIdFront)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_id_front", "Officer Government ID (Front)")}
                    />
                    <Pill
                      label={docKybOfficerIdBack ? `Officer ID Back ✅` : "🪪 Officer ID Back (optional)"}
                      active={Boolean(docKybOfficerIdBack)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_id_back", "Officer Government ID (Back)")}
                    />
                    <Pill
                      label={docKybOfficerPoa ? `Officer POA ✅` : "🧾 Officer Proof of Address *"}
                      active={Boolean(docKybOfficerPoa)}
                      onPress={() => promptPickImageOrPdf("kyb_officer_poa", "Officer Proof of Address")}
                    />
                  </View>
                  <Button title="Submit Business KYB Verification" onPress={handleSubmitKyb} loading={loading} style={{ marginTop: 8 }} />
                </View>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}

      {/* SECURITY & DEVICES */}
      {tab === "security" ? (
        <>
          <Card>
            <SectionHeader title="Transaction PIN" />
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
          <Input label="Wallet address (optional)" value={cWallet} onChangeText={setCWallet} autoCapitalize="none" />
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
          <Input label="Amount (USD)" value={schAmt} onChangeText={setSchAmt} keyboardType="decimal-pad" />
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
              <Text style={styles.pointsHero}>{balanceHidden ? "•••• pts" : `${rewards.pointsBalance} pts`}</Text>
              <Text style={styles.rowSub}>
                Value: {balanceHidden ? "$••••" : formatUsdc(rewards.redeemValueUsd)} ({rewards.pointsPerUsd} pts = $1 · Min {rewards.minRedeemPoints} pts)
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
  rowTitle: { color: COLORS.text, fontSize: 14, fontFamily: FONTS.semibold },
  rowSub: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 12, marginTop: 2 },
  sectionSubHead: { color: COLORS.text, fontSize: 13, fontFamily: FONTS.bold, marginTop: 12, marginBottom: 8 },
  pointsHero: { color: COLORS.primary, fontSize: 32, fontFamily: FONTS.extrabold },
});
