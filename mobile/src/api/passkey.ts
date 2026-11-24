import { Passkey } from "react-native-passkey";

/**
 * Wraps native Android Credential Manager / iOS ASAuthorization passkeys
 * and returns WebAuthn JSON compatible with @simplewebauthn/server.
 */

export function isPasskeySupported(): boolean {
  try {
    return Boolean(Passkey && typeof Passkey.isSupported === "function" && Passkey.isSupported());
  } catch {
    return false;
  }
}

function assertNativePasskeysAvailable(): void {
  if (!isPasskeySupported()) {
    throw new Error(
      "Native Passkeys are unavailable in this runtime. Build and install the Proxim Android APK (npx eas build -p android --profile preview) on a device with screen lock enabled."
    );
  }
}

function formatPasskeyError(err: unknown): Error {
  const raw = err as { error?: string; message?: string };
  const msg = String(raw?.message || raw?.error || "Passkey prompt failed.");
  if (/cancel/i.test(msg)) {
    return new Error("Passkey verification was cancelled.");
  }
  if (/not.?configured|origin|assetlinks|associated/i.test(msg)) {
    return new Error(
      "Passkey domain verification failed. Ensure APP_ANDROID_CERT_SHA256 and APP_ORIGINS are set on Railway for this APK."
    );
  }
  return new Error(msg);
}

export async function createPasskey(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertNativePasskeysAvailable();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await Passkey.create(options as any);
    return {
      ...res,
      id: res.id,
      rawId: res.rawId || res.id,
      type: res.type || "public-key",
      clientExtensionResults: res.clientExtensionResults || {},
    };
  } catch (err) {
    throw formatPasskeyError(err);
  }
}

export async function assertPasskey(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertNativePasskeysAvailable();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await Passkey.get(options as any);
    return {
      ...res,
      id: res.id,
      rawId: res.rawId || res.id,
      type: res.type || "public-key",
      clientExtensionResults: res.clientExtensionResults || {},
    };
  } catch (err) {
    throw formatPasskeyError(err);
  }
}
