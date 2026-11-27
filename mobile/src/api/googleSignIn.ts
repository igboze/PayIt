// Safe wrapper around @react-native-google-signin/google-signin.
// Loaded lazily so older APKs receiving an OTA update without the native Google Sign-In module
// never crash at startup and cleanly fall back to email sign-up.

type GoogleSignInModule = {
  GoogleSignin: {
    configure: (opts: { webClientId: string; offlineAccess?: boolean; forceCodeForRefreshToken?: boolean }) => void;
    hasPlayServices: (opts?: { showPlayServicesUpdateDialog?: boolean }) => Promise<boolean>;
    signIn: () => Promise<{
      type?: string;
      data?: { idToken?: string | null; user?: { email?: string; name?: string | null } };
      idToken?: string | null;
      user?: { email?: string; name?: string | null };
    }>;
    signOut?: () => Promise<void>;
  };
  statusCodes?: {
    SIGN_IN_CANCELLED?: string;
    IN_PROGRESS?: string;
    PLAY_SERVICES_NOT_AVAILABLE?: string;
  };
};

let _cachedMod: GoogleSignInModule | null | undefined;
let _configuredClientId: string | null = null;

function loadNativeModule(): GoogleSignInModule | null {
  if (_cachedMod !== undefined) return _cachedMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-google-signin/google-signin") as GoogleSignInModule;
    if (mod?.GoogleSignin && typeof mod.GoogleSignin.signIn === "function") {
      _cachedMod = mod;
      return mod;
    }
  } catch {
    // Native module not compiled into this binary yet (e.g. older APK before rebuild)
  }
  _cachedMod = null;
  return null;
}

export function getBundledGoogleWebClientId(): string | null {
  const fromEnv = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "").trim();
  return fromEnv || null;
}

export function isGoogleSignInNativeAvailable(): boolean {
  return loadNativeModule() !== null;
}

export type GoogleSignInResult =
  | { cancelled: true }
  | { cancelled: false; idToken: string; email: string | null; name: string | null };

export async function signInWithGoogleNative(webClientId: string): Promise<GoogleSignInResult> {
  const mod = loadNativeModule();
  if (!mod) {
    throw new Error("Update to the latest Proxim app build to use Continue with Google, or tap Continue with Email below.");
  }
  const cleanClientId = webClientId.trim();
  if (!cleanClientId) {
    throw new Error("Google Sign-In is almost ready — use Continue with Email for now.");
  }

  if (_configuredClientId !== cleanClientId) {
    mod.GoogleSignin.configure({
      webClientId: cleanClientId,
      offlineAccess: false,
    });
    _configuredClientId = cleanClientId;
  }

  try {
    await mod.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Clear stale cached account selection so the user always sees the account picker cleanly
    try {
      await mod.GoogleSignin.signOut?.();
    } catch {
      // Ignore if not signed in
    }
    const res = await mod.GoogleSignin.signIn();
    if (res?.type === "cancelled") {
      return { cancelled: true };
    }
    const idToken = res?.data?.idToken || res?.idToken || null;
    if (!idToken) {
      throw new Error("Google did not return an ID token. Check your Google Web Client ID configuration.");
    }
    const user = res?.data?.user || res?.user;
    return {
      cancelled: false,
      idToken,
      email: user?.email || null,
      name: user?.name || null,
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err || "");
    if (
      code === mod.statusCodes?.SIGN_IN_CANCELLED ||
      /cancel/i.test(msg)
    ) {
      return { cancelled: true };
    }
    if (code === mod.statusCodes?.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new Error("Google Play Services is not available on this device. Use Continue with Email instead.");
    }
    if (code === "10" || /DEVELOPER_ERROR/i.test(msg)) {
      throw new Error("Google Sign-In configuration mismatch (SHA-1 / Client ID). Use Continue with Email for now.");
    }
    throw err instanceof Error ? err : new Error(msg || "Could not sign in with Google.");
  }
}
