import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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
}

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
        const { accessToken, refreshToken } = await loadStoredTokens();
        if (accessToken || refreshToken) {
          const res = await api.me();
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

  const signInWithSession = useCallback(
    async (nextUser: ProximUser, session: AuthSession) => {
      await saveSessionTokens(session);
      setSessionNotice(null);
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
    setUser(null);
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
