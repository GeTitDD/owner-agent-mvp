import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { getOverview, health } from './src/api';
import type { ServerConfig } from './src/api';
import { clearConfig, loadConfig, saveConfig } from './src/storage';
import type { Overview, Project } from './src/types';
import PairScreen from './src/screens/PairScreen';
import ProjectsScreen from './src/screens/ProjectsScreen';
import ProjectScreen from './src/screens/ProjectScreen';
import ChatScreen from './src/screens/ChatScreen';
import { colors } from './src/theme';

export default function App() {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [chatPrefill, setChatPrefill] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [bootError, setBootError] = useState('');

  const refresh = useCallback(async (target?: Project | null) => {
    if (!config) return;
    setLoading(true);
    try {
      const next = await getOverview(config, (target ?? project)?.id ?? '');
      setOverview(next);
      if (next.project) setProject(next.project);
      setBootError('');
    } catch (error) {
      const message = String((error as Error).message ?? error);
      setBootError(message);
      if (/401|Unauthorized/u.test(message)) {
        await clearConfig();
        setConfig(null);
        setOverview(null);
        setProject(null);
      }
    } finally {
      setLoading(false);
    }
  }, [config, project]);

  useEffect(() => {
    (async () => {
      const saved = await loadConfig();
      if (!saved) {
        setReady(true);
        return;
      }
      try {
        await health(saved.baseUrl);
        setConfig(saved);
      } catch {
        await clearConfig();
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!config) return;
    void refresh();
    // 只在连接建立时拉一次；之后由下拉刷新/返回触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <StatusBar style="dark" />
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  if (!config) {
    return (
      <>
        <StatusBar style="dark" />
        <PairScreen
          onPaired={async (paired) => {
            await saveConfig(paired);
            setConfig(paired);
            setProject(null);
            setOverview(null);
          }}
        />
      </>
    );
  }

  if (chatOpen && project) {
    return (
      <>
        <StatusBar style="dark" />
        <ChatScreen
          config={config}
          project={project}
          prefill={chatPrefill}
          onBack={() => {
            setChatOpen(false);
            setChatPrefill('');
            void refresh();
          }}
        />
      </>
    );
  }

  if (project) {
    return (
      <>
        <StatusBar style="dark" />
        <ProjectScreen
          config={config}
          overview={overview ?? {
            version: '', generatedAt: '', projects: [], activeProjectId: project.id,
            project, brief: null, nextAction: null, knowledge: {}, ideas: [], diagrams: []
          }}
          onBack={() => {
            setProject(null);
            void refresh();
          }}
          onRefresh={() => refresh()}
          onChat={(prefill = '') => {
            setChatPrefill(prefill);
            setChatOpen(true);
          }}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <ProjectsScreen
        overview={overview}
        loading={loading}
        onRefresh={() => void refresh()}
        onOpen={(next) => {
          setProject(next);
          void refresh(next);
        }}
        onDisconnect={() => {
          Alert.alert('断开连接？', '会清除手机上的设备令牌，下次需要重新配对。', [
            { text: '取消', style: 'cancel' },
            {
              text: '断开',
              style: 'destructive',
              onPress: async () => {
                await clearConfig();
                setConfig(null);
                setOverview(null);
                setProject(null);
              }
            }
          ]);
        }}
      />
      {bootError ? <Text style={styles.error}>{bootError}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  error: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    fontSize: 11,
    color: colors.danger
  }
});
