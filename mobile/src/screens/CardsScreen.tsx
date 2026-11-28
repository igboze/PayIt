import React, { useCallback, useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { PressableScale } from "../components/Touch";
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api/client";
import type { CardItem } from "../api/types";
import { useApp } from "../state/AppContext";
import { ProximCardFace } from "../components/ProximCardFace";
import { COLORS, RADIUS, SPACING, FONTS, createThemeStyles } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatUsdc,
  Input,
  KeyboardSafe,
  KeyValueRow,
  Pill,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";

function cardIdOf(c: CardItem): string {
  return String(c.id || c.card_id || c.cardId || "");
}

export function CardsScreen() {
  const { user, activeAccount, dataVersion, requestApproval, balanceHidden } = useApp();
  const isBiz = activeAccount === "business";

  const [cards, setCards] = useState<CardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Issue card form
  const [showIssue, setShowIssue] = useState(false);
  const [cardType, setCardType] = useState<"virtual" | "disposable" | "team">("virtual");
  const [cardName, setCardName] = useState("");
  const [loadAmount, setLoadAmount] = useState("10");

  // Top-up modal
  const [topupCardId, setTopupCardId] = useState<string | null>(null);
  const [topupAmount, setTopupAmount] = useState("");

  // Ephemeral revealed PAN/CVV (never persisted, auto-clears)
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);

  // Card transactions modal
  const [cardTxs, setCardTxs] = useState<Array<Record<string, unknown>> | null>(null);

  const loadCards = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.listCards(activeAccount);
        setCards(res.cards || []);
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
      if (res.card) {
        setRevealed(res.card);
      }
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
      setNotice(res.notice || "Card balance returned to wallet.");
      loadCards(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not unload card.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  const handleDelete = async (id: string) => {
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
  };

  const handleViewTransactions = async (id: string) => {
    setError(null);
    try {
      const res = await api.listCardTransactions(id);
      setCardTxs(res.transactions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load card transactions.");
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadCards(true)} tintColor={COLORS.primary} />
      }
    >
      <SectionHeader
        title={`${isBiz ? "Business" : "Personal"} Dollar Cards`}
        right={
          <Pill
            label={showIssue ? "Close" : "+ New Card"}
            active
            onPress={() => setShowIssue((v) => !v)}
          />
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

      {showIssue ? (
        <Card>
          <SectionHeader title="Issue Global Neobank USD Card" />
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
          <Button title="Quote & issue card" onPress={handleIssueCard} />
        </Card>
      ) : null}

      {loading && cards.length === 0 ? (
        <View style={{ paddingVertical: 40, alignItems: "center" }}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : cards.length === 0 ? (
        <Card>
          <EmptyState
            icon="card-outline"
            title="No cards yet"
            subtitle={`Issue a virtual or disposable USD card funded from your ${isBiz ? "Business" : "Personal"} wallet.`}
          />
          <Button title="Create your first card" onPress={() => setShowIssue(true)} />
        </Card>
      ) : (
        cards.map((c) => {
          const id = cardIdOf(c);
          const isFrozen = Boolean(c.frozen || String(c.status || "").toLowerCase() === "frozen");
          const bal = c.balanceUsd ?? c.balance;
          return (
            <Card key={id} style={styles.cardVisual}>
              <ProximCardFace
                last4={c.last4}
                expiryMonth={c.expiryMonth}
                expiryYear={c.expiryYear}
                holderName={(isBiz ? user?.bizSenderName : user?.senderName) || user?.senderName}
                frozen={isFrozen}
              />
              <View style={styles.cardTop}>
                <View>
                  <Text style={styles.cardTitle}>{c.name || c.card_name || "Proxim Card"}</Text>
                  <Text style={styles.cardLabel}>{String(c.brand || "Virtual USD card")}</Text>
                </View>
                <Pill
                  label={isFrozen ? "Frozen" : String(c.status || "Active")}
                  active
                  tone={isFrozen ? "danger" : "primary"}
                />
              </View>

              <View style={styles.cardFooter}>
                <View>
                  <Text style={styles.cardLabel}>Balance</Text>
                  <Text style={styles.cardBal}>{balanceHidden ? "$••••" : bal !== undefined ? formatUsdc(bal) : "—"}</Text>
                </View>
                {c.expiryMonth && c.expiryYear ? (
                  <View>
                    <Text style={styles.cardLabel}>Expires</Text>
                    <Text style={styles.cardBal}>
                      {String(c.expiryMonth).padStart(2, "0")}/{String(c.expiryYear).slice(-2)}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.roundRow}>
                {(
                  [
                    ["add", "Top up", () => setTopupCardId(id), true],
                    ["eye-outline", "Details", () => handleReveal(id), false],
                    [isFrozen ? "sunny-outline" : "snow-outline", isFrozen ? "Unfreeze" : "Freeze", () => handleFreezeToggle(id, isFrozen), false],
                    ["receipt-outline", "Activity", () => handleViewTransactions(id), false],
                    ["arrow-undo-outline", "Unload", () => handleUnload(id), false],
                  ] as Array<[keyof typeof Ionicons.glyphMap, string, () => void, boolean]>
                ).map(([icon, label, fn, main]) => (
                  <PressableScale key={label} onPress={fn} depth={0.92} haptic="light" style={styles.roundItem} accessibilityRole="button" accessibilityLabel={label}>
                    <View style={[styles.roundBtn, main && styles.roundBtnMain]}>
                      <Ionicons name={icon} size={20} color={main ? COLORS.onGold : COLORS.primary} />
                    </View>
                    <Text style={styles.roundLabel}>{label}</Text>
                  </PressableScale>
                ))}
              </View>
              <PressableScale onPress={() => handleDelete(id)} haptic="light" style={styles.deleteLink} accessibilityRole="button">
                <Ionicons name="trash-outline" size={15} color={COLORS.dangerText} />
                <Text style={styles.deleteText}>Delete card</Text>
              </PressableScale>
            </Card>
          );
        })
      )}

      {/* Top-up Modal */}
      <Modal visible={Boolean(topupCardId)} transparent animationType="slide" onRequestClose={() => setTopupCardId(null)}>
        <KeyboardSafe style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Top Up Card</Text>
            <Input
              label="Amount (USD)"
              placeholder="e.g. 20"
              value={topupAmount}
              onChangeText={setTopupAmount}
              keyboardType="decimal-pad"
            />
            <Button title="Quote & approve top-up" onPress={handleTopup} />
            <Button title="Cancel" variant="ghost" onPress={() => setTopupCardId(null)} style={{ marginTop: 8 }} />
          </View>
        </KeyboardSafe>
      </Modal>

      {/* Revealed Card Details Modal */}
      <Modal visible={Boolean(revealed)} transparent animationType="fade" onRequestClose={() => setRevealed(null)}>
        <KeyboardSafe style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Sensitive Card Details</Text>
            {revealed ? (
              <>
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
              </>
            ) : null}
            <Button title="Hide details" onPress={() => setRevealed(null)} style={{ marginTop: 14 }} />
          </View>
        </KeyboardSafe>
      </Modal>

      {/* Card Transactions Modal */}
      <Modal visible={cardTxs !== null} transparent animationType="slide" onRequestClose={() => setCardTxs(null)}>
        <KeyboardSafe style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Card Activity</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {cardTxs && cardTxs.length > 0 ? (
                cardTxs.map((t, i) => (
                  <KeyValueRow
                    key={i}
                    currency={String(t.currency || "USD")}
                    label={String(t.merchant || t.description || t.type || `Tx #${i + 1}`)}
                    value={`${t.amount ?? ""} ${t.currency || "USD"}`}
                  />
                ))
              ) : (
                <EmptyState icon="receipt-outline" title="No card transactions yet" />
              )}
            </ScrollView>
            <Button title="Close" variant="ghost" onPress={() => setCardTxs(null)} style={{ marginTop: 10 }} />
          </View>
        </KeyboardSafe>
      </Modal>
    </ScrollView>
  );
}

const styles = createThemeStyles(() => ({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 32 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  cardVisual: {
    gap: 4,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    marginBottom: 12,
  },
  cardTitle: { color: COLORS.text, fontSize: 17, fontFamily: FONTS.bold, marginTop: 2 },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  cardLabel: { color: COLORS.textMuted, fontFamily: FONTS.regular, fontSize: 11 },
  roundRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  roundItem: { alignItems: "center", gap: 6, flex: 1 },
  roundBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  roundBtnMain: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  roundLabel: { fontFamily: FONTS.semibold, fontSize: 11.5, color: COLORS.text },
  deleteLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14, minHeight: 40 },
  deleteText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.dangerText },
  cardBal: { color: COLORS.text, fontSize: 16, fontFamily: FONTS.bold, marginTop: 2 },
  actionsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0, 20, 15, 0.72)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1,
    borderColor: COLORS.borderStrong,
    padding: SPACING.lg,
  },
  modalTitle: { color: COLORS.text, fontSize: 18, fontFamily: FONTS.bold, marginBottom: 14 },
}));
