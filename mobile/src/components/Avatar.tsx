import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Linking, Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import { useApp } from "../state/AppContext";
import { COLORS, TYPE, createThemeStyles } from "../theme";
import { PressableScale } from "./Touch";
import { getImagePicker, getLegacyFileSystem } from "../nativeModules";
import { toUserError } from "../utils/errors";

const LATEST_APK_URL = "https://github.com/igboze/PayIt/releases/download/android-latest/Proxim.apk";

function getAvatarTones(): ReadonlyArray<readonly [string, string]> {
  return [
    ["#FFFFFF", "#053023"],
    ["#FFFFFF", "#006E44"],
    ["#FFFFFF", "#1E293B"],
    [COLORS.successText, COLORS.primaryMuted],
    [COLORS.text, COLORS.surfaceElevated],
  ];
}

function initialsOf(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "P";
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

/** The signed-in user's profile photo, or their initials when there is none. */
export function UserAvatar({ size = 44, name }: { size?: number; name?: string | null }) {
  const { user } = useApp();
  const [failed, setFailed] = useState(false);
  const token = getAccessToken();
  const version = user?.avatarVersion || null;
  useEffect(() => {
    setFailed(false);
  }, [version]);
  const label = name || user?.senderName || user?.username || "Proxim";
  const txt = initialsOf(label);
  const tones = getAvatarTones();
  const [fg, bg] = tones[[...txt].reduce((a, c) => a + c.charCodeAt(0), 0) % tones.length];
  const box = { width: size, height: size, borderRadius: size / 2 };

  if (version && token && !failed) {
    return (
      <Image
        source={{ uri: api.getAvatarUrl(version), headers: { Authorization: `Bearer ${token}` } }}
        onError={() => setFailed(true)}
        style={[box, styles.photo]}
        accessibilityLabel="Your profile photo"
      />
    );
  }
  return (
    <View style={[box, { backgroundColor: bg, alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ ...TYPE.bodyStrong, color: fg, fontSize: Math.round(size * 0.36) }}>{txt}</Text>
    </View>
  );
}


/** Large avatar with a camera button: pick a photo, crop it square, upload it. */
export function EditableAvatar({ size = 96 }: { size?: number }) {
  const { user, refreshMe } = useApp();
  const [busy, setBusy] = useState(false);

  const upload = async (fromCamera: boolean) => {
    if (Platform.OS === "web") {
      Alert.alert("Use the mobile app", "Profile photos can be uploaded from the Proxim mobile app.");
      return;
    }
    const Picker = getImagePicker();
    if (!Picker) {
      Alert.alert(
        "Reinstall latest APK",
        "Your installed Proxim build doesn't include photo upload yet. Download and install the latest APK once (your account stays signed in).",
        [
          { text: "Not now", style: "cancel" },
          { text: "Download APK", onPress: () => Linking.openURL(LATEST_APK_URL).catch(() => {}) },
        ]
      );
      return;
    }
    try {
      const perm = fromCamera ? await Picker.requestCameraPermissionsAsync() : await Picker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", fromCamera ? "Allow camera access to take a photo." : "Allow photo access to choose a picture.");
        return;
      }
      const opts = {
        mediaTypes: ["images"] as never,
        allowsEditing: true,
        aspect: [1, 1] as [number, number],
        quality: 0.65,
        base64: true,
      };
      const res = fromCamera ? await Picker.launchCameraAsync(opts) : await Picker.launchImageLibraryAsync(opts);
      const asset = res.assets?.[0];
      if (res.canceled || !asset) return;
      let base64 = asset.base64 || null;
      if (!base64 && asset.uri) {
        const FS = getLegacyFileSystem();
        if (FS?.readAsStringAsync) {
          base64 = await FS.readAsStringAsync(asset.uri, { encoding: "base64" as never });
        }
      }
      if (!base64) {
        Alert.alert("Couldn't read photo", "Please choose another photo and try again.");
        return;
      }
      setBusy(true);
      await api.uploadAvatar(base64);
      await refreshMe();
    } catch (err) {
      Alert.alert("Couldn't update your photo", toUserError(err, "Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAvatar();
      await refreshMe();
    } catch (err) {
      Alert.alert("Couldn't remove your photo", toUserError(err, "Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    const options: Array<{ text: string; onPress?: () => void; style?: "cancel" | "destructive" }> = [
      { text: "Choose from gallery", onPress: () => upload(false) },
      { text: "Take a photo", onPress: () => upload(true) },
    ];
    if (user?.avatarVersion) options.push({ text: "Remove photo", style: "destructive", onPress: remove });
    options.push({ text: "Cancel", style: "cancel" });
    Alert.alert("Profile photo", undefined, options);
  };

  return (
    <PressableScale onPress={open} depth={0.95} accessibilityLabel="Change profile photo" style={{ alignSelf: "center" }}>
      <View>
        <UserAvatar size={size} />
        {busy ? (
          <View style={[styles.busy, { width: size, height: size, borderRadius: size / 2 }]}>
            <ActivityIndicator color="#FFFFFF" />
          </View>
        ) : null}
        <View style={styles.cameraBadge}>
          <Ionicons name="camera" size={16} color={COLORS.onPrimary} />
        </View>
      </View>
    </PressableScale>
  );
}

const styles = createThemeStyles(() => ({
  photo: { backgroundColor: COLORS.surfaceElevated, borderWidth: 2, borderColor: COLORS.surface },
  busy: { position: "absolute", top: 0, left: 0, backgroundColor: "rgba(14, 21, 18, 0.45)", alignItems: "center", justifyContent: "center" },
  cameraBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    borderWidth: 2,
    borderColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
  },
}));
