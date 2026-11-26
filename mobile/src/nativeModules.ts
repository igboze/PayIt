// Optional native modules, loaded only when a feature is used (not at app start).
// IMPORTANT: In React Native / Metro release builds, calling `require("expo-...")` when a
// native module is missing from an older APK triggers Metro's `guardedLoadModule`, which
// calls `ErrorUtils.reportFatalError` and crashes the app *even inside try/catch*.
// We therefore check `requireOptionalNativeModule` from `expo-modules-core` FIRST — it
// safely returns `null` without throwing or invoking `requireNativeModule`.
/* eslint-disable @typescript-eslint/no-require-imports */
import { requireOptionalNativeModule } from "expo-modules-core";
import { reportError } from "./crashReporter";

type ImagePicker = typeof import("expo-image-picker");
type Sharing = typeof import("expo-sharing");
type LegacyFileSystem = typeof import("expo-file-system/legacy");
type Notifications = typeof import("expo-notifications");

const cache = new Map<string, unknown>();

function hasAllNativeModules(nativeNames: string[]): boolean {
  try {
    return nativeNames.every((n) => Boolean(requireOptionalNativeModule(n)));
  } catch {
    return false;
  }
}

function hasAnyNativeModule(nativeNames: string[]): boolean {
  try {
    return nativeNames.some((n) => Boolean(requireOptionalNativeModule(n)));
  } catch {
    return false;
  }
}

function load<T>(name: string, available: () => boolean, loader: () => T): T | null {
  if (cache.has(name)) return cache.get(name) as T | null;
  if (!available()) {
    cache.set(name, null);
    return null;
  }
  let mod: T | null = null;
  try {
    mod = loader();
  } catch (err) {
    reportError(err, `load:${name}`);
    mod = null;
  }
  cache.set(name, mod);
  return mod;
}

export const getImagePicker = () =>
  load<ImagePicker>(
    "expo-image-picker",
    () => hasAllNativeModules(["ExponentImagePicker"]),
    () => require("expo-image-picker")
  );

export const getSharing = () =>
  load<Sharing>(
    "expo-sharing",
    () => hasAllNativeModules(["ExpoSharing"]),
    () => require("expo-sharing")
  );

export const getLegacyFileSystem = () =>
  load<LegacyFileSystem>(
    "expo-file-system/legacy",
    () => hasAnyNativeModule(["ExponentFileSystem", "FileSystem"]),
    () => require("expo-file-system/legacy")
  );

let handlerSet = false;
export const getNotifications = () => {
  const N = load<Notifications>(
    "expo-notifications",
    () =>
      hasAllNativeModules([
        "ExpoPushTokenManager",
        "ExpoNotificationsEmitter",
        "ExpoNotificationPermissionsModule",
        "ExpoNotificationScheduler",
      ]),
    () => require("expo-notifications")
  );
  if (N && !handlerSet) {
    handlerSet = true;
    try {
      N.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
    } catch (err) {
      reportError(err, "notifications:handler");
    }
  }
  return N;
};
