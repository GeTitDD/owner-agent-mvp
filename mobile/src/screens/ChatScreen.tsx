import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View
} from 'react-native';
import { sendChat } from '../api';
import type { ServerConfig } from '../api';
import type { Project } from '../types';
import { colors, radius, spacing } from '../theme';

interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  meta?: string;
}

interface Props {
  config: ServerConfig;
  project: Project;
  prefill?: string;
  onBack: () => void;
}

export default function ChatScreen({ config, project, prefill = '', onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(prefill);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!busy) return undefined;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    const userMessage: Message = { id: `u-${Date.now()}`, role: 'user', text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setBusy(true);
    try {
      const result = await sendChat(config, project.id, text);
      const answer = result.summary || result.advice || '（没有返回内容）';
      const extra = result.mode === 'write-request'
        ? '写请求已创建，需要回电脑上批准后才会执行。'
        : result.mode === 'triage-error'
          ? '分析没有完成，可以重试。'
          : '';
      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'agent',
        text: extra ? `${answer}\n\n${extra}` : answer,
        meta: result.mode
      }]);
    } catch (error) {
      setMessages((prev) => [...prev, {
        id: `e-${Date.now()}`,
        role: 'agent',
        text: `失败：${String((error as Error).message ?? error)}`,
        meta: 'error'
      }]);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
    }
  }, [prefill]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={8}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{project.name}</Text>
        <View style={styles.headerSpace} />
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>和 Agent 聊聊这个项目</Text>
            <Text style={styles.emptyText}>可以问进度、问风险，也可以说说你的改进想法。</Text>
            <Text style={styles.emptyHint}>想法只收集，不会直接改代码；写操作需要回电脑批准。</Text>
          </View>
        ) : messages.map((message) => (
          <View
            key={message.id}
            style={[styles.bubble, message.role === 'user' ? styles.userBubble : styles.agentBubble]}
          >
            <Text style={message.role === 'user' ? styles.userText : styles.agentText}>
              {message.text}
            </Text>
          </View>
        ))}
        {busy ? (
          <View style={[styles.bubble, styles.agentBubble]}>
            <Text style={styles.agentText}>分析中… {elapsed}s</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="问进度，或说说改进想法…"
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
          maxLength={1200}
        />
        <Pressable
          style={({ pressed }) => [styles.send, (busy || !input.trim()) && styles.sendDisabled, pressed && { opacity: 0.85 }]}
          onPress={() => void send()}
          disabled={busy || !input.trim()}
        >
          <Text style={styles.sendText}>发送</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: 58,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface
  },
  back: { fontSize: 14, color: colors.text2 },
  title: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600', color: colors.text },
  headerSpace: { width: 44 },
  messages: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
  empty: { paddingTop: 40, gap: 6, paddingHorizontal: spacing.sm },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  emptyText: { fontSize: 13, lineHeight: 19, color: colors.text2 },
  emptyHint: { fontSize: 12, lineHeight: 18, color: colors.muted, marginTop: 6 },
  bubble: {
    maxWidth: '86%',
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  agentBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line
  },
  userText: { color: colors.accentFg, fontSize: 14, lineHeight: 20 },
  agentText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    padding: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? 26 : spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surfaceAlt
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 11
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.accentFg, fontSize: 14, fontWeight: '600' }
});
