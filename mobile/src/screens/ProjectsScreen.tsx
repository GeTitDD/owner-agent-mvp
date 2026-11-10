import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { Overview, Project } from '../types';
import { colors, radius, spacing } from '../theme';

interface Props {
  overview: Overview | null;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (project: Project) => void;
  onDisconnect: () => void;
}

export default function ProjectsScreen({ overview, loading, onRefresh, onOpen, onDisconnect }: Props) {
  const projects = overview?.projects ?? [];

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>项目</Text>
          <Text style={styles.subtitle}>
            {overview?.generatedAt ? `同步于 ${new Date(overview.generatedAt).toLocaleTimeString()}` : '正在同步…'}
          </Text>
        </View>
        <Pressable onPress={onDisconnect} hitSlop={8}>
          <Text style={styles.link}>断开</Text>
        </Pressable>
      </View>

      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有项目</Text>
            <Text style={styles.emptyText}>先在电脑端登记一个项目，再下拉刷新。</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onOpen(item)}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>{item.root ?? item.domain ?? ''}</Text>
            </View>
            <Text style={styles.rowArrow}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: 64,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end'
  },
  title: { fontSize: 26, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
  link: { fontSize: 13, color: colors.text2 },
  list: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14
  },
  rowPressed: { opacity: 0.85 },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  rowMeta: { fontSize: 11, color: colors.muted },
  rowArrow: { fontSize: 24, color: colors.muted, marginTop: -2 },
  empty: { alignItems: 'center', paddingTop: 60, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.text2 },
  emptyText: { fontSize: 13, color: colors.muted }
});
