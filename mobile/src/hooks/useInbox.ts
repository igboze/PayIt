import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api } from "../api/client";
import type { AppNotification } from "../api/types";
import { notifyHaptic } from "../components/Touch";

const POLL_MS = 30_000;
const LAST_SHOWN_KEY = "proxim_last_notified_id";
const MAX_CATCH_UP = 3;

// expo-notifications is native; builds without it still get the in-app banner.
type NotificationsModule = typeof import("expo-notifications");
let Notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require("expo-notifications") as NotificationsModule;
} catch (_) {
  Notifications = null;
}

/** Puts a message in the phone's notification tray (works without Firebase). */
async function showSystemNotification(n: AppNotification) {
  if (!Notifications || Platform.OS === "web") return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, data: { inboxId: n.id, screen: "notifications" }, sound: "default" },
      trigger: Platform.OS === "android" ? { channelId: "default" } as never : null,
    });
  } catch (_) {
    // Tray unavailable: the in-app banner still shows it.
  }
}

/**
 * Keeps the notification inbox fresh: unread count for the bell, an in-app banner for the
 * newest message, and a system notification for every message not yet shown on this phone
 * (including ones that arrived while the app was closed).
 */
export function useInbox(signedIn: boolean, onNewData?: () => void) {
  const [unread, setUnread] = useState(0);
  const [banner, setBanner] = useState<AppNotification | null>(null);
  const lastShown = useRef<number | null>(null);

  const check = useCallback(async () => {
    if (!signedIn) return;
    try {
      if (lastShown.current === null) {
        const stored = await SecureStore.getItemAsync(LAST_SHOWN_KEY).catch(() => null);
        lastShown.current = Number(stored) || 0;
      }
      const res = await api.listNotifications();
      setUnread(res.unread || 0);
      const fresh = (res.notifications || []).filter((n) => n.id > (lastShown.current || 0) && !n.read);
      if (fresh.length) {
        const newest = fresh[0];
        setBanner(newest);
        notifyHaptic("success");
        // Oldest first so the tray reads in order; cap the catch-up after a long absence.
        for (const n of fresh.slice(0, MAX_CATCH_UP).reverse()) await showSystemNotification(n);
        onNewData?.();
      }
      const maxId = Math.max(lastShown.current || 0, ...(res.notifications || []).map((n) => n.id));
      if (maxId > (lastShown.current || 0)) {
        lastShown.current = maxId;
        SecureStore.setItemAsync(LAST_SHOWN_KEY, String(maxId)).catch(() => {});
      }
    } catch (_) {
      // Offline or signed out: try again next tick.
    }
  }, [signedIn, onNewData]);

  useEffect(() => {
    if (!signedIn) {
      setUnread(0);
      return;
    }
    check();
    let timer: ReturnType<typeof setInterval> | null = setInterval(check, POLL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        check();
        if (!timer) timer = setInterval(check, POLL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [signedIn, check]);

  const markAllRead = useCallback(async () => {
    setUnread(0);
    try {
      await api.markNotificationsRead();
    } catch (_) {}
  }, []);

  return { unread, banner, dismissBanner: () => setBanner(null), refresh: check, markAllRead };
}
