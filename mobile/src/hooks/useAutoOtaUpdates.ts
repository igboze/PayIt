import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";
import { toUserError } from "../utils/errors";

export interface OtaUpdateState {
  enabled: boolean;
  checking: boolean;
  updateReady: boolean;
  statusMessage: string | null;
  updateId: string | null;
  runtimeVersion: string | null;
  isEmbeddedLaunch: boolean;
  checkNow: (opts?: { silent?: boolean }) => Promise<void>;
  applyNow: () => Promise<void>;
}

const MIN_AUTO_CHECK_INTERVAL_MS = 60_000;

/**
 * Checks Proxim's self-hosted Expo Updates endpoint on app open & resume,
 * downloads any new JS/UI bundle in the background, and lets the user apply
 * it with one tap (or automatically on the next cold start).
 */
export function useAutoOtaUpdates(): OtaUpdateState {
  const [checking, setChecking] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);

  const enabled = !__DEV__ && Boolean(Updates.isEnabled);

  const checkNow = useCallback(
    async ({ silent = true }: { silent?: boolean } = {}) => {
      if (busyRef.current) return;
      if (!enabled) {
        if (!silent) setStatusMessage("Automatic updates are active on release builds.");
        return;
      }
      busyRef.current = true;
      lastCheckRef.current = Date.now();
      setChecking(true);
      if (!silent) setStatusMessage(null);

      try {
        const check = await Updates.checkForUpdateAsync();
        if (check.isAvailable) {
          const fetched = await Updates.fetchUpdateAsync();
          if (fetched.isNew) {
            setUpdateReady(true);
            setStatusMessage("Update downloaded and ready to apply.");
            return;
          }
        }
        if (!silent) {
          setStatusMessage("You're already on the latest version.");
        }
      } catch (err) {
        if (!silent) {
          setStatusMessage(toUserError(err, "Couldn't check for updates right now."));
        }
      } finally {
        busyRef.current = false;
        setChecking(false);
      }
    },
    [enabled]
  );

  const applyNow = useCallback(async () => {
    if (!enabled) return;
    try {
      await Updates.reloadAsync();
    } catch {
      setStatusMessage("Close and reopen Proxim to finish applying the update.");
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const initialTimer = setTimeout(() => {
      checkNow({ silent: true }).catch(() => {});
    }, 2500);

    const onStateChange = (next: AppStateStatus) => {
      if (next === "active" && Date.now() - lastCheckRef.current > MIN_AUTO_CHECK_INTERVAL_MS) {
        checkNow({ silent: true }).catch(() => {});
      }
    };
    const sub = AppState.addEventListener("change", onStateChange);
    return () => {
      clearTimeout(initialTimer);
      sub.remove();
    };
  }, [enabled, checkNow]);

  return {
    enabled,
    checking,
    updateReady,
    statusMessage,
    updateId: Updates.updateId || null,
    runtimeVersion: Updates.runtimeVersion || null,
    isEmbeddedLaunch: Boolean(Updates.isEmbeddedLaunch),
    checkNow,
    applyNow,
  };
}
