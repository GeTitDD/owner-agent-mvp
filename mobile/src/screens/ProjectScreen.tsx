import { useState } from 'react';
import {
  Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View
} from 'react-native';
import { addIdea, removeIdea, setIdeaStatus } from '../api';
import type { ServerConfig } from '../api';
import type { Idea, Overview } from '../types';
import { colors, radius, spacing } from '../theme';

const STATUS_LABEL: Record<string, string> = {
  todo: '新想法',
  doing: '讨论中',
  blocked: '搁置',
  done: '已采纳',
  failed: '失败'
};

const STATUS_COLOR: Record<string, string> = {
  todo: colors.text2,
  doing: '#3b82f6',
  blocked: colors.warn,
  done: colors.ok,
  failed: colors.danger
};

const DIAGRAM_LABEL: Record<string, string> = {
  dependency: '依赖图',
  control: '控制流',
  dataflow: '数据流',
  state: '状态图',
  sequence: '时序图'
};

interface Props {
  config: ServerConfig;
  overview: Overview;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onChat: (prefill?: string) => void;
}

export default function ProjectScreen({ config, overview, onBack, onRefresh, onChat }: Props) {
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState('');
  const project = overview.project;

  const mutate = async (idea: Idea, action: 'doing' | 'done' | 'blocked' | 'todo' | 'delete') => {
    setBusyId(idea.id);
    try {
      if (action === 'delete') await removeIdea(config, idea.id);
      else await setIdeaStatus(config, idea.id, action);
      await onRefresh();
    } catch (error) {
      Alert.alert('操作失败', String((error as Error).message ?? error));
    } finally {
      setBusyId('');
    }
  };

  const submitIdea = async () => {
    const title = draft.trim();
    if (!title || !project) return;
    setBusyId('new');
    try {
      await addIdea(config, project.id, title);
      setDraft('');
      await onRefresh();
    } catch (error) {
      Alert.alert('保存失败', String((error as Error).message ?? error));
    } finally {
      setBusyId('');
    }
  };

  const brief = overview.brief;
  const knowledge = overview.knowledge ?? {};

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ 项目</Text>
        </Pressable>
        <Pressable onPress={() => void onRefresh()} hitSlop={10}>
          <Text style={styles.refresh}>刷新</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.projectName}>{project?.name ?? '项目'}</Text>
        <Text style={styles.projectRoot} numberOfLines={1}>{project?.root ?? ''}</Text>

        {overview.nextAction ? (
          <View style={styles.actionCard}>
            <Text style={styles.actionLabel}>下一步</Text>
            <Text style={styles.actionTitle}>
              {overview.nextAction.title || overview.nextAction.label || ''}
            </Text>
            {overview.nextAction.detail ? (
              <Text style={styles.actionDetail}>{overview.nextAction.detail}</Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>项目画像</Text>
          {brief ? (
            <>
              {brief.stale ? <Text style={styles.stale}>代码已更新，画像可能过期</Text> : null}
              <Text style={styles.summary}>{brief.oneLiner || brief.whatItIs || '暂无摘要'}</Text>
              {brief.howToRun?.length ? (
                <>
                  <Text style={styles.sectionLabel}>怎么跑</Text>
                  {brief.howToRun.slice(0, 5).map((line, index) => (
                    <Text key={`run-${index}`} style={styles.line}>· {String(line).slice(0, 160)}</Text>
                  ))}
                </>
              ) : null}
              {brief.risks?.length ? (
                <>
                  <Text style={styles.sectionLabel}>风险</Text>
                  {brief.risks.slice(0, 3).map((line, index) => (
                    <Text key={`risk-${index}`} style={styles.line}>· {line}</Text>
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <Text style={styles.muted}>电脑端还没有生成画像。在桌面点一次「理解项目」即可。</Text>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>想法 {overview.ideas.length ? `· ${overview.ideas.length}` : ''}</Text>
          </View>
          <View style={styles.addRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="记一条改进想法…"
              placeholderTextColor={colors.muted}
              style={styles.addInput}
              onSubmitEditing={() => void submitIdea()}
              returnKeyType="done"
            />
            <Pressable
              style={({ pressed }) => [styles.addButton, pressed && { opacity: 0.85 }]}
              onPress={() => void submitIdea()}
              disabled={busyId === 'new'}
            >
              <Text style={styles.addButtonText}>记下</Text>
            </Pressable>
          </View>

          {overview.ideas.length === 0 ? (
            <Text style={styles.muted}>还没有想法。和 Agent 讨论时提到的改进会自动进这里。</Text>
          ) : overview.ideas.map((idea) => (
            <View key={idea.id} style={styles.idea}>
              <View style={styles.ideaHead}>
                <Text style={styles.ideaTitle}>{idea.title}</Text>
                <Text style={[styles.status, { color: STATUS_COLOR[idea.status] ?? colors.text2 }]}>
                  {STATUS_LABEL[idea.status] ?? idea.status}
                </Text>
              </View>
              <Text style={styles.ideaMeta}>{idea.source === 'conversation' ? '对话' : idea.source === 'mobile' ? '手机' : '手动'}</Text>
              <View style={styles.ideaActions}>
                <Pressable onPress={() => onChat(`讨论这条改进想法（只讨论，不要改代码）：${idea.title}`)}>
                  <Text style={styles.actionPrimary}>讨论</Text>
                </Pressable>
                {idea.status !== 'done' ? (
                  <Pressable onPress={() => void mutate(idea, 'done')} disabled={busyId === idea.id}>
                    <Text style={styles.action}>采纳</Text>
                  </Pressable>
                ) : null}
                {idea.status === 'todo' || idea.status === 'doing' ? (
                  <Pressable onPress={() => void mutate(idea, 'blocked')} disabled={busyId === idea.id}>
                    <Text style={styles.action}>搁置</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={() => void mutate(idea, 'todo')} disabled={busyId === idea.id}>
                    <Text style={styles.action}>重开</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => void mutate(idea, 'delete')} disabled={busyId === idea.id}>
                  <Text style={styles.actionDanger}>删除</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>知识</Text>
          <Text style={styles.summary}>
            经验 {knowledge.experiences ?? 0} · 知识 {knowledge.knowledge ?? 0}（已验证 {knowledge.verified ?? 0}）
          </Text>
          <Text style={styles.muted}>
            待提炼 {knowledge.pendingHarvest ?? 0} · 候选 {knowledge.candidates ?? 0} · 复用 {knowledge.usages ?? 0}
          </Text>
        </View>

        {overview.diagrams.length ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>项目图谱</Text>
            <View style={styles.chips}>
              {overview.diagrams.map((diagram) => (
                <View key={`${diagram.kind}-${diagram.version}`} style={styles.chip}>
                  <Text style={styles.chipText}>
                    {DIAGRAM_LABEL[diagram.kind] ?? diagram.kind} · v{diagram.version}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.chatBar, pressed && { opacity: 0.9 }]}
        onPress={() => onChat()}
      >
        <Text style={styles.chatBarText}>和 Agent 聊聊这个项目</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: 60,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  back: { fontSize: 15, color: colors.text2 },
  refresh: { fontSize: 13, color: colors.muted },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 110 },
  projectName: { fontSize: 24, fontWeight: '700', color: colors.text },
  projectRoot: { fontSize: 11, color: colors.muted, marginTop: 2 },
  actionCard: {
    backgroundColor: '#1f1f1f',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 6
  },
  actionLabel: { fontSize: 11, color: '#bdbdbd' },
  actionTitle: { fontSize: 16, fontWeight: '600', color: '#ffffff', lineHeight: 22 },
  actionDetail: { fontSize: 12, color: '#d4d4d4', lineHeight: 18 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.text2 },
  summary: { fontSize: 14, lineHeight: 21, color: colors.text },
  sectionLabel: { fontSize: 11, color: colors.muted, marginTop: 4 },
  line: { fontSize: 12, lineHeight: 18, color: colors.text2 },
  muted: { fontSize: 12, lineHeight: 18, color: colors.muted },
  stale: { fontSize: 11, color: colors.warn },
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surfaceAlt
  },
  addButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  addButtonText: { color: colors.accentFg, fontSize: 13, fontWeight: '600' },
  idea: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 10,
    marginTop: 2,
    gap: 4
  },
  ideaHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  ideaTitle: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.text },
  status: { fontSize: 11, fontWeight: '600' },
  ideaMeta: { fontSize: 10, color: colors.muted },
  ideaActions: { flexDirection: 'row', gap: 14, marginTop: 4 },
  actionPrimary: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  action: { fontSize: 12, color: colors.text2 },
  actionDanger: { fontSize: 12, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { backgroundColor: colors.chip, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  chipText: { fontSize: 11, color: colors.text2 },
  chatBar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 26,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: 'center'
  },
  chatBarText: { color: colors.accentFg, fontSize: 14, fontWeight: '600' }
});
