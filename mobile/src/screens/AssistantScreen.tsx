import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { AssistantResponse } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING, FONTS, createThemeStyles } from "../theme";
import { Button, Card, ErrorBanner, Input, Pill, ScreenHeader, SuccessBanner } from "../components/UI";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  suggestedAction?: AssistantResponse["suggestedAction"];
}

const STARTER_PROMPTS = [
  "What is my balance?",
  "Why did my last transaction fail?",
  "Check my KYC / KYB status",
  "How do Proxim fees work?",
  "How do I upload KYC documents?",
];

export function AssistantScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, requestApproval } = useApp();
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sendText = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || loading) return;
    setError(null);
    setNotice(null);
    setInput("");
    const history = messages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    try {
      const res = await api.assistantChat(text, activeAccount, history);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: res.reply || "I'm ready to help with your Proxim account.",
          suggestedAction: res.suggestedAction,
        },
      ]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assistant could not respond right now.");
    } finally {
      setLoading(false);
    }
  };

  const handleApproveSuggested = async (action: NonNullable<AssistantResponse["suggestedAction"]>) => {
    setError(null);
    try {
      // Strictly bind payload to the user's current active account before Passkey + PIN confirmation
      const scopedPayload = { ...(action.payload || {}), accountType: activeAccount };
      const res = await requestApproval(action.type, scopedPayload);
      setNotice(res.notice || "Action completed!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Approval failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
    >
      <ScreenHeader
        title="Proxim Assistant"
        subtitle={`${activeAccount === "business" ? "Business" : "Personal"} Workspace · Passkey required to move funds`}
        onBack={onBack}
      />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.chat}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {messages.length === 0 ? (
          <Card>
            <Text style={styles.hintTitle}>How can I help with your Proxim account?</Text>
            <Text style={styles.hintSub}>
              Ask about balances, fees, KYC/KYB verification, troubleshooting any error, or preparing a payment for your Passkey approval.
            </Text>
            <View style={styles.chipsWrap}>
              {STARTER_PROMPTS.map((q) => (
                <Pill key={q} label={q} onPress={() => sendText(q)} />
              ))}
            </View>
          </Card>
        ) : null}

        {messages.map((m) => (
          <View
            key={m.id}
            style={[
              styles.bubble,
              m.role === "user" ? styles.userBubble : styles.botBubble,
            ]}
          >
            <Text style={styles.bubbleText}>{m.text}</Text>
            {m.suggestedAction ? (
              <View style={styles.actionBox}>
                <Text style={styles.actionScope}>
                  Account: {activeAccount === "business" ? "Your Business Account" : "Your Personal Account"} · Passkey + PIN required
                </Text>
                <Button
                  title="Review & Approve with Passkey"
                  onPress={() => handleApproveSuggested(m.suggestedAction!)}
                  style={{ marginTop: 8, height: 42 }}
                />
              </View>
            ) : null}
          </View>
        ))}

        {loading ? (
          <View style={[styles.bubble, styles.botBubble]}>
            <Text style={[styles.bubbleText, { color: COLORS.textSecondary }]}>Thinking…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.composer}>
        <View style={{ flex: 1 }}>
          <Input
            placeholder="Ask Proxim anything or paste an error…"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => sendText(input)}
            returnKeyType="send"
            style={{ marginBottom: 0 }}
          />
        </View>
        <Button title="Send" onPress={() => sendText(input)} loading={loading} style={{ width: 76, height: 50, marginBottom: 14 }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = createThemeStyles(() => ({
  root: { flex: 1, backgroundColor: COLORS.bg },
  chat: { padding: SPACING.md, paddingBottom: 24, flexGrow: 1 },
  hintTitle: { color: COLORS.text, fontSize: 15, fontFamily: FONTS.bold, marginBottom: 6 },
  hintSub: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bubble: {
    borderRadius: RADIUS.lg,
    padding: 13,
    marginBottom: 10,
    maxWidth: "88%",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.primaryBorder,
  },
  botBubble: {
    alignSelf: "flex-start",
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bubbleText: { color: COLORS.text, fontFamily: FONTS.regular, fontSize: 14, lineHeight: 20 },
  actionBox: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  actionScope: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.semibold,
    fontSize: 11.5,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: SPACING.md,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
}));
