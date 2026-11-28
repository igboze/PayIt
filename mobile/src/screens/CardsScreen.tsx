import React, { useCallback, useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { PressableScale } from "../components/Touch";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { CardItem } from "../api/types";
import { useApp } from "../state/AppContext";
import { ProximCardFace } from "../components/ProximCardFace";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TABULAR_NUMS, TYPE, createThemeStyles } from "../theme";
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatUsdc,
  Input,
  KeyValueRow,
  Pill,
  SectionHeader,
  SkeletonCard,
  StatusBadge,
  SuccessBanner,
} from "../components/UI";

function cardIdOf(c: CardItem): string {
  return String(c.id || c.card_id || c.cardId || "");
}

export function CardsScreen() {
  const { user, activeAccount, dataVersion, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";

  const [cards, setCards] = useState<CardItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Issue card sheet
  const [showIssue, setShowIssue] = useState(false);
  const [cardType, setCardType] = useState<"virtual" | "disposable" | "team">("virtual");
  const [cardName, setCardName] = useState("");
  const [loadAmount, setLoadAmount] = useState("10");

  // Top-up sheet
  const [topupCardId, setTopupCardId] = useState<string | null>(null);
  const [topupAmount, setTopupAmount] = useState("");

  // Ephemeral revealed PAN/CVV (never persisted)
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);

  // Inline card activity for the active card
  const [cardTxs, setCardTxs] = useState<Array<Record<string, unknown>>>([]);
  const [txsLoading, setTxsLoading] = useState(false);

  const loadCards = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.listCards(activeAccount);
        const list = res.cards || [];
        setCards(list);
        setSelectedId((prev) => {
          if (prev && list.some((c) => cardIdOf(c) === prev)) return prev;
          return list.length > 0 ? cardIdOf(list[0]) : null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load cards.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    loadCards(false);
  }, [loadCards, dataVersion]);

  const activeCard = cards.find((c) => cardIdOf(c) === selectedId) || cards[0] || null;
  const activeCardId = activeCard ? cardIdOf(activeCard) : null;

  const loadInlineActivity = useCallback(async (id: string) => {
    setTxsLoading(true);
    try {
      const res = await api.listCardTransactions(id);
      setCardTxs(res.transactions || []);
    } catch {
      setCardTxs([]);
    } finally {
      setTxsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeCardId) loadInlineActivity(activeCardId);
    else setCardTxs([]);
  }, [activeCardId, loadInlineActivity]);

  const handleIssueCard = async () => {
    setError(null);
    try {
      const res = await requestApproval("card.issue", {
        accountType: activeAccount,
        cardType,
        cardName: cardName.trim() || undefined,
        loadAmountUsd: Number(loadAmount),
      });
      setNotice(res.notice || "Card issuance started!");
      setShowIssue(false);
      setCardName("");
      loadCards(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Card issuance failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleTopup = async () => {
    if (!topupCardId) return;
    setError(null);
    try {
      const res = await requestApproval("card.topup", {
        accountType: activeAccount,
        cardId: topupCardId,
        loadAmountUsd: Number(topupAmount),
      });
      setNotice(res.notice || "Card top-up submitted!");
      setTopupCardId(null);
      setTopupAmount("");
      loadCards(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Top-up failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleReveal = async (id: string) => {
    setError(null);
    try {
      const res = await requestApproval("card.reveal", {
        accountType: activeAccount,
        cardId: id,
      });
      if (res.card) setRevealed(res.card);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not reveal card details.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleFreezeToggle = async (id: string, currentlyFrozen: boolean) => {
    setError(null);
    try {
      const res = await requestApproval("card.freeze", {
        accountType: activeAccount,
        cardId: id,
        freeze: !currentlyFrozen,
      });
      setNotice(res.notice || "Card updated.");
      loadCards(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not update card.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleUnload = async (id: string) => {
    setError(null);
    try {
      const res = await requestApproval("card.unload", {
        accountType: activeAccount,
        cardId: id,
      });
      setNotice(res.notice || "Card balance returned to your balance.");
      loadCards(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not unload card.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleDelete = (id: string) => {
    Alert.alert("Delete virtual card", "Permanently close this card? Any remaining funds should be unloaded first.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete card",
        style: "destructive",
        onPress: async () => {
          setError(null);
          try {
            const res = await requestApproval("card.delete", {
              accountType: activeAccount,
              cardId: id,
            });
            setNotice(res.notice || "Card deleted.");
            loadCards(true);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Could not delete card.";
            if (!/cancel/i.test(msg)) setError(msg);
          }
        },
      },
    ]);
  };

  const isFrozen = activeCard
    ? Boolean(activeCard.frozen || String(activeCard.status || "").toLowerCase() === "frozen")
    : false;
  const activeBal = activeCard ? activeCard.balanceUsd ?? activeCard.balance : undefined;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadCards(true)} tintColor={COLORS.primary} />
      }
    >
      <SectionHeader
        title={`${isBiz ? "Team" : "Virtual"} USD Cards`}
        right={
          <Pill
            label="+ New Card"
            active
            tone={isBiz ? "business" : "primary"}
            onPress={() => setShowIssue(true)}
          />
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

      {loading && cards.length === 0 ? (
        <SkeletonCard rows={3} />
      ) : cards.length === 0 ? (
        <Card>
          <EmptyState
            icon="card-outline"
            title="No virtual USD cards yet"
            subtitle={`Issue an instant virtual or disposable USD card funded from your ${isBiz ? "Business" : "Personal"} balance for Apple, Netflix, AWS, Ads, and global checkout.`}
          />
          <Button title="Create your first card" onPress={() => setShowIssue(true)} />
        </Card>
      ) : activeCard && activeCardId ? (
        <>
          {/* Multi-card switcher pills */}
          {cards.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {cards.map((c) => {
                  const id = cardIdOf(c);
                  const tail = c.last4 ? `•••• ${c.last4}` : "Card";
                  return (
                    <Pill
                      key={id}
                      label={`${c.name || c.card_name || "Card"} · ${tail}`}
                      active={id === activeCardId}
                      onPress={() => setSelectedId(id)}
                    />
                  );
                })}
              </View>
            </ScrollView>
          ) : null}

          {/* Full-bleed Apple Wallet style Card Hero */}
          <View style={styles.cardHeroWrap}>
            <ProximCardFace
              last4={activeCard.last4}
              expiryMonth={activeCard.expiryMonth}
              expiryYear={activeCard.expiryYear}
              holderName={(isBiz ? user?.bizSenderName : user?.senderName) || user?.senderName}
              frozen={isFrozen}
            />
          </View>

          {/* Clean balance + status bar */}
          <View style={styles.balanceStrip}>
            <View>
              <Text style={styles.cardMetaOverline}>
                {activeCard.name || activeCard.card_name || "Proxim Virtual Card"}
              </Text>
              <Text style={styles.cardHeroBal}>
                {balanceHidden ? "$••••" : activeBal !== undefined ? formatUsdc(activeBal) : "—"}
              </Text>
            </View>
            <StatusBadge
              label={isFrozen ? "Frozen" : String(activeCard.status || "Active")}
              icon={isFrozen ? "snow" : "checkmark-circle"}
              tone={isFrozen ? "danger" : "success"}
            />
          </View>

          {/* 4 circular primary controls right beneath the card */}
          <View style={styles.roundRow}>
            {(
              [
                ["add", "Top up", () => setTopupCardId(activeCardId), true],
                ["eye-outline", "Details", () => handleReveal(activeCardId), false],
                [
                  isFrozen ? "sunny-outline" : "snow-outline",
                  isFrozen ? "Unfreeze" : "Freeze",
                  () => handleFreezeToggle(activeCardId, isFrozen),
                  false,
                ],
                ["arrow-undo-outline", "Unload", () => handleUnload(activeCardId), false],
              ] as Array<[keyof typeof Ionicons.glyphMap, string, () => void, boolean]>
            ).map(([icon, label, fn, main]) => (
              <PressableScale
                key={label}
                onPress={fn}
                depth={0.92}
                haptic="light"
                style={styles.roundItem}
                accessibilityRole="button"
                accessibilityLabel={label}
              >
                <View style={[styles.roundBtn, main && styles.roundBtnMain]}>
                  <Ionicons name={icon} size={20} color={main ? COLORS.onGold : COLORS.primary} />
                </View>
                <Text style={styles.roundLabel}>{label}</Text>
              </PressableScale>
            ))}
          </View>

          {/* Inline Card Activity */}
          <Card style={{ marginTop: 16 }}>
            <SectionHeader
              title="Card Activity"
              right={
                <PressableScale
                  onPress={() => loadInlineActivity(activeCardId)}
                  haptic="selection"
                  style={{ padding: 4 }}
                >
                  <Ionicons name="refresh" size={16} color={COLORS.textSecondary} />
                </PressableScale>
              }
            />
            {txsLoading ? (
              <View style={{ paddingVertical: 18, alignItems: "center" }}>
                <ActivityIndicator color={COLORS.primary} size="small" />
              </View>
            ) : cardTxs.length > 0 ? (
              cardTxs.slice(0, 12).map((t, i) => (
                <KeyValueRow
                  key={i}
                  currency={String(t.currency || "USD")}
                  label={String(t.merchant || t.description || t.type || `Card tx #${i + 1}`)}
                  value={`${t.amount ?? ""} ${t.currency || "USD"}`}
                />
              ))
            ) : (
              <EmptyState
                icon="receipt-outline"
                title="No card spend yet"
                subtitle="Online purchases on this card appear here automatically."
              />
            )}
          </Card>

          <PressableScale
            onPress={() => handleDelete(activeCardId)}
            haptic="light"
            style={styles.deleteLink}
            accessibilityRole="button"
          >
            <Ionicons name="trash-outline" size={15} color={COLORS.dangerText} />
            <Text style={styles.deleteText}>Close &amp; delete card</Text>
          </PressableScale>
        </>
      ) : null}

      {/* Issue Card Bottom Sheet */}
      <BottomSheet
        visible={showIssue}
        onClose={() => setShowIssue(false)}
        title="New Virtual USD Card"
        subtitle={`Funded from your ${isBiz ? "Business" : "Personal"} balance.`}
      >
        <View style={styles.pillRow}>
          <Pill label="Virtual" active={cardType === "virtual"} onPress={() => setCardType("virtual")} />
          <Pill label="Disposable" active={cardType === "disposable"} onPress={() => setCardType("disposable")} />
          {isBiz ? (
            <Pill label="Team" active={cardType === "team"} tone="business" onPress={() => setCardType("team")} />
          ) : null}
        </View>
        <Input
          label="Card nickname (optional)"
          placeholder="e.g. Cloud Hosting, Ads, Shopping"
          value={cardName}
          onChangeText={setCardName}
        />
        <Input
          label="Initial Load Amount (USD)"
          placeholder="e.g. 25"
          value={loadAmount}
          onChangeText={setLoadAmount}
          keyboardType="decimal-pad"
        />
        <Button title="Review & issue card" onPress={handleIssueCard} />
        <Button title="Cancel" variant="ghost" onPress={() => setShowIssue(false)} style={{ marginTop: 6 }} />
      </BottomSheet>

      {/* Top-up Bottom Sheet */}
      <BottomSheet
        visible={Boolean(topupCardId)}
        onClose={() => setTopupCardId(null)}
        title="Top Up Card"
        subtitle="Funds transfer instantly from your Proxim balance."
      >
        <View style={styles.presetRow}>
          {[10, 25, 50, 100].map((v) => (
            <PressableScale
              key={v}
              onPress={() => setTopupAmount(String(v))}
              haptic="selection"
              style={[styles.presetChip, Number(topupAmount) === v && styles.presetChipOn]}
            >
              <Text style={[styles.presetText, Number(topupAmount) === v && { color: COLORS.primary }]}>${v}</Text>
            </PressableScale>
          ))}
        </View>
        <Input
          label="Amount (USD)"
          placeholder="e.g. 20"
          value={topupAmount}
          onChangeText={setTopupAmount}
          keyboardType="decimal-pad"
        />
        <Button title="Review & top up" onPress={handleTopup} />
        <Button title="Cancel" variant="ghost" onPress={() => setTopupCardId(null)} style={{ marginTop: 6 }} />
      </BottomSheet>

      {/* Revealed Card Details Bottom Sheet */}
      <BottomSheet
        visible={Boolean(revealed)}
        onClose={() => setRevealed(null)}
        title="Card Details"
        subtitle="Keep your card number and CVV private."
      >
        {revealed ? (
          <ScrollView style={{ maxHeight: 340 }}>
            {Object.entries(revealed)
              .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
              .map(([k, v]) => (
                <KeyValueRow
                  key={k}
                  label={k}
                  currency={false}
                  value={String(v)}
                  onCopy={() => {
                    Clipboard.setStringAsync(String(v));
                    setNotice(`${k} copied`);
                  }}
                />
              ))}
          </ScrollView>
        ) : null}
        <Button title="Hide details" onPress={() => setRevealed(null)} style={{ marginTop: 14 }} />
      </BottomSheet>
    </ScrollView>
  );
}

const styles = createThemeStyles(() => ({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 36 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  cardHeroWrap: {
    marginBottom: 14,
  },
  balanceStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 14,
  },
  cardMetaOverline: {
    ...TYPE.overline,
    fontSize: 10.5,
    color: COLORS.textSecondary,
  },
  cardHeroBal: {
    ...TYPE.display,
    ...TABULAR_NUMS,
    color: COLORS.text,
    marginTop: 2,
  },
  roundRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  roundItem: { alignItems: "center", gap: 6, flex: 1 },
  roundBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: COLORS.surface,
    ...DEPTH.card,
    alignItems: "center",
    justifyContent: "center",
  },
  roundBtnMain: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  roundLabel: { fontFamily: FONTS.semibold, fontSize: 12, color: COLORS.text },
  deleteLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 6,
    minHeight: 40,
  },
  deleteText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.dangerText },
  presetRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  presetChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.page,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
  },
  presetChipOn: {
    backgroundColor: COLORS.primaryMuted,
    borderColor: COLORS.primary,
  },
  presetText: { fontFamily: FONTS.bold, fontSize: 13, ...TABULAR_NUMS, color: COLORS.text },
}));
