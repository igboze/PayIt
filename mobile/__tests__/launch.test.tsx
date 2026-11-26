// Launch smoke test: a returning user (saved session) must reach the lock screen, and an
// unlocked user must reach Home, without any render error. Reproduces the path that
// crashed on phones after the cefa81b update.
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react-native";

const user = {
  id: "880001",
  username: "igboze",
  senderName: "Igboze Iboh Igboze",
  savedSenderName: null,
  bizSenderName: null,
  phone: "+234***",
  telegramLinked: true,
  kycTier: 1,
  personalKycTier: 1,
  businessKycTier: 0,
  depositAddress: "0x1111111111111111111111111111111111111111",
  activeDepositAddress: "0x1111111111111111111111111111111111111111",
  ngnAccount: { accountNumber: "9987939447", bankName: "Flutterwave MFB" },
  hasBusinessAccount: false,
  businessDepositAddress: null,
  activeContext: "personal",
  autoEarnEnabled: true,
  referralCode: "ref880001",
  deviceRestrictedUntil: null,
  avatarVersion: null,
};

jest.mock("../src/api/client", () => {
  const responses: Record<string, unknown> = {
    me: { user },
    getBalances: { totalUsdc: 0.48, totalNgn: 693, usdToNgnRate: 1443, ngnAccount: null, arc: { eurc: 0 }, pendingBridgeUsdc: 0 },
    getTransactions: { transactions: [] },
    getBankRates: { offRampRate: 1443, onRampRate: 1450 },
    listNotifications: { unread: 0, notifications: [] },
    loginStart: { challengeId: "c1", options: {} },
    loginFinish: { user, session: { accessToken: "a", refreshToken: "r", expiresIn: 900 } },
  };
  const api = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "getReceiptUrl" || prop === "getAvatarUrl") return () => "https://example.test/x";
        return jest.fn(async () => responses[prop] ?? {});
      },
    }
  );
  return {
    api,
    API_BASE_URL: "https://example.test/api/app/v1",
    loadStoredTokens: jest.fn(async () => ({ accessToken: "stored-access", refreshToken: "stored-refresh" })),
    saveSessionTokens: jest.fn(async () => {}),
    clearSessionTokens: jest.fn(async () => {}),
    onSessionInvalid: jest.fn(),
    setActiveAccountHeader: jest.fn(),
    getAccessToken: jest.fn(() => "stored-access"),
  };
});

jest.mock("../src/api/passkey", () => ({
  isPasskeySupported: () => true,
  createPasskey: jest.fn(async () => ({})),
  assertPasskey: jest.fn(async () => ({ id: "cred" })),
}));

jest.mock("../src/hooks/useAutoOtaUpdates", () => ({
  useAutoOtaUpdates: () => ({ enabled: false, checking: false, updateReady: false, statusMessage: null, updateId: null, runtimeVersion: null, isEmbeddedLaunch: true, checkNow: async () => {}, applyNow: async () => {} }),
}));

jest.mock("@expo-google-fonts/plus-jakarta-sans", () => ({
  useFonts: () => [true, null],
  PlusJakartaSans_400Regular: 1,
  PlusJakartaSans_500Medium: 1,
  PlusJakartaSans_600SemiBold: 1,
  PlusJakartaSans_700Bold: 1,
  PlusJakartaSans_800ExtraBold: 1,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const App = require("../App").default;

jest.setTimeout(40000);

describe("app launch", () => {
  it("returning user reaches the lock screen, then Home after unlocking", async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
      origError(...args);
    };
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Welcome back/)).toBeTruthy(), { timeout: 5000 });
      // The lock screen auto-starts passkey unlock after 300ms.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 600));
      });
      await waitFor(() => expect(screen.getByText(/Recent activity/)).toBeTruthy(), { timeout: 5000 });
    } finally {
      console.error = origError;
    }
    const fatal = errors.filter((e) => /error|exception|invariant|undefined is not|cannot read/i.test(String(e)) && !/act\(|not wrapped in act/i.test(String(e)));
    expect(fatal).toEqual([]);
  });
});
