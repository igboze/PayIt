import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { assertPasskey } from "../api/passkey";

// Remembers that someone has signed in on this phone, so sign-in can go straight to
// fingerprint / face. Cleared only by an explicit sign-out (to add another account).
export const RETURNING_USER_KEY = "proxim_returning_user";
export const BALANCE_HIDDEN_KEY = "proxim_balance_hidden_v1";
const rememberReturningUser = () => SecureStore.setItemAsync(RETURNING_USER_KEY, "1").catch(() => {});
let _cachedBalanceHidden: boolean | null = null;
import {
  api,
  clearSessionTokens,
  loadStoredTokens,
  onSessionInvalid,
  saveSessionTokens,
  setActiveAccountHeader,
} from "../api/client";
import type {
  AccountType,
  ActionConfirmResponse,
  ActionIntentResponse,
  AuthSession,
  ProximUser,
} from "../api/types";

export interface PendingApproval {
  intent: ActionIntentResponse;
  extraConfirmFields?: Record<string, string>;
  resolve: (result: ActionConfirmResponse) => void;
  reject: (err: Error) => void;
}

interface AppContextValue {
  user: ProximUser | null;
  activeAccount: AccountType;
  otherAccountBalanceUsdc: number | null;
  bootstrapping: boolean;
  switchingAccount: boolean;
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  dataVersion: number;
  bumpDataVersion: () => void;
  refreshMe: () => Promise<void>;
  signInWithSession: (user: ProximUser, session: AuthSession) => Promise<void>;
  signOut: () => Promise<void>;
  switchAccount: (target: AccountType) => Promise<void>;
  requestApproval: (
    actionType: string,
    payload: Record<string, unknown>,
    extraConfirmFields?: Record<string, string>
  ) => Promise<ActionConfirmResponse>;
  pendingApproval: PendingApproval | null;
  dismissApproval: (err?: Error) => void;
  completeApproval: (res: ActionConfirmResponse) => void;
  /** True while a returning user must confirm with their passkey before seeing anything. */
  locked: boolean;
  unlock: () => Promise<void>;
  /** True when the user has chosen to hide balances across the app (persisted on device). */
  balanceHidden: boolean;
  toggleBalanceHidden: () => void;
  setBalanceHidden: (next: boolean) => void;
}

