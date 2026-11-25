import React, { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
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
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING } from "../theme";
import { Button, Card, ErrorBanner, Input } from "../components/UI";
import { PressableScale } from "../components/Touch";

type Step = "welcome" | "signup_phone" | "signup_otp" | "signup_passkey" | "link_telegram";

export function OnboardingScreen({ initialLinkCode = "" }: { initialLinkCode?: string }) {
  const { signInWithSession, sessionNotice, clearSessionNotice } = useApp();
  const [step, setStep] = useState<Step>(initialLinkCode ? "link_telegram" : "welcome");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signup state
  const [phone, setPhone] = useState("");
  const [signupId, setSignupId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [regChallengeId, setRegChallengeId] = useState("");
  const [regOptions, setRegOptions] = useState<Record<string, unknown> | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);

  // Telegram link state
  const [linkCode, setLinkCode] = useState(initialLinkCode);
  const [linkPin, setLinkPin] = useState("");

  React.useEffect(() => {
    if (initialLinkCode) {
      setLinkCode(initialLinkCode);
      setStep("link_telegram");
    }
  }, [initialLinkCode]);

  const passkeyAvailable = isPasskeySupported();

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
      setError(err instanceof Error ? err.message : "Could not sign in with passkey.");
    } finally {
      setLoading(false);
    }
  };

  const handleSignupStart = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.signupStart(phone.trim());
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
      setError("Enter the link code from /linkapp in @payeetbot.");
      return;
    }
    if (!/^\d{4}$/.test(linkPin)) {
      setError("Enter your existing 4-digit Proxim wallet PIN.");
      return;
    }
    setLoading(true);
    try {
      const start = await api.linkStart(cleanedCode);
      const response = await createPasskey(start.options);
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

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
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
                  Passkeys require the native Android APK build (not Expo Go). Build with{" "}
                  <Text style={{ fontWeight: "700" }}>eas build -p android --profile preview</Text>.
                </Text>
              </View>
            </Card>
          ) : null}

          <ErrorBanner message={sessionNotice} onDismiss={clearSessionNotice} />
          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          {step === "welcome" ? (
            <View>
              <Card>
                <Text style={styles.cardTitle}>Get started</Text>
                <Text style={styles.cardSub}>
                  Create a new Proxim wallet with your phone number, link your existing Telegram bot
                  wallet, or sign in with your saved passkey.
                </Text>
                <Button
                  title="Sign in with passkey"
                  onPress={handlePasskeySignIn}
                  loading={loading}
                  style={{ marginBottom: 10 }}
                />
                <Button
                  title="I already use Proxim on Telegram"
                  variant="secondary"
                  onPress={() => {
                    setError(null);
                    setStep("link_telegram");
                  }}
                  style={{ marginBottom: 10 }}
                />
                <Button
                  title="Create new account with phone"
                  variant="ghost"
                  onPress={() => {
                    setError(null);
                    setStep("signup_phone");
                  }}
                />
              </Card>
              <Text style={styles.endpointFoot}>Connected to {API_BASE_URL}</Text>
            </View>
          ) : null}

          {step === "signup_phone" ? (
            <Card>
              <Text style={styles.cardTitle}>Create your account</Text>
              <Text style={styles.cardSub}>
                Enter your phone number in international format to receive a one-time SMS code.
              </Text>
              <Input
                label="Phone number"
                placeholder="+2348012345678"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoCapitalize="none"
              />
              <Button title="Continue" onPress={handleSignupStart} loading={loading} />
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
              <Text style={styles.cardTitle}>Verify your phone</Text>
              <Text style={styles.cardSub}>Enter the code sent to {phone}.</Text>
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
                onPress={() => setStep("signup_phone")}
                style={{ marginTop: 8 }}
              />
            </Card>
          ) : null}

          {step === "signup_passkey" ? (
            <Card>
              <Text style={styles.cardTitle}>Set PIN & create passkey</Text>
              <Text style={styles.cardSub}>
                Your 4-digit PIN encrypts your wallet key, and your device passkey protects every
                login and money transfer.
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
              <Button title="Create passkey" onPress={handleFinishSignup} loading={loading} />
            </Card>
          ) : null}

          {step === "link_telegram" ? (
            <Card>
              <Text style={styles.cardTitle}>Link Telegram account</Text>
              <Text style={styles.cardSub}>
                1. Open <Text style={{ color: COLORS.primary, fontWeight: "700" }}>@payeetbot</Text>{" "}
                in Telegram and send <Text style={{ fontWeight: "700", color: COLORS.text }}>/linkapp</Text>.
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
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  brandTag: {
    color: COLORS.textSecondary,
    fontSize: 13,
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
    color: "#FDE68A",
    fontSize: 12,
    flex: 1,
    lineHeight: 18,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 6,
  },
  cardSub: {
    color: COLORS.textSecondary,
    fontSize: 13,
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
    fontSize: 13,
    flex: 1,
  },
  endpointFoot: {
    color: COLORS.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 8,
  },
});
