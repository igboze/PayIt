import { Passkey } from "react-native-passkey";
import { toUserError } from "../utils/errors";

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
      "Passkeys aren't available on this device right now. Make sure you have a screen lock (fingerprint, face, or PIN) enabled in your phone settings."
    );
  }
}

function formatPasskeyError(err: unknown): Error {
  const raw = err as { error?: string; message?: string };
  const msg = String(raw?.message || raw?.error || "");
  if (/cancel|dismissed|abort/i.test(msg)) {
    return new Error("Verification was cancelled.");
  }
  return new Error(
    toUserError(
      msg,
      "Couldn't verify your passkey right now. Make sure screen lock is enabled and try again."
    )
  );
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
