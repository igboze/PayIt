import React, { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type { AppNotification } from "../api/types";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE } from "../theme";
import { EmptyState, ScreenHeader } from "../components/UI";
import { SkeletonRows, dayLabel, timeOf } from "../components/Activity";

type IoniconName = keyof typeof Ionicons.glyphMap;

function iconFor(kind: string | null): { icon: IoniconName; fg: string; bg: string } {
  const k = String(kind || "");
  if (/auto_earn|saving/.test(k)) return { icon: "server-outline", fg: "#FFFFFF", bg: "#002018" };
  if (/receive|deposit|credit/.test(k)) return { icon: "arrow-down", fg: "#007A47", bg: "#DFF2E8" };
  if (/device|security|pin/.test(k)) return { icon: "shield-checkmark-outline", fg: "#002018", bg: "#DFF2E8" };
  if (/card/.test(k)) return { icon: "card-outline", fg: "#0F172A", bg: "#E8EDF5" };
  if (/fail|error/.test(k)) return { icon: "alert-circle-outline", fg: COLORS.dangerText, bg: COLORS.dangerMuted };
  return { icon: "notifications-outline", fg: "#002018", bg: "#E6EEEA" };
}

export function NotificationsScreen({ onBack, onOpened }: { onBack: () => void; onOpened?: () => void }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await api.listNotifications();
      setItems(res.notifications || []);
      if (res.unread > 0) {
        await api.markNotificationsRead().catch(() => {});
        onOpened?.();
      }
    } catch (_) {
      // keep what we have
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onOpened]);

  useEffect(() => {
    load(false);
  }, [load]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Notifications" onBack={onBack} />
      <FlatList
        data={items}
        keyExtractor={(n) => String(n.id)}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={COLORS.primary} />}
        renderItem={({ item }) => {
          const v = iconFor(item.kind);
          return (
            <View style={styles.row}>
              <View style={[styles.tile, { backgroundColor: v.bg }]}>
                <Ionicons name={v.icon} size={20} color={v.fg} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {!item.read ? <View style={styles.dot} /> : null}
                </View>
                <Text style={styles.body}>{item.body}</Text>
                <Text style={styles.when}>{`${dayLabel(item.createdAt)}, ${timeOf(item.createdAt)}`}</Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          loading ? (
            <SkeletonRows count={3} />
          ) : (
            <EmptyState icon="notifications-outline" title="Nothing yet" subtitle="Payments, savings and security alerts show up here." />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  list: { padding: SPACING.md, paddingBottom: 32 },
  row: { flexDirection: "row", gap: 14, padding: 14, borderRadius: RADIUS.md, backgroundColor: COLORS.surface, ...DEPTH.card },
  tile: { width: 40, height: 40, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { ...TYPE.bodyStrong, color: COLORS.text, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary },
  body: { ...TYPE.label, color: COLORS.textSecondary },
  when: { ...TYPE.label, fontSize: 12, color: COLORS.textMuted },
});
