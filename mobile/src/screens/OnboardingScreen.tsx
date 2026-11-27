import React, { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, API_BASE_URL } from "../api/client";
import { assertPasskey, createPasskey, isPasskeySupported } from "../api/passkey";
import {
  getBundledGoogleWebClientId,
  isGoogleSignInNativeAvailable,
  signInWithGoogleNative,
} from "../api/googleSignIn";
import * as SecureStore from "expo-secure-store";
import { RETURNING_USER_KEY, useApp } from "../state/AppContext";
import { COLORS, DEPTH, RADIUS, SPACING, FONTS } from "../theme";
import { Button, Card, ErrorBanner, Input } from "../components/UI";
import { PressableScale } from "../components/Touch";
import { PoweredBy } from "../components/PoweredBy";

type Step = "welcome" | "signup_email" | "signup_otp" | "signup_passkey" | "link_telegram";

const WEAK_PINS = new Set([
  "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999",
  "1234", "4321", "1212", "2580", "0852", "1010", "2000", "2024", "2025", "2026", "6969",
]);

export function OnboardingScreen({ initialLinkCode = "" }: { initialLinkCode?: string }) {
  const { signInWithSession, sessionNotice, clearSessionNotice } = useApp();
  const [step, setStep] = useState<Step>(initialLinkCode ? "link_telegram" : "welcome");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signup state (Google or Email -> Passkey + PIN)
  const [signupEmail, setSignupEmail] = useState("");
  const [signupName, setSignupName] = useState<string | null>(null);
  const [signupProvider, setSignupProvider] = useState<"google" | "email">("email");
  const [signupId, setSignupId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [regChallengeId, setRegChallengeId] = useState("");
  const [regOptions, setRegOptions] = useState<Record<string, unknown> | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [googleWebClientId, setGoogleWebClientId] = useState<string | null>(() => getBundledGoogleWebClientId());

  // Telegram link state
  const [linkCode, setLinkCode] = useState(initialLinkCode);
  const [linkPin, setLinkPin] = useState("");

  React.useEffect(() => {
    if (initialLinkCode) {
      setLinkCode(initialLinkCode);
      setStep("link_telegram");
    }
  }, [initialLinkCode]);

  // Fetch server-configured Google Web Client ID at runtime so configuring Railway enables it automatically.
  React.useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        if (cfg?.googleWebClientId) setGoogleWebClientId(cfg.googleWebClientId);
      })
      .catch(() => {});
  }, []);

  const passkeyAvailable = isPasskeySupported();
  const googleNativeAvailable = isGoogleSignInNativeAvailable();

  // Someone has signed in on this phone before: go straight to fingerprint / face.
  const [returning, setReturning] = useState<boolean | null>(null);
  const [showAllOptions, setShowAllOptions] = useState(false);
  const autoPrompted = React.useRef(false);
  React.useEffect(() => {
    SecureStore.getItemAsync(RETURNING_USER_KEY)
      .then((v) => setReturning(v === "1"))
      .catch(() => setReturning(false));
  }, []);

  const handlePasskeySignIn = async () => {
    setError(null);
    clearSessionNotice();
    setLoading(true);
    try {
      const start = await api.loginStart();
      const assertion = await assertPasskey(start.options);
      const finished = await api.loginFinish(start.challengeId, assertion);
      await signInWithSession(finished.user, finished.session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not sign in with passkey.";
      if (/no passkey|no.?credential|not.?found/i.test(msg)) {
        setError("No Proxim passkey is saved on this device yet. Tap 'Create new account' to set up your wallet and passkey in seconds.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleContinue = async () => {
    setError(null);
    clearSessionNotice();
    if (!googleNativeAvailable) {
      setError("Install the latest Proxim app build to use Continue with Google, or tap Continue with Email below.");
      return;
    }
    setGoogleLoading(true);
    try {
      let clientId = googleWebClientId;
      if (!clientId) {
        const cfg = await api.authConfig().catch(() => null);
        clientId = cfg?.googleWebClientId || null;
        if (clientId) setGoogleWebClientId(clientId);
      }
      if (!clientId) {
        setError("Google Sign-In is being finalized. Tap Continue with Email below to create your account right away.");
        return;
      }

      const gRes = await signInWithGoogleNative(clientId);
      if (gRes.cancelled) return;

      const start = await api.googleAuthStart(gRes.idToken);
      if (start.mode === "existing_passkey") {
        setGoogleLoading(false);
        if (start.loginChallengeId && start.loginOptions) {
          setLoading(true);
          try {
            const assertion = await assertPasskey(start.loginOptions);
            const finished = await api.loginFinish(start.loginChallengeId, assertion);
            await signInWithSession(finished.user, finished.session);
          } catch (pkErr) {
            const msg = pkErr instanceof Error ? pkErr.message : "Could not sign in with passkey.";
            setError(
              /no passkey|no.?credential|not.?found/i.test(msg)
                ? "This Google email already has a Proxim account, but its passkey isn't on this device. Sign in on your original device or contact support."
                : msg
            );
          } finally {
            setLoading(false);
          }
          return;
        }
        await handlePasskeySignIn();
        return;
      }

      setSignupProvider("google");
      setSignupEmail(start.email);
      setSignupName(start.name || gRes.name || null);
      setSignupId(start.signupId);
      setRegChallengeId(start.challengeId);
      setRegOptions(start.options);
      setStep("signup_passkey");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue with Google.");
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleSignupStart = async () => {
    setError(null);
    const contact = signupEmail.trim().toLowerCase();
    if (!contact || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.signupStart(contact, "email");
      setSignupProvider("email");
      setSignupName(null);
      setSignupId(res.signupId);
      setStep("signup_otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.signupVerifyOtp(signupId, otpCode.trim());
      setRegChallengeId(res.challengeId);
      setRegOptions(res.options);
      setStep("signup_passkey");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleFinishSignup = async () => {
    setError(null);
    if (!/^\d{4}$/.test(pin)) {
      setError("Choose a 4-digit PIN.");
      return;
    }
    if (WEAK_PINS.has(pin)) {
      setError("Choose a stronger 4-digit PIN (avoid 1234, 0000, repeated digits, or years).");
      return;
    }
    if (pin !== confirmPin) {
      setError("PINs do not match.");
      return;
    }
    if (!acceptTerms) {
      setError("Please accept the Terms of Service to continue.");
      return;
    }
    if (!regOptions) {
      setError("Registration session expired. Please start again.");
      return;
    }
    setLoading(true);
    try {
      const response = await createPasskey(regOptions);
      const finished = await api.signupFinish({
        signupId,
        challengeId: regChallengeId,
        pin,
        acceptTerms: true,
        response,
      });
      await signInWithSession(finished.user, finished.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete account creation.");
    } finally {
      setLoading(false);
    }
  };

  const handleLinkTelegram = async () => {
    setError(null);
    const cleanedCode = linkCode.trim();
    if (cleanedCode.length < 6) {
      setError("Enter the link code from /linkapp at https://t.me/payeetbot.");
      return;
    }
    if (!/^\d{4}$/.test(linkPin)) {
      setError("Enter your existing 4-digit Proxim wallet PIN.");
      return;
    }
    setLoading(true);
    try {
      const start = await api.linkStart(cleanedCode);
      let response: Record<string, unknown>;
      try {
        response = await createPasskey(start.options);
      } catch (pkErr) {
        const pkMsg = pkErr instanceof Error ? pkErr.message : String(pkErr || "");
        // Android Credential Manager throws InvalidStateError ("One of the excluded credentials
        // exists on the local device") when this account's passkey is already saved on this phone.
        // Seamlessly sign in using that existing passkey instead of failing.
        if (/excluded credential|already exists|InvalidState/i.test(pkMsg)) {
          try {
            const login = await api.loginStart();
            const assertion = await assertPasskey(login.options);
            const finished = await api.loginFinish(login.challengeId, assertion);
            await signInWithSession(finished.user, finished.session);
            return;
          } catch {
            throw new Error(
              "Your Proxim passkey is already saved on this phone. Go back and tap 'Sign in with passkey'."
            );
          }
        }
        throw pkErr;
      }
      const finished = await api.linkFinish({
        code: cleanedCode,
        challengeId: start.challengeId,
        pin: linkPin,
        response,
      });
      await signInWithSession(finished.user, finished.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link Telegram account.");
    } finally {
      setLoading(false);
    }
  };

  const returningMode = Boolean(returning) && passkeyAvailable && !showAllOptions && step === "welcome" && !initialLinkCode;

  React.useEffect(() => {
    if (!returningMode || autoPrompted.current) return;
    autoPrompted.current = true;
    const t = setTimeout(() => {
      handlePasskeySignIn();
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returningMode]);

  if (returning === null && !initialLinkCode) {
    // Brief check of whether this phone has been used before; avoids flashing the wrong screen.
    return <SafeAreaView style={styles.safe} />;
  }

  if (returningMode) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.returnWrap}>
          <View style={{ alignItems: "center", gap: 10 }}>
            <Image source={require("../../assets/icon.png")} style={styles.logoImg} resizeMode="cover" />
            <Text style={styles.brandName}>Welcome back</Text>
            <Text style={styles.brandTag}>Use your fingerprint or face to sign in.</Text>
          </View>
          <PressableScale onPress={handlePasskeySignIn} depth={0.94} style={styles.fingerprint} accessibilityLabel="Sign in with fingerprint or face">
            <Ionicons name="finger-print" size={56} color={COLORS.primary} />
          </PressableScale>
          <View style={{ gap: 10, alignSelf: "stretch" }}>
            <ErrorBanner message={sessionNotice} onDismiss={clearSessionNotice} />
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
            <Button title="Sign in with fingerprint or face" onPress={handlePasskeySignIn} loading={loading} />
            <Text onPress={() => setShowAllOptions(true)} style={styles.troubleLink} accessibilityRole="button">
              Having trouble signing in?
            </Text>
            <PoweredBy />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.brandHeader}>
            <Image
              source={require("../../assets/icon.png")}
              style={styles.logoImg}
              resizeMode="cover"
            />
            <Text style={styles.brandName}>Proxim</Text>
            <Text style={styles.brandTag}>
              Global Dollars, Naira & Business Banking — secured by Passkey + PIN
            </Text>
          </View>

          {!passkeyAvailable ? (
            <Card style={styles.runtimeWarning}>
              <View style={styles.warnRow}>
                <Ionicons name="warning" size={18} color={COLORS.business} />
                <Text style={styles.warnText}>
                  Passkeys aren&apos;t available on this device. Install the latest Proxim app to sign in securely.
                </Text>
              </View>
            </Card>
          ) : null}

          <ErrorBanner message={sessionNotice} onDismiss={clearSessionNotice} />
          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          {step === "welcome" ? (
            <View>
              <View style={styles.featureStrip}>
                <View style={styles.featureChip}>
                  <Ionicons name="globe-outline" size={14} color={COLORS.primary} />
                  <Text style={styles.featureChipText}>Global Accounts</Text>
                </View>
                <View style={styles.featureChip}>
                  <Ionicons name="card-outline" size={14} color={COLORS.primary} />
                  <Text style={styles.featureChipText}>USD Cards</Text>
                </View>
                <View style={styles.featureChip}>
                  <Ionicons name="trending-up-outline" size={14} color={COLORS.primary} />
                  <Text style={styles.featureChipText}>Savings &amp; Stocks</Text>
                </View>
              </View>

              <Card>
                <Text style={styles.cardTitle}>Create your account</Text>
                <Text style={styles.cardSub}>
                  Set up your global dollar &amp; naira wallet in under 30 seconds — secured with your device passkey and 4-digit PIN.
                </Text>

                <PressableScale
                  onPress={handleGoogleContinue}
                  disabled={loading || googleLoading}
                  depth={0.97}
                  style={[styles.googleBtn, (loading || googleLoading) && { opacity: 0.65 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Google"
                >
                  <View style={styles.googleBadge}>
                    <Text style={styles.googleBadgeText}>G</Text>
                  </View>
                  <Text style={styles.googleBtnText}>
                    {googleLoading ? "Connecting Google…" : "Continue with Google"}
                  </Text>
                </PressableScale>

                <Button
                  title="Continue with Email"
                  variant="secondary"
                  onPress={() => {
                    setError(null);
                    setStep("signup_email");
                  }}
                  style={{ marginTop: 10 }}
                />

                <View style={styles.orRow}>
                  <View style={styles.orLine} />
                  <Text style={styles.orText}>existing telegram user?</Text>
                  <View style={styles.orLine} />
                </View>

                <Button
                  title="Link Proxim Telegram wallet"
                  variant="ghost"
                  onPress={() => {
                    setError(null);
                    setStep("link_telegram");
                  }}
                />
              </Card>

              <PressableScale
                onPress={handlePasskeySignIn}
                disabled={loading || googleLoading}
                style={styles.signInFootBtn}
                accessibilityRole="button"
              >
                <Text style={styles.signInFootText}>
                  Already have an account?{" "}
                  <Text style={styles.signInFootLink}>Sign in</Text>
                </Text>
              </PressableScale>

              <PoweredBy />
            </View>
          ) : null}

          {step === "signup_email" ? (
            <Card>
              <Text style={styles.cardTitle}>Sign up with email</Text>
              <Text style={styles.cardSub}>
                Enter your email address to get a quick 6-digit code, then set your 4-digit PIN and passkey.
              </Text>
              <Input
                label="Email address"
                placeholder="you@example.com"
                value={signupEmail}
                onChangeText={setSignupEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button title="Send verification code" onPress={handleSignupStart} loading={loading} />
              <Button
                title="Back"
                variant="ghost"
                onPress={() => setStep("welcome")}
                style={{ marginTop: 8 }}
              />
            </Card>
          ) : null}

          {step === "signup_otp" ? (
            <Card>
              <Text style={styles.cardTitle}>Verify your email</Text>
              <Text style={styles.cardSub}>
                Enter the 6-digit code sent to <Text style={{ fontFamily: FONTS.bold, color: COLORS.text }}>{signupEmail.trim()}</Text>.
              </Text>
              <Input
                label="Verification code"
                placeholder="123456"
                value={otpCode}
                onChangeText={(t) => setOtpCode(t.replace(/\D/g, "").slice(0, 8))}
                keyboardType="number-pad"
              />
              <Button title="Verify" onPress={handleVerifyOtp} loading={loading} />
              <Button
                title="Back"
                variant="ghost"
                onPress={() => setStep("signup_email")}
                style={{ marginTop: 8 }}
              />
            </Card>
          ) : null}

          {step === "signup_passkey" ? (
            <Card>
              <Text style={styles.cardTitle}>Secure your wallet</Text>
              {signupEmail ? (
                <View style={styles.verifiedPill}>
                  <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
                  <Text style={styles.verifiedPillText} numberOfLines={1}>
                    {signupProvider === "google" ? "Google verified · " : "Verified · "}
                    {signupName ? `${signupName} (${signupEmail})` : signupEmail}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.cardSub}>
                Choose a 4-digit PIN to encrypt your wallet key, then save your device passkey for 1-tap login and approvals.
              </Text>
              <Input
                label="Choose 4-digit PIN"
                placeholder="••••"
                value={pin}
                onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
              />
              <Input
                label="Confirm 4-digit PIN"
                placeholder="••••"
                value={confirmPin}
                onChangeText={(t) => setConfirmPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
              />
              <PressableScale
                onPress={() => setAcceptTerms((v) => !v)}
                style={styles.termsRow}
              >
                <Ionicons
                  name={acceptTerms ? "checkbox" : "square-outline"}
                  size={20}
                  color={acceptTerms ? COLORS.primary : COLORS.textSecondary}
                />
                <Text style={styles.termsText}>
                  I accept the Proxim Terms of Service and Privacy Policy.
                </Text>
              </PressableScale>
              <Button title="Finish & save passkey" onPress={handleFinishSignup} loading={loading} />
              <Button
                title="Start over"
                variant="ghost"
                onPress={() => {
                  setError(null);
                  setStep("welcome");
                }}
                style={{ marginTop: 8 }}
              />
            </Card>
          ) : null}

          {step === "link_telegram" ? (
            <Card>
              <Text style={styles.cardTitle}>Link Telegram account</Text>
              <Text style={styles.cardSub}>
                1. Tap{" "}
                <Text
                  onPress={() => Linking.openURL("https://t.me/payeetbot").catch(() => {})}
                  accessibilityRole="link"
                  style={{ color: COLORS.success, fontFamily: FONTS.bold, textDecorationLine: "underline" }}
                >
                  https://t.me/payeetbot
                </Text>{" "}
                to open Telegram and send <Text style={{ fontFamily: FONTS.bold, color: COLORS.text }}>/linkapp</Text>.
                {"\n"}2. Paste the one-time code below along with your existing 4-digit wallet PIN.
              </Text>
              <Input
                label="One-time link code"
                placeholder="Paste code from /linkapp"
                value={linkCode}
                onChangeText={setLinkCode}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Input
                label="Existing 4-digit wallet PIN"
                placeholder="••••"
                value={linkPin}
                onChangeText={(t) => setLinkPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
              />
              <Button title="Link account & create passkey" onPress={handleLinkTelegram} loading={loading} />
              <Button
                title="Already linked? Sign in with passkey"
                variant="secondary"
                onPress={handlePasskeySignIn}
                loading={loading}
                style={{ marginTop: 8 }}
              />
              <Button
                title="Back"
                variant="ghost"
                onPress={() => setStep("welcome")}
                style={{ marginTop: 8 }}
              />
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  returnWrap: { flex: 1, padding: SPACING.lg, alignItems: "center", justifyContent: "space-between", paddingTop: 48 },
  fingerprint: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: COLORS.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.primaryBorder,
  },
  troubleLink: { textAlign: "center", color: COLORS.primary, fontFamily: FONTS.semibold, fontSize: 15, paddingVertical: 10 },
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  container: {
    padding: SPACING.lg,
    paddingTop: 36,
    flexGrow: 1,
    justifyContent: "center",
  },
  brandHeader: {
    alignItems: "center",
    marginBottom: 28,
  },
  logoImg: {
    width: 76,
    height: 76,
    borderRadius: 20,
    marginBottom: 14,
  },
  brandName: {
    color: COLORS.text,
    fontSize: 28,
    fontFamily: FONTS.extrabold,
    letterSpacing: -0.5,
  },
  brandTag: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.regular, fontSize: 13,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 19,
    maxWidth: 300,
  },
  runtimeWarning: {
    borderColor: COLORS.businessBorder,
    backgroundColor: COLORS.businessMuted,
  },
  warnRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  warnText: {
    color: COLORS.warningText,
    fontFamily: FONTS.regular, fontSize: 12,
    flex: 1,
    lineHeight: 18,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontFamily: FONTS.bold,
    marginBottom: 6,
  },
  cardSub: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.regular, fontSize: 13,
    lineHeight: 19,
    marginBottom: 18,
  },
  termsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  termsText: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.regular, fontSize: 13,
    flex: 1,
  },
  endpointFoot: {
    color: COLORS.textMuted,
    fontFamily: FONTS.regular, fontSize: 11,
    textAlign: "center",
    marginTop: 8,
  },
  featureStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginBottom: 16,
  },
  featureChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: COLORS.goldSoft,
    borderWidth: 1,
    borderColor: COLORS.businessBorder,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  featureChipText: {
    color: COLORS.forest,
    fontFamily: FONTS.semibold,
    fontSize: 11.5,
  },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 50,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.forest,
    paddingHorizontal: 16,
    ...DEPTH.forest,
  },
  googleBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.white,
    alignItems: "center",
    justifyContent: "center",
  },
  googleBadgeText: {
    color: COLORS.forest,
    fontFamily: FONTS.extrabold,
    fontSize: 14,
  },
  googleBtnText: {
    color: COLORS.white,
    fontFamily: FONTS.bold,
    fontSize: 15,
  },
  orRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    marginBottom: 6,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  orText: {
    color: COLORS.textMuted,
    fontFamily: FONTS.medium,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  signInFootBtn: {
    alignItems: "center",
    paddingVertical: 14,
  },
  signInFootText: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.regular,
    fontSize: 14,
  },
  signInFootLink: {
    color: COLORS.primary,
    fontFamily: FONTS.bold,
    textDecorationLine: "underline",
  },
  verifiedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#E8F6EE",
    borderWidth: 1,
    borderColor: "#B7E4C7",
    borderRadius: RADIUS.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 12,
  },
  verifiedPillText: {
    color: COLORS.success,
    fontFamily: FONTS.semibold,
    fontSize: 12,
    flex: 1,
  },
});
