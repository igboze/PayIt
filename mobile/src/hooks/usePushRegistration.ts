import { useEffect } from "react";
import { Platform } from "react-native";
import { api } from "../api/client";

// expo-notifications is a native module: an older APK updated over the air won't have it,
// and Android needs a Firebase config (google-services.json) in the build to issue tokens.
// Load it defensively so the app keeps working until both are in place.
type NotificationsModule = typeof import("expo-notifications");
let Notifications: NotificationsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require("expo-notifications") as NotificationsModule;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch (_) {
  Notifications = null;
}

/**
 * Registers this device for push once the user is signed in, so the server's notify()
 * (sends, payouts, savings sweeps, incoming money) reaches the phone.
 */
export function usePushRegistration(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn || !Notifications || Platform.OS === "web") return;
    let cancelled = false;
    (async () => {
      try {
        if (Platform.OS === "android") {
          await Notifications!.setNotificationChannelAsync("default", {
            name: "Payments",
            importance: Notifications!.AndroidImportance.HIGH,
          });
        }
        let perm = await Notifications!.getPermissionsAsync();
        if (!perm.granted && perm.canAskAgain) perm = await Notifications!.requestPermissionsAsync();
        if (!perm.granted || cancelled) return;
        // Native FCM/APNs token: the server sends through FCM HTTP v1 directly.
        const token = await Notifications!.getDevicePushTokenAsync();
        if (cancelled || !token?.data) return;
        await api.registerPush(String(token.data));
      } catch (err) {
        console.warn("[push] registration skipped:", err instanceof Error ? err.message : err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
}
