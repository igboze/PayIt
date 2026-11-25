import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { AssistantResponse } from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, RADIUS, SPACING, FONTS } from "../theme";
import { Button, Card, ErrorBanner, Input, ScreenHeader, SuccessBanner } from "../components/UI";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  suggestedAction?: AssistantResponse["suggestedAction"];
}

export function AssistantScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, requestApproval } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    setNotice(null);
    setInput("");
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
    setLoading(true);
    try {
      const res = await api.assistantChat(text, activeAccount);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: res.reply,
          suggestedAction: res.suggestedAction,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assistant could not respond right now.");
    } finally {
      setLoading(false);
    }
  };

  const handleApproveSuggested = async (action: NonNullable<AssistantResponse["suggestedAction"]>) => {
    setError(null);
    try {
      const res = await requestApproval(action.type, action.payload);
      setNotice(res.notice || "Action completed!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Approval failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      enabled={false}
    >
      <ScreenHeader
        title="Proxim Assistant"
        subtitle={`Context: ${activeAccount === "business" ? "Business" : "Personal"} · Never moves money without Passkey`}
        onBack={onBack}
      />

      <ScrollView contentContainerStyle={styles.chat}>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {messages.length === 0 ? (
          <Card>
            <Text style={styles.hintTitle}>Try asking:</Text>
            <Text style={styles.hintItem}>• "What is my balance?"</Text>
            <Text style={styles.hintItem}>• "Show my recent transactions"</Text>
            <Text style={styles.hintItem}>• "Send $15 to @username"</Text>
            <Text style={styles.hintItem}>• "Deposit $50 into savings"</Text>
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
              <Button
                title="Review & Approve with Passkey"
                onPress={() => handleApproveSuggested(m.suggestedAction!)}
                style={{ marginTop: 10, height: 42 }}
              />
            ) : null}
          </View>
        ))}
      </ScrollView>

      <View style={styles.composer}>
        <View style={{ flex: 1 }}>
          <Input
            placeholder="Ask Proxim anything…"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={handleSend}
            returnKeyType="send"
            style={{ marginBottom: 0 }}
          />
        </View>
        <Button title="Send" onPress={handleSend} loading={loading} style={{ width: 76, marginBottom: 14 }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  chat: { padding: SPACING.md, paddingBottom: 24, flexGrow: 1 },
  hintTitle: { color: COLORS.text, fontSize: 14, fontFamily: FONTS.bold, marginBottom: 8 },
  hintItem: { color: COLORS.textSecondary, fontFamily: FONTS.regular, fontSize: 13, lineHeight: 22 },
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
});
