// 复现与作用域升级：同一现象出现在第二个项目时，经验被打「已复现」标记并累加支持项目数；
// 系统只打标记，不因此把经验升为已验证。升域是显式操作，升级后仍能查到来源项目。
// 这里用真实 OwnerStore + fixture 造两个项目的执行记录，提炼器一律用假的，不联网、不调真实模型。
// 只断言外部行为：给 owner store 造了什么、提炼器返回什么，库里就应该剩下什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import { LessonDistiller } from '../src/knowledge-loop/lesson.mjs';
import { normalizeLesson } from '../src/knowledge-loop/contracts.mjs';
import { createSyntheticProject } from '../scripts/knowledge-loop/fixtures.mjs';

/** 同一条现象，措辞在两个项目里刻意写得不一样（大小写、空白、句末标点）。 */
const phenomenonFor = (projectId) => (projectId === 'proj-b'
  ? '  RETRY loop   leaves the last attempt unused. '
  : 'retry loop leaves the last attempt unused');

/** 假提炼器：现象跨项目相同，证据只引用本次执行记录自身，保证一定能追回。 */
const extractor = ({ record }) => ({
  phenomenon: phenomenonFor(record.projectId),
  mechanism: 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行',
  countermeasure: '改成 i < attempts，并用同一条断言复跑测试确认次数',
  evidenceRefs: [record.id]
});

