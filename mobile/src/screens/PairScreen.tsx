import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View
} from 'react-native';
import { pair } from '../api';
import type { ServerConfig } from '../api';
import { colors, radius, spacing } from '../theme';

interface Props {
  onPaired: (config: ServerConfig) => void;
}

export default function PairScreen({ onPaired }: Props) {
  const [baseUrl, setBaseUrl] = useState('http://192.168.1.10:47831');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('iPhone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!baseUrl.trim() || !code.trim()) {
      setError('填好地址和 6 位配对码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await pair(baseUrl, code.trim(), deviceName.trim() || 'iPhone');
      onPaired({ baseUrl: baseUrl.trim(), token: result.token });
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Owner Companion</Text>
        <Text style={styles.lead}>连接电脑上的 Owner Companion，手机只用来查看项目和讨论想法。</Text>

        <View style={styles.card}>
          <Text style={styles.label}>电脑地址</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="http://192.168.x.x:47831"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />

          <Text style={styles.label}>配对码</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="6 位数字"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            maxLength={6}
            style={[styles.input, styles.codeInput]}
          />

          <Text style={styles.label}>设备名</Text>
          <TextInput
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="iPhone"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={() => void submit()}
            disabled={busy}
          >
            {busy ? <ActivityIndicator color={colors.accentFg} /> : <Text style={styles.buttonText}>连接</Text>}
          </Pressable>
        </View>

        <View style={styles.hint}>
          <Text style={styles.hintTitle}>怎么找地址和配对码</Text>
          <Text style={styles.hintText}>1. 电脑和手机连同一个 Wi-Fi</Text>
          <Text style={styles.hintText}>2. 电脑端打开「设置 → 手机连接」</Text>
          <Text style={styles.hintText}>3. 填写上面的地址和 6 位配对码</Text>
          <Text style={styles.hintText}>配对码 10 分钟内有效，用一次就作废。</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingTop: 72, gap: spacing.md },
  brand: { fontSize: 28, fontWeight: '700', color: colors.text },
  lead: { fontSize: 14, lineHeight: 21, color: colors.text2, marginBottom: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line
  },
  label: { fontSize: 12, color: colors.muted, marginTop: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surfaceAlt
  },
  codeInput: { fontSize: 22, letterSpacing: 6, fontWeight: '600' },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: 13,
    alignItems: 'center'
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: colors.accentFg, fontSize: 15, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 12 },
  hint: { gap: 4, paddingHorizontal: spacing.xs },
  hintTitle: { fontSize: 13, fontWeight: '600', color: colors.text2 },
  hintText: { fontSize: 12, lineHeight: 18, color: colors.muted }
});
