import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "../api/client";
import type { AppNotification } from "../api/types";
import { notifyHaptic } from "../components/Touch";

const POLL_MS = 45_000;

/**
 * Keeps the in-app notification inbox fresh while the app is open: unread count for the
 * bell, and the newest unseen message for the in-app banner.
 */
export function useInbox(signedIn: boolean, onNewData?: () => void) {
  const [unread, setUnread] = useState(0);
  const [banner, setBanner] = useState<AppNotification | null>(null);
  const lastId = useRef(0);
  const primed = useRef(false);

  const check = useCallback(async () => {
    if (!signedIn) return;
    try {
      const res = await api.listNotifications();
      setUnread(res.unread || 0);
      const newest = res.notifications[0];
      if (newest && newest.id > lastId.current) {
        // Only surface messages that arrive while the app is running, not the backlog.
        if (primed.current && !newest.read) {
          setBanner(newest);
          notifyHaptic("success");
          onNewData?.();
        }
        lastId.current = newest.id;
      }
      primed.current = true;
    } catch (_) {
      // Offline or signed out: try again next tick.
    }
  }, [signedIn, onNewData]);

  useEffect(() => {
    if (!signedIn) {
      setUnread(0);
      lastId.current = 0;
      primed.current = false;
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
