import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { TransactionItem } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, RADIUS, SPACING, TYPE, createThemeStyles } from "../theme";
import { EmptyState, ErrorBanner, ScreenHeader } from "../components/UI";
import { PressableScale } from "../components/Touch";
import { groupByDay, isCreditTx, SkeletonRows, TxDetailSheet, TxRow } from "../components/Activity";

type Filter = "all" | "in" | "out" | "bank";
const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["in", "Money in"],
  ["out", "Money out"],
  ["bank", "Bank payouts"],
];

/** Full transaction history on its own screen (Home shows only the latest few). */
export function ActivityScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, dataVersion } = useApp();
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<TransactionItem | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      setError(null);
      try {
        const res = await api.getTransactions(100, activeAccount);
        setItems(res.transactions || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load your activity.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    load(false);
  }, [load, dataVersion]);

  const shown = useMemo(() => {
    if (filter === "in") return items.filter(isCreditTx);
    if (filter === "out") return items.filter((t) => !isCreditTx(t));
    if (filter === "bank") return items.filter((t) => /offramp|payout/i.test(t.type));
    return items;
  }, [items, filter]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Activity" subtitle={activeAccount === "business" ? "Business account" : "Personal account"} onBack={onBack} />
      <View style={styles.filters}>
        {FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <PressableScale
              key={key}
              onPress={() => setFilter(key)}
              haptic="selection"
              depth={0.94}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
            </PressableScale>
          );
        })}
      </View>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SectionList
        sections={loading ? [] : groupByDay(shown)}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item }) => <TxRow tx={item} onPress={() => setSelected(item)} />}
        renderSectionHeader={({ section }) => <Text style={styles.day}>{section.title}</Text>}
        stickySectionHeadersEnabled={false}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={COLORS.primary} />}
        ListEmptyComponent={
          loading ? (
            <SkeletonRows count={6} />
          ) : (
            <View style={styles.emptyCard}>
              <EmptyState
                icon="time-outline"
                title={filter === "all" ? "No activity yet" : "Nothing here"}
                subtitle={filter === "all" ? "Money you add, send or receive shows up here." : "Try another filter."}
              />
            </View>
          )
        }
      />
      <TxDetailSheet tx={selected} activeAccount={activeAccount} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = createThemeStyles(() => ({
  root: { flex: 1, backgroundColor: COLORS.bg },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: SPACING.md, paddingBottom: 8 },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    justifyContent: "center",
    ...DEPTH.raised,
  },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary, borderBottomColor: COLORS.primary },
  chipText: { ...TYPE.label, color: COLORS.text },
  chipTextOn: { color: COLORS.onPrimary, fontFamily: TYPE.bodyStrong.fontFamily },
  list: { paddingHorizontal: SPACING.md, paddingBottom: 32 },
  day: { ...TYPE.overline, color: COLORS.textMuted, marginTop: 12, marginBottom: 8 },
  emptyCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, ...DEPTH.card },
}));