// Lock again after this long in the background.
const RELOCK_AFTER_MS = 60 * 1000;

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ProximUser | null>(null);
  const [activeAccount, setActiveAccount] = useState<AccountType>("personal");
  const [otherAccountBalanceUsdc, setOtherAccountBalanceUsdc] = useState<number | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const pendingRef = useRef<PendingApproval | null>(null);
  const [locked, setLocked] = useState(false);
  const [balanceHidden, setBalanceHiddenState] = useState<boolean>(_cachedBalanceHidden ?? false);
  const backgroundedAt = useRef<number | null>(null);

  const setBalanceHidden = useCallback((next: boolean) => {
    _cachedBalanceHidden = next;
    setBalanceHiddenState(next);
    SecureStore.setItemAsync(BALANCE_HIDDEN_KEY, next ? "1" : "0").catch(() => {});
  }, []);

  const toggleBalanceHidden = useCallback(() => {
    setBalanceHiddenState((prev) => {
      const next = !prev;
      _cachedBalanceHidden = next;
      SecureStore.setItemAsync(BALANCE_HIDDEN_KEY, next ? "1" : "0").catch(() => {});
      return next;
    });
  }, []);

  const syncUser = useCallback((nextUser: ProximUser) => {
    const ctx: AccountType =
      nextUser.activeContext === "business" && nextUser.hasBusinessAccount ? "business" : "personal";
    setActiveAccountHeader(ctx);
    setActiveAccount(ctx);
    setUser(nextUser);
  }, []);

  const bumpDataVersion = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  const refreshMe = useCallback(async () => {
    const res = await api.me();
    syncUser(res.user);
  }, [syncUser]);

  useEffect(() => {
    onSessionInvalid((reason) => {
      setUser(null);
      setActiveAccount("personal");
      setActiveAccountHeader("personal");
      setOtherAccountBalanceUsdc(null);
      setSessionNotice(reason);
    });
    (async () => {
      try {
        const storedHidden = await SecureStore.getItemAsync(BALANCE_HIDDEN_KEY).catch(() => null);
        if (storedHidden === "1" || storedHidden === "0") {
          const isHidden = storedHidden === "1";
          _cachedBalanceHidden = isHidden;
          setBalanceHiddenState(isHidden);
        }
        const { accessToken, refreshToken } = await loadStoredTokens();
        if (accessToken || refreshToken) {
          const res = await api.me();
          // A returning user must unlock with their passkey before any balance shows.
          setLocked(true);
          syncUser(res.user);
        }
      } catch {
        await clearSessionTokens();
        setUser(null);
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [syncUser]);

  // Re-lock when the app comes back after a while in the background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAt.current = Date.now();
      } else if (state === "active") {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since && Date.now() - since > RELOCK_AFTER_MS) setLocked(true);
      }
    });
    return () => sub.remove();
  }, []);

  // Unlock = a real passkey sign-in: the server checks the passkey and issues a fresh session.
  const unlock = useCallback(async () => {
    const start = await api.loginStart();
    const response = await assertPasskey(start.options);
    const res = await api.loginFinish(start.challengeId, response);
    await saveSessionTokens(res.session);
    rememberReturningUser();
    syncUser(res.user);
    setLocked(false);
    setDataVersion((v) => v + 1);
  }, [syncUser]);

  const signInWithSession = useCallback(
    async (nextUser: ProximUser, session: AuthSession) => {
      await saveSessionTokens(session);
      rememberReturningUser();
      setSessionNotice(null);
      setLocked(false); // they just proved it's them
      syncUser(nextUser);
      bumpDataVersion();
    },
    [syncUser, bumpDataVersion]
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Clear local tokens even if server call fails
    }
    await clearSessionTokens();
    await SecureStore.deleteItemAsync(RETURNING_USER_KEY).catch(() => {});
    setUser(null);
    setLocked(false);
    setActiveAccount("personal");
    setActiveAccountHeader("personal");
    setOtherAccountBalanceUsdc(null);
  }, []);

  const switchAccount = useCallback(
    async (target: AccountType) => {
      setSwitchingAccount(true);
      try {
        const res = await api.switchAccount(target);
        setActiveAccountHeader(res.activeContext);
        setActiveAccount(res.activeContext);
        setUser(res.user);
        setOtherAccountBalanceUsdc(
          typeof res.account?.otherAccountBalanceUsdc === "number"
            ? res.account.otherAccountBalanceUsdc
            : null
        );
        bumpDataVersion();
      } finally {
        setSwitchingAccount(false);
      }
    },
    [bumpDataVersion]
  );

  const requestApproval = useCallback(
    async (
      actionType: string,
      payload: Record<string, unknown>,
      extraConfirmFields?: Record<string, string>
    ): Promise<ActionConfirmResponse> => {
      const intent = await api.actionIntent(actionType, payload);
      return new Promise<ActionConfirmResponse>((resolve, reject) => {
        const item: PendingApproval = { intent, extraConfirmFields, resolve, reject };
        pendingRef.current = item;
        setPendingApproval(item);
      });
    },
    []
  );

  const dismissApproval = useCallback((err?: Error) => {
    const cur = pendingRef.current;
    pendingRef.current = null;
    setPendingApproval(null);
    if (cur) cur.reject(err || new Error("Approval cancelled."));
  }, []);

  const completeApproval = useCallback(
    (res: ActionConfirmResponse) => {
      const cur = pendingRef.current;
      pendingRef.current = null;
      setPendingApproval(null);
      bumpDataVersion();
      if (res.actionType === "business.setup") {
        refreshMe().catch(() => {});
      }
      if (cur) cur.resolve(res);
    },
    [bumpDataVersion, refreshMe]
  );

  return (
    <AppContext.Provider
      value={{
        user,
        activeAccount,
        otherAccountBalanceUsdc,
        bootstrapping,
        switchingAccount,
        sessionNotice,
        clearSessionNotice: () => setSessionNotice(null),
        dataVersion,
        bumpDataVersion,
        refreshMe,
        signInWithSession,
        signOut,
        switchAccount,
        requestApproval,
        pendingApproval,
        dismissApproval,
        completeApproval,
        locked: Boolean(user) && locked,
        unlock,
        balanceHidden,
        toggleBalanceHidden,
        setBalanceHidden,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