/** 一个临时目录 + 真实 owner store + 真实个人知识库。 */
const makeStores = (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-reproduce-'));
  const owner = new OwnerStore(path.join(tmp, 'owner.sqlite'));
  const personal = new PersonalKnowledgeStore(path.join(tmp, 'knowledge.sqlite'));
  t.after(() => {
    personal.close();
    owner.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, owner, personal };
};

const distillProject = (distiller, projectId) => distiller.distill({ projectId });

test('第二个项目复现同一现象：两个项目各一条经验，两条都标记已复现，但不升为已验证', async (t) => {
  const { tmp, owner, personal } = makeStores(t);
  // 两个独立项目，各自带一条失败运行与一条修复运行（fixture 会建真 git 仓库）。
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-a'), projectId: 'proj-a', name: 'A' });
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-b'), projectId: 'proj-b', name: 'B' });
  const distiller = new LessonDistiller({ ownerStore: owner, personalStore: personal, extractor });

  // 第一次提炼只在 proj-a 出现：单项目，不打复现标记。
  const first = await distillProject(distiller, 'proj-a');
  assert.equal(new Set(first.lessons.map((lesson) => lesson.id)).size, 1);
  const lessonA = first.lessons[0].id;
  const single = personal.getLesson(lessonA);
  assert.equal(single.reproduced, false, '只在一个项目出现时不标记已复现');
  assert.equal(single.supportProjects, 1);

  // 第二个项目出现同一现象：写它自己的项目级经验（P0-1），不并进 proj-a 那条。
  const second = await distillProject(distiller, 'proj-b');
  assert.equal(second.lessons.length, 2);
  assert.equal(new Set(second.lessons.map((lesson) => lesson.id)).size, 1, '同一项目的两条记录合成一条经验');
  const lessonB = second.lessons[0].id;
  assert.notEqual(lessonB, lessonA, '第二个项目要有自己的经验行');

  const lessons = personal.listLessons();
  assert.equal(lessons.length, 2, '同一现象在两个项目各自成行');
  assert.equal(personal.listLessons({ projectId: 'proj-a' }).length, 1);
  assert.equal(personal.listLessons({ projectId: 'proj-b' }).length, 1, '第二个项目按项目过滤要能查到自己那条');

  // 复现只作为属性：两条都打已复现，来源台账都列两个项目。
  for (const id of [lessonA, lessonB]) {
    const merged = personal.getLesson(id);
    assert.equal(merged.reproduced, true, '第二个项目复现后两条都要打已复现标记');
    assert.equal(merged.supportProjects, 2, '支持项目数为 2');
    assert.deepEqual([...merged.supportedByProjects].sort(), ['proj-a', 'proj-b']);
    assert.deepEqual(merged.sources.map((source) => source.projectId).sort(), ['proj-a', 'proj-b']);
    const sources = personal.lessonSources(id);
    assert.deepEqual(sources.projects.sort(), ['proj-a', 'proj-b'], '任一项目都能查回整组来源');
    assert.equal(sources.projectCount, 2);
    // 证据不跨项目复制：每行只带自己项目的两条终态运行。
    assert.equal(personal.lessonSupport(id).records, 2);
    // 系统只在复现时打标记，不自动升为已验证、不自动升域。
    assert.notEqual(merged.verificationStatus, 'verified');
    assert.equal(merged.scope.layer, 'project', '复现本身不改变作用域层');
  }

  // 两个项目的记录都已并入各自经验，不留在待提炼队列。
  assert.deepEqual(distiller.queue({ projectId: 'proj-b' }).records, []);
  assert.deepEqual(distiller.queue({ projectId: 'proj-a' }).records, []);

  // 按项目反查：行本身按项目归属，来源台账又让「同现象另一项目那条」也可被反查到。
  assert.deepEqual(personal.listLessonsForProject('proj-b').map((lesson) => lesson.id).sort(),
    [lessonA, lessonB].sort());
  assert.deepEqual(personal.listLessonsForProject('proj-a').map((lesson) => lesson.id).sort(),
    [lessonA, lessonB].sort());
});

test('只在单一项目出现：不打已复现标记，支持项目数为 1', async (t) => {
  const { tmp, owner, personal } = makeStores(t);
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-a'), projectId: 'proj-a', name: 'A' });
  const distiller = new LessonDistiller({ ownerStore: owner, personalStore: personal, extractor });

  await distillProject(distiller, 'proj-a');
  const [lesson] = personal.listLessons();
  assert.ok(lesson);
  assert.equal(lesson.reproduced, false, '单项目经验不标记已复现');
  assert.equal(lesson.supportProjects, 1);
  assert.deepEqual(lesson.sources.map((source) => source.projectId), ['proj-a']);
  assert.notEqual(lesson.verificationStatus, 'verified', '提炼与复现都不自动升为已验证');
});

test('升为域级：作用域改变、来源项目仍可追溯、验证状态不变', async (t) => {
  const { tmp, owner, personal } = makeStores(t);
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-a'), projectId: 'proj-a', name: 'A' });
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-b'), projectId: 'proj-b', name: 'B' });
  const distiller = new LessonDistiller({ ownerStore: owner, personalStore: personal, extractor });

  await distillProject(distiller, 'proj-a');
  await distillProject(distiller, 'proj-b');
  // P0-1：两个项目各一条；升域只作用在人显式点的那一条上。
  const [lessonA] = personal.listLessons({ projectId: 'proj-a' });
  const [lessonB] = personal.listLessons({ projectId: 'proj-b' });
  assert.notEqual(lessonA.id, lessonB.id);
  const projectScope = normalizeLesson({
    ...lessonA,
    projectId: lessonA.projectId,
    scope: { layer: 'project', projectId: lessonA.projectId, domainIds: ['software-engineering'] }
  });

  const promoted = personal.promoteLessonToDomain(lessonA.id, { domainIds: ['software-engineering'] });
  assert.equal(promoted.scope.layer, 'domain', '升域后作用域是域级');
  assert.equal(promoted.scope.projectId, null, '域级经验不再属于单个项目');
  assert.deepEqual(promoted.scope.domainIds, ['software-engineering']);
  assert.notEqual(promoted.dedupeKey, projectScope.dedupeKey, '作用域层变了，去重键也必须变');
  assert.equal(promoted.verificationStatus, lessonA.verificationStatus, '升域不改变验证状态');

  // 来源项目与执行记录都还在：升域不抹掉「它来自哪些项目」。
  const sources = personal.lessonSources(lessonA.id);
  assert.deepEqual(sources.projects.sort(), ['proj-a', 'proj-b']);
  assert.equal(sources.scopeLayer, 'domain');
  assert.equal(sources.reproduced, true);
  // 另一项目那条原样留在项目级，不会跟着升域。
  assert.equal(personal.getLesson(lessonB.id).scope.layer, 'project');
  assert.ok(personal.listLessonsForProject('proj-b').some((item) => item.id === lessonB.id));
  assert.ok(personal.listLessonsForProject('proj-b').some((item) => item.id === lessonA.id), '域级那条仍按来源项目反查到');
  // 原有证据一条不丢（本项目两条终态运行）。
  assert.equal(personal.getLesson(lessonA.id).evidence.length, 2);

  // 升域幂等：再升一次不会报错、不会改写来源台账。
  const again = personal.promoteLessonToDomain(lessonA.id, { domainIds: ['software-engineering'] });
  assert.deepEqual(again.sources.map((source) => source.projectId).sort(), ['proj-a', 'proj-b']);
});
