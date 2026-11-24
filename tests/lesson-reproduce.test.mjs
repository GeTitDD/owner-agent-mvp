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

test('第二个项目复现同一现象：一条经验、支持项目两个、已复现为真，但不升为已验证', async (t) => {
  const { tmp, owner, personal } = makeStores(t);
  // 两个独立项目，各自带一条失败运行与一条修复运行（fixture 会建真 git 仓库）。
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-a'), projectId: 'proj-a', name: 'A' });
  createSyntheticProject({ store: owner, root: path.join(tmp, 'repo-b'), projectId: 'proj-b', name: 'B' });
  const distiller = new LessonDistiller({ ownerStore: owner, personalStore: personal, extractor });

  // 第一次提炼只在 proj-a 出现：单项目，不打复现标记。
  const first = await distillProject(distiller, 'proj-a');
  assert.equal(new Set(first.lessons.map((lesson) => lesson.id)).size, 1);
  const lessonId = first.lessons[0].id;
  const single = personal.getLesson(lessonId);
  assert.equal(single.reproduced, false, '只在一个项目出现时不标记已复现');
  assert.equal(single.supportProjects, 1);

  // 第二个项目出现同一现象：命中同一条经验，不新增经验行。
  const second = await distillProject(distiller, 'proj-b');
  assert.equal(second.lessons.length, 2);
  assert.deepEqual([...new Set(second.lessons.map((lesson) => lesson.id))], [lessonId], '第二个项目必须合并到已有经验');

  const lessons = personal.listLessons();
  assert.equal(lessons.length, 1, '同一现象跨项目只留一条经验');
  const merged = personal.getLesson(lessonId);

  // 复现标记与支持项目台账。
  assert.equal(merged.reproduced, true, '第二个项目复现后必须打已复现标记');
  assert.equal(merged.supportProjects, 2, '支持项目数为 2');
  assert.deepEqual([...merged.supportedByProjects].sort(), ['proj-a', 'proj-b']);
  assert.deepEqual(merged.sources.map((source) => source.projectId).sort(), ['proj-a', 'proj-b']);
  const sources = personal.lessonSources(lessonId);
  assert.deepEqual(sources.projects.sort(), ['proj-a', 'proj-b'], '升级前后都能查回来源项目');
  assert.equal(sources.projectCount, 2);

  // 支持记录按执行记录去重：两个项目各两条终态运行。
  assert.equal(personal.lessonSupport(lessonId).records, 4);
  // 第二项目的记录已经并入这条经验，不再留在待提炼队列。
  assert.deepEqual(distiller.queue({ projectId: 'proj-b' }).records, []);
  assert.deepEqual(distiller.queue({ projectId: 'proj-a' }).records, []);

  // 系统只在复现时打标记，不自动升为已验证。
  assert.notEqual(merged.verificationStatus, 'verified');
  assert.equal(merged.scope.layer, 'project', '复现本身不改变作用域层');

  // 合并后经验行仍挂在最早的项目下；第二个项目要靠来源台账反查（代价写在实现注释里）。
  assert.equal(personal.listLessons({ projectId: 'proj-a' }).length, 1);
  assert.equal(personal.listLessons({ projectId: 'proj-b' }).length, 0);
  assert.deepEqual(personal.listLessonsForProject('proj-b').map((lesson) => lesson.id), [lessonId]);
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
  const [lesson] = personal.listLessons();
  const projectScope = normalizeLesson({
    ...lesson,
    projectId: lesson.projectId,
    scope: { layer: 'project', projectId: lesson.projectId, domainIds: ['software-engineering'] }
  });

  const promoted = personal.promoteLessonToDomain(lesson.id, { domainIds: ['software-engineering'] });
  assert.equal(promoted.scope.layer, 'domain', '升域后作用域是域级');
  assert.equal(promoted.scope.projectId, null, '域级经验不再属于单个项目');
  assert.deepEqual(promoted.scope.domainIds, ['software-engineering']);
  assert.notEqual(promoted.dedupeKey, projectScope.dedupeKey, '作用域层变了，去重键也必须变');
  assert.equal(promoted.verificationStatus, lesson.verificationStatus, '升域不改变验证状态');

  // 来源项目与执行记录都还在：升域不抹掉「它来自哪些项目」。
  const sources = personal.lessonSources(lesson.id);
  assert.deepEqual(sources.projects.sort(), ['proj-a', 'proj-b']);
  assert.equal(sources.scopeLayer, 'domain');
  assert.equal(sources.reproduced, true);
  assert.deepEqual(personal.listLessonsForProject('proj-b').map((item) => item.id), [lesson.id]);
  // 原有证据一条不丢。
  assert.equal(personal.getLesson(lesson.id).evidence.length, 4);

  // 升域幂等：再升一次不会报错、不会改写来源台账。
  const again = personal.promoteLessonToDomain(lesson.id, { domainIds: ['software-engineering'] });
  assert.deepEqual(again.sources.map((source) => source.projectId).sort(), ['proj-a', 'proj-b']);
});
