// Optional native modules, loaded only when a feature is used (not at app start).
// An app build without one of these gets null back and the feature degrades instead of
// the app crashing on launch.
/* eslint-disable @typescript-eslint/no-require-imports */
import { reportError } from "./crashReporter";

type ImagePicker = typeof import("expo-image-picker");
type Sharing = typeof import("expo-sharing");
type LegacyFileSystem = typeof import("expo-file-system/legacy");
type Notifications = typeof import("expo-notifications");

const cache = new Map<string, unknown>();

function load<T>(name: string, loader: () => T): T | null {
  if (cache.has(name)) return cache.get(name) as T | null;
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

export const getImagePicker = () => load<ImagePicker>("expo-image-picker", () => require("expo-image-picker"));
export const getSharing = () => load<Sharing>("expo-sharing", () => require("expo-sharing"));
export const getLegacyFileSystem = () => load<LegacyFileSystem>("expo-file-system/legacy", () => require("expo-file-system/legacy"));

let handlerSet = false;
export const getNotifications = () => {
  const N = load<Notifications>("expo-notifications", () => require("expo-notifications"));
  if (N && !handlerSet) {
    handlerSet = true;
    try {
      N.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
      });
    } catch (err) {
      reportError(err, "notifications:handler");
    }
  }
  return N;
};
