// Optional native modules, loaded only when a feature is used (not at app start).
// IMPORTANT: In React Native / Metro release builds, calling `require("expo-...")` when a
// native module is missing from an older APK triggers Metro's `guardedLoadModule`, which
// calls `ErrorUtils.reportFatalError` and crashes the app *even inside try/catch*.
// We therefore check `requireOptionalNativeModule` from `expo-modules-core` FIRST — it
// safely returns `null` without throwing or invoking `requireNativeModule`.
/* eslint-disable @typescript-eslint/no-require-imports */
import { NativeModules } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { reportError } from "./crashReporter";

type ImagePicker = typeof import("expo-image-picker");
type DocumentPicker = typeof import("expo-document-picker");
type Sharing = typeof import("expo-sharing");
type LegacyFileSystem = typeof import("expo-file-system/legacy");
type Notifications = typeof import("expo-notifications");

const cache = new Map<string, unknown>();

function probeNativeModule(name: string): boolean {
  try {
    if (requireOptionalNativeModule(name)) return true;
  } catch {
    // Fall through to secondary probes
  }
  try {
    const expoModules = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
    if (expoModules && expoModules[name]) return true;
  } catch {
    // ignore
  }
  try {
    if (NativeModules && (NativeModules as Record<string, unknown>)[name]) return true;
  } catch {
    // ignore
  }
  return false;
}

function hasAllNativeModules(nativeNames: string[]): boolean {
  return nativeNames.every((n) => probeNativeModule(n));
}

function hasAnyNativeModule(nativeNames: string[]): boolean {
  return nativeNames.some((n) => probeNativeModule(n));
}

function load<T>(name: string, available: () => boolean, loader: () => T): T | null {
  if (cache.has(name)) return cache.get(name) as T;
  if (!available()) {
    // Never cache `null` permanently so a late-initialized module can still be loaded later.
    return null;
  }
  let mod: T | null = null;
  try {
    mod = loader();
  } catch (err) {
    reportError(err, `load:${name}`);
    mod = null;
  }
  if (mod) cache.set(name, mod);
  return mod;
}

export const getImagePicker = () =>
  load<ImagePicker>(
    "expo-image-picker",
    () => hasAnyNativeModule(["ExponentImagePicker", "ExpoImagePicker"]),
    () => require("expo-image-picker")
  );

export const getDocumentPicker = () =>
  load<DocumentPicker>(
    "expo-document-picker",
    () => hasAnyNativeModule(["ExpoDocumentPicker", "RNDocumentPicker"]),
    () => require("expo-document-picker")
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
