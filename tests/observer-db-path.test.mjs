import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { desktopUserDataDir, resolveObserverDbPath } from '../src/observer/db-path.mjs';

const HOME = path.join('C:', 'Users', 'observer');

test('审计库路径优先级：OWNER_OBSERVER_DB > OWNER_AGENT_DB > 桌面 owner.sqlite > 默认值', () => {
  const desktop = path.join(HOME, 'AppData', 'Roaming', 'owner-agent-mvp', 'owner.sqlite');

  assert.equal(resolveObserverDbPath({
    env: { OWNER_OBSERVER_DB: 'observer.sqlite', OWNER_AGENT_DB: 'owner.sqlite' },
    platform: 'win32',
    homeDir: HOME,
    exists: () => true,
    fallback: 'fallback.sqlite'
  }), 'observer.sqlite');

  assert.equal(resolveObserverDbPath({
    env: { OWNER_AGENT_DB: 'owner.sqlite' },
    platform: 'win32',
    homeDir: HOME,
    exists: () => true,
    fallback: 'fallback.sqlite'
  }), 'owner.sqlite');

  // 桌面库存在时才用：独立性启动要读到 Electron 写的项目登记。
  assert.equal(resolveObserverDbPath({
    env: {},
    platform: 'win32',
    homeDir: HOME,
    exists: (candidate) => candidate === desktop,
    fallback: 'fallback.sqlite'
  }), desktop);

  // 桌面库不存在：退回现有默认，而不是凭空造一个空库。
  assert.equal(resolveObserverDbPath({
    env: {},
    platform: 'win32',
    homeDir: HOME,
    exists: () => false,
    fallback: 'fallback.sqlite'
  }), 'fallback.sqlite');
});

test('空白环境变量视为未配置；跨平台 userData 目录与桌面端一致', () => {
  assert.equal(resolveObserverDbPath({
    env: { OWNER_OBSERVER_DB: '   ', OWNER_AGENT_DB: '' },
    platform: 'win32',
    homeDir: HOME,
    exists: () => false,
    fallback: 'fallback.sqlite'
  }), 'fallback.sqlite');

  assert.equal(desktopUserDataDir({ env: { APPDATA: path.join('D:', 'Roaming') }, platform: 'win32', homeDir: HOME }),
    path.join('D:', 'Roaming', 'owner-agent-mvp'));
  assert.equal(desktopUserDataDir({
    env: { XDG_CONFIG_HOME: path.join(HOME, '.config') }, platform: 'linux', homeDir: HOME
  }), path.join(HOME, '.config', 'owner-agent-mvp'));
  assert.equal(desktopUserDataDir({ env: {}, platform: 'darwin', homeDir: HOME }),
    path.join(HOME, 'Library', 'Application Support', 'owner-agent-mvp'));
});
