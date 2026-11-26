import React, { useState } from "react";
import { ActivityIndicator, Alert, Image, Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, getAccessToken } from "../api/client";
import { useApp } from "../state/AppContext";
import { COLORS, TYPE } from "../theme";
import { PressableScale } from "./Touch";
import { getImagePicker } from "../nativeModules";

const TONES = [
  ["#002018", "#E0A82E"],
  ["#E0A82E", "#002018"],
  ["#002018", "#F6E7BF"],
  ["#002018", "#EDE7DA"],
  ["#FFFFFF", "#007840"],
] as const;

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
  const label = name || user?.senderName || user?.username || "Proxim";
  const txt = initialsOf(label);
  const [fg, bg] = TONES[[...txt].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
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
    const Picker = getImagePicker();
    if (!Picker || Platform.OS === "web") {
      Alert.alert("Update the app", "Install the latest Proxim app to add a profile photo.");
      return;
    }
    try {
      const perm = fromCamera ? await Picker.requestCameraPermissionsAsync() : await Picker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", fromCamera ? "Allow camera access to take a photo." : "Allow photo access to choose a picture.");
        return;
      }
      const opts = { mediaTypes: ["images"] as never, allowsEditing: true, aspect: [1, 1] as [number, number], quality: 0.6, base64: true };
      const res = fromCamera ? await Picker.launchCameraAsync(opts) : await Picker.launchImageLibraryAsync(opts);
      if (res.canceled || !res.assets?.[0]?.base64) return;
      setBusy(true);
      await api.uploadAvatar(res.assets[0].base64);
      await refreshMe();
    } catch (err) {
      Alert.alert("Couldn't update your photo", err instanceof Error ? err.message : "Please try again.");
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
      Alert.alert("Couldn't remove your photo", err instanceof Error ? err.message : "Please try again.");
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

const styles = StyleSheet.create({
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
});
