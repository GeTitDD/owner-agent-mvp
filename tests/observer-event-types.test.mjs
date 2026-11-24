import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  EVENT_TYPE_NAMES,
  countEventTypes,
  emptyEventCounts,
  eventTypeLabel,
  formatEventCounts,
  formatEventMessage
} from '../src/observer/event-types.mjs';
import { eventSeverity } from '../src/observer/digest.mjs';
import { buildBoardViewModel } from '../src/observer/board.mjs';
import { formatDriftMessage, formatEventMessage as formatFromFeishu } from '../src/observer/feishu.mjs';

const event = (overrides = {}) => ({
  type: 'stale',
  projectId: 'p1',
  projectName: 'P1',
  branch: 'main',
  branchLabel: 'main',
  head: 'a'.repeat(40),
  daysStale: 4,
  behindTrunk: 12,
  trunkRef: 'main',
  uncommittedFiles: 25,
  detectedAt: '2026-11-24T01:00:00.000Z',
  ...overrides
});

// 新增第四类事件应只需改 event-types.mjs；这里锁住「所有消费者都从注册表取」。
test('事件类型注册表是标签、计数、消息与严重度的唯一来源', () => {
  assert.deepEqual(EVENT_TYPE_NAMES, ['stale', 'drift', 'backlog']);
  assert.deepEqual(EVENT_TYPE_LIST.map((spec) => spec.label), ['停滞', '漂移', '积压']);

  for (const spec of EVENT_TYPE_LIST) {
    const sample = event({ type: spec.type });
    assert.equal(eventTypeLabel(spec.type), spec.label);
    assert.equal(EVENT_TYPES[spec.type].messageTitle, spec.label);
    assert.match(formatEventMessage(sample), new RegExp(`^【${spec.label}】`));
    assert.equal(formatFromFeishu(sample), formatEventMessage(sample));
    const severity = eventSeverity(sample);
    assert.equal(severity.label, spec.label);
    assert.equal(severity.typeRank, spec.order);
  }

  assert.equal(formatDriftMessage(event({ type: 'drift' })),
    '【漂移】P1 落后主干 12 个提交\n项目：P1（p1）\n分支：main → 主干：main\n当前提交：' + 'a'.repeat(40));

  assert.deepEqual(emptyEventCounts(), { stale: 0, drift: 0, backlog: 0 });
  const counts = countEventTypes([event(), event({ type: 'drift' }), event({ type: 'drift' })]);
  assert.deepEqual(counts, { stale: 1, drift: 2, backlog: 0 });
  assert.equal(formatEventCounts(counts), '停滞 1 · 漂移 2 · 积压 0');
});

test('观察台徽章从同一注册表取标签与单位', () => {
  const view = buildBoardViewModel({
    projects: [
      { id: 'p1', name: 'P1' },
      { id: 'p2', name: 'P2' },
      { id: 'p3', name: 'P3' }
    ],
    events: [
      event({ id: 'e1', projectId: 'p1', type: 'stale', daysStale: 4 }),
      event({ id: 'e2', projectId: 'p2', type: 'drift', behindTrunk: 12 }),
      event({ id: 'e3', projectId: 'p3', type: 'backlog', uncommittedFiles: 25 })
    ]
  });

  const byId = Object.fromEntries(view.projects.map((project) => [project.id, project]));
  assert.equal(byId.p1.risk.badge, '停滞 4 天');
  assert.equal(byId.p2.risk.badge, '漂移 12 提交');
  assert.equal(byId.p3.risk.badge, '积压 25 文件');
  assert.deepEqual(view.projects.map((project) => project.risk.level), ['stale', 'drift', 'backlog']);
});
