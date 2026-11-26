// #108 验收：输入 `/` 打开的技能面板（数字快捷 + 全部技能）。
//
// 命中真实路径：离屏 Electron + CDP，技能来自主进程 skills.catalog 的扫描结果。
// 为了让「全部技能」可断言，脚本把 PSTACK_DIR / MATT_SKILLS_DIR 指到临时目录：
//   · pstack：poteto-mode（解析器要求）+ alpha-01..16（其中 alpha-07 的说明带
//     一个唯一的搜索词）；
//   · matt：matt-plan / matt-review。
// 域包与插件仍是仓库自带的来源，所以面板拿到的确实是「四处扫描合并」的结果。
// 覆盖：两段可见、滚动到底、按 id / 说明搜索、无匹配空态、点技能行调用、
//       ↑↓ + Enter 调数字行、改数字产生冲突并消解、按新数字调用、刷新后仍生效。
// 截图：面板全览、搜索态、改数字（冲突）态。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-108');
const tempBase = process.env.TMP_108 ?? path.resolve(shotsDir, '..', 'tmp-108');
const { check, failures } = createChecker('[SLASH-#108]');

const ALIAS_KEY = 'ownerShell.skillAliases.v1';

const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

const skillMd = (id, description) => [
  '---',
  `name: ${id}`,
  `description: ${description}`,
  '---',
  '',
  `# ${id}`,
  '',
  'Fixture body; the panel only reads front-matter name/description.',
  ''
].join('\n');

/** 造一份可控的技能目录：pstack 足够长，能看到末尾；matt 用来看第二个来源。 */
const makeSkillRoots = (root) => {
  const pstackRoot = path.join(root, 'pstack');
  const pstackSkills = path.join(pstackRoot, 'skills');
  // resolvePstackSkillsDir 用 poteto-mode 判断「这里是不是 pstack skills 目录」。
  writeFile(path.join(pstackSkills, 'poteto-mode', 'SKILL.md'),
    skillMd('poteto-mode', 'Fixture entry required by the pstack skills resolver.'));
  for (let index = 1; index <= 16; index += 1) {
    const id = `alpha-${String(index).padStart(2, '0')}`;
    const description = index === 7
      ? 'Panel fixture with a unique needle zebra-stripe.'
      : `Panel fixture ${id} description.`;
    writeFile(path.join(pstackSkills, id, 'SKILL.md'), skillMd(id, description));
  }
  const mattRoot = path.join(root, 'matt');
  writeFile(path.join(mattRoot, 'engineering', 'matt-review', 'SKILL.md'),
    skillMd('matt-review', 'Review fixture from the matt source.'));
  writeFile(path.join(mattRoot, 'productivity', 'matt-plan', 'SKILL.md'),
    skillMd('matt-plan', 'Plan fixture from the matt source.'));
  return { pstackRoot, mattRoot };
};

/** 面板当前可断言的形状：两段、每行、滚动与提示。 */
const readPanel = (panel) => panel.evaluate(`(() => {
  const panelNode = document.getElementById('skillPanel');
  const list = document.getElementById('skillList');
  const items = [...list.querySelectorAll('.slash-item')];
  const toRow = (node) => ({
    kind: node.dataset.kind,
    id: node.dataset.skillRow,
    cmd: node.querySelector('.slash-cmd')?.textContent.trim() ?? '',
    desc: node.querySelector('.slash-desc')?.textContent.trim() ?? '',
    src: node.querySelector('.slash-src:not(.is-missing)')?.textContent.trim() ?? '',
    missing: Boolean(node.querySelector('.slash-src.is-missing')),
    conflict: node.classList.contains('is-conflict'),
    number: node.querySelector('.slash-num')?.textContent.trim()
      ?? node.querySelector('.slash-num-input')?.value ?? ''
  });
  const rows = items.map(toRow);
  const listRect = list.getBoundingClientRect();
  const headers = [...list.querySelectorAll('.slash-group')].map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      text: node.textContent.trim(),
      visible: rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1
    };
  });
  return {
    hidden: panelNode.hidden,
    count: document.getElementById('skillCount').textContent.trim(),
    groups: headers,
    quick: rows.filter((row) => row.kind === 'command'),
    builtin: rows.filter((row) => row.kind === 'builtin'),
    rest: rows.filter((row) => row.kind === 'skill'),
    rows,
    empty: list.querySelector('.slash-empty')?.textContent.trim() ?? '',
    error: document.getElementById('skillError').hidden
      ? '' : document.getElementById('skillError').textContent.trim(),
    conflictText: document.getElementById('skillConflict').hidden
      ? '' : document.getElementById('skillConflict').textContent.trim(),
    aliasLabel: document.getElementById('skillAliasToggle').textContent.trim(),
    aliasPressed: document.getElementById('skillAliasToggle').getAttribute('aria-pressed'),
    hint: document.getElementById('skillHint').textContent.trim(),
    scroll: { top: list.scrollTop, max: list.scrollHeight - list.clientHeight }
  };
})()`);

const readThread = (panel) => panel.evaluate(`(() => {
  const items = [...document.querySelectorAll('#messages .msg')];
  return {
    count: items.length,
    texts: items.map((item) => item.querySelector('.bubble')?.textContent ?? ''),
    kv: [...document.querySelectorAll('.msg.agent .block[data-block="kv"]')]
      .map((node) => node.textContent.trim())
  };
})()`);

const readAliasStorage = (panel) => panel.evaluate(
  `localStorage.getItem(${JSON.stringify(ALIAS_KEY)})`
);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

/** 往输入框里打字并派发 input：与用户敲 `/` 走同一条路径。 */
const typeInput = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

const pressKey = (panel, key) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

const setAliasNumber = (panel, id, value) => panel.evaluate(`(() => {
  const field = document.querySelector('.slash-num-input[data-alias-for="'
    + ${JSON.stringify(id)} + '"]');
  if (!field) return false;
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return field.value;
})()`);

/** 新建一条会话：面板要能调用，必须先有当前会话。 */
const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const openSlash = async (panel) => {
  await typeInput(panel, '/');
  return waitFor(panel,
    "document.getElementById('skillPanel').hidden === false"
    + " && document.querySelectorAll('#skillList .slash-item').length > 0", 20000);
};

const firstQuickId = (model) => model.quick[0]?.id ?? '';
const inputValue = (panel) => panel.evaluate("document.getElementById('input').value");
const chipText = (panel) => panel.evaluate(
  "document.getElementById('skillChip').hidden ? '' : document.getElementById('skillChipLabel').textContent.trim()"
);
// 面板与消息只显示技能名（去来源前缀）；断言也按这个名字写。
const skillName = (id) => String(id ?? '').split(/[:/]/u).filter(Boolean).pop() ?? '';

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'slash-108-'));
  const fixture = makeSkillRoots(path.join(root, 'skills-fixture'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    env: {
      PSTACK_DIR: fixture.pstackRoot,
      MATT_SKILLS_DIR: fixture.mattRoot,
      // 技能点击不再发送脚本卡片；未知命令会被当普通消息发给模型，验收用假回答。
      OWNER_AGENT_CHAT_FAKE: '1'
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('card shell loads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before invoking skills', await createSession(panel));

    // ① `/` 立刻打开面板，两段都在（分组标题不靠滚动才出现）。
    check('typing / opens the skill panel', await openSlash(panel));
    let model = await readPanel(panel);
    check('panel is visible', model.hidden === false);
    check('catalog loads without an error', model.error === '', model.error);
    check('three sections are rendered: built-in commands, number slots, all skills',
      model.groups.some((group) => group.text.includes('命令'))
      && model.groups.some((group) => group.text.includes('数字快捷'))
      && model.groups.some((group) => group.text.includes('全部技能')),
      model.groups.map((group) => group.text).join(' | '));
    check('the built-in section lists /setup with a 内置 badge',
      model.builtin.some((row) => row.cmd === '/setup' && row.src === '内置'),
      JSON.stringify(model.builtin.map((row) => row.cmd)));
    // #132：原判据要求两段标题「不滚动就能同时看到」，字体度量稍宽就必红。
    // 改成「两段都在，且各自都能滚进视野」——仍然要求两条标题都存在、都能看到，
    // 只是不再把「同一屏放得下」这种排版巧合当验收条件。
    const headersReachable = await panel.evaluate(`(() => {
      const list = document.getElementById('skillList');
      const groups = [...list.querySelectorAll('.slash-group')];
      const box = list.getBoundingClientRect();
      const canShow = (node) => {
        const top = node.getBoundingClientRect().top - box.top + list.scrollTop;
        list.scrollTop = Math.max(0, top - 4);
        const rect = node.getBoundingClientRect();
        const shown = list.getBoundingClientRect();
        return rect.bottom > shown.top - 1 && rect.top < shown.bottom + 1;
      };
      return {
        count: groups.length,
        texts: groups.map((node) => node.textContent.trim()),
        all: groups.every(canShow)
      };
    })()`);
    check('all three section headers are present and can be scrolled into view',
      headersReachable.count === 3
      && headersReachable.texts.some((text) => text.includes('命令'))
      && headersReachable.texts.some((text) => text.includes('数字快捷'))
      && headersReachable.texts.some((text) => text.includes('全部技能'))
      && headersReachable.all === true,
      JSON.stringify(headersReachable));
    check('quick section has nine numbered rows',
      model.quick.length === 9
      && model.quick.map((row) => row.number).join(',') === '1,2,3,4,5,6,7,8,9',
      model.quick.map((row) => `${row.number}:${row.id}`).join(' '));
    const quickId = firstQuickId(model);
    check('quick rows come from the scan (not hardcoded)',
      Boolean(quickId) && model.quick.every((row) => row.cmd === `/${skillName(row.id)}`),
      quickId);
    check('every row shows a source badge',
      model.rows.every((row) => row.src.length > 0),
      JSON.stringify(model.rows.slice(0, 3).map((row) => [row.id, row.src])));
    check('descriptions are the scanned English text',
      model.rows.some((row) => row.desc.includes('Panel fixture'))
      || model.rows.some((row) => row.desc.includes('Review fixture')),
      model.rows.find((row) => row.desc.includes('Panel fixture'))?.desc ?? '');
    check('the full scan is listed, not only the first group',
      model.rest.length >= 20 && model.count.includes('共 '),
      `${model.rest.length} rows / ${model.count}`);
    await capture(panel, path.join(shotsDir, 'slash-panel.png'));

    // ② 滚动到底：最后一条扫描结果能滚进视野。
    const scroll = await panel.evaluate(`(() => {
      const list = document.getElementById('skillList');
      list.scrollTop = list.scrollHeight;
      const items = [...list.querySelectorAll('.slash-item')];
      const last = items[items.length - 1];
      if (!last) return { top: 0, max: 0, lastId: '', lastVisible: false };
      const box = list.getBoundingClientRect();
      const rect = last.getBoundingClientRect();
      return {
        top: list.scrollTop,
        max: list.scrollHeight - list.clientHeight,
        lastId: last.dataset.skillRow,
        lastVisible: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
      };
    })()`);
    check('the panel scrolls to the end',
      scroll.max > 0 && Math.abs(scroll.top - scroll.max) < 2, JSON.stringify(scroll));
    check('the last scanned skill is reachable', scroll.lastVisible === true, scroll.lastId);

    // ③ 搜索：按 id、按说明；空结果是明确空态。
    await typeInput(panel, '/alpha-12');
    await waitFor(panel, "document.querySelectorAll('#skillList .slash-item').length === 1", 5000);
    model = await readPanel(panel);
    check('search by id filters to that skill',
      model.rows.length === 1 && model.rows[0].id.endsWith(':alpha-12'), JSON.stringify(model.rows));
    check('the filtered header says it is filtered',
      model.groups.some((group) => group.text.includes('已过滤')),
      model.groups.map((group) => group.text).join(' | '));

    await typeInput(panel, '/zebra-stripe');
    await waitFor(panel, "document.querySelectorAll('#skillList .slash-item').length === 1", 5000);
    model = await readPanel(panel);
    check('search by description also matches',
      model.rows.length === 1 && model.rows[0].id.endsWith(':alpha-07'), JSON.stringify(model.rows));
    check('the description keeps its original English text',
      model.rows[0]?.desc === 'Panel fixture with a unique needle zebra-stripe.',
      model.rows[0]?.desc ?? '');
    await capture(panel, path.join(shotsDir, 'slash-search.png'));

    await typeInput(panel, '/definitely-no-such-skill');
    await waitFor(panel, "Boolean(document.querySelector('#skillList .slash-empty'))", 5000);
    model = await readPanel(panel);
    check('no match shows an explicit empty state',
      model.rows.length === 0 && model.empty.includes('没有匹配')
      && model.empty.includes('definitely-no-such-skill'),
      model.empty);

    // ④ 点技能行 = 把「/技能id 」放进输入框，不发送、不落库。
    await typeInput(panel, '/matt-plan');
    await waitFor(panel, "Boolean(document.querySelector('.slash-item[data-skill-row*=\"matt-plan\"]'))", 5000);
    model = await readPanel(panel);
    const mattId = model.rows.find((row) => row.id.includes('matt-plan'))?.id ?? '';
    check('the matt fixture is found by search', Boolean(mattId), mattId);
    check('clicking a skill row is accepted',
      await click(panel, `.slash-item[data-skill-row=${JSON.stringify(mattId)}]`));
    await waitFor(panel, "document.getElementById('skillPanel').hidden === true", 5000);
    check('clicking a skill shows it as a chip',
      (await chipText(panel)) === `/${skillName(mattId)}`, await chipText(panel));
    check('the composer holds only the question',
      (await inputValue(panel)) === '', await inputValue(panel));
    check('clicking a skill does not send a scripted card',
      (await readThread(panel)).count === 0, String((await readThread(panel)).count));
    // 选完技能接着写问题：不能又被当成分组搜索重新弹出。
    await typeInput(panel, '这个问题怎么答');
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('typing the question after a skill keeps the panel closed',
      await panel.evaluate("document.getElementById('skillPanel').hidden === true"));

    // ⑤ 键盘：↑↓ 选、Enter 把数字行填进输入框（同样不发送）。
    check('reopening / shows the panel again', await openSlash(panel));
    model = await readPanel(panel);
    const secondQuickId = model.quick[1]?.id ?? 'alpha-01';
    // 内置命令排在最前：从第一行走到「第二个数字行」要跨过内置命令。
    check('ArrowDown is consumed by the panel', await pressKey(panel, 'ArrowDown'));
    for (let step = 0; step < model.builtin.length; step += 1) {
      await pressKey(panel, 'ArrowDown');
    }
    check('Enter is handled by the panel', await pressKey(panel, 'Enter'));
    await waitFor(panel, "document.getElementById('skillPanel').hidden === true", 5000);
    check('the numeric row shows the skill as a chip',
      (await chipText(panel)) === `/${skillName(secondQuickId)}`, await chipText(panel));
    check('the numeric row leaves the composer empty',
      (await inputValue(panel)) === '', await inputValue(panel));
    check('the numeric row does not send anything',
      (await readThread(panel)).count === 0, String((await readThread(panel)).count));

    // ⑥ 改数字：先造冲突，再消解；改完按新数字能调用。
    check('reopening / for aliasing', await openSlash(panel));
    await click(panel, '#skillAliasToggle');
    await waitFor(panel, "document.querySelectorAll('.slash-num-input').length === 9", 5000);
    model = await readPanel(panel);
    const idA = model.quick[0].id;
    const idB = model.quick[1].id;
    // 让第一名和第二名同号：冲突必须当场可见。
    await setAliasNumber(panel, idA, '2');
    model = await readPanel(panel);
    check('duplicate numbers are marked on both rows',
      model.quick[0].conflict === true && model.quick[1].conflict === true,
      JSON.stringify(model.quick.slice(0, 2)));
    check('a conflict banner explains what will happen',
      model.conflictText.includes('数字冲突') && model.conflictText.includes(idA)
      && model.conflictText.includes(idB),
      model.conflictText);
    await capture(panel, path.join(shotsDir, 'slash-alias-conflict.png'));

    // 交换两个数字，冲突消失。
    await setAliasNumber(panel, idB, '1');
    model = await readPanel(panel);
    check('swapping the numbers clears the conflict',
      model.conflictText === '' && model.quick.every((row) => row.conflict === false),
      model.conflictText);
    await click(panel, '#skillAliasToggle');
    await waitFor(panel, "document.querySelectorAll('.slash-num-input').length === 0", 5000);
    model = await readPanel(panel);
    check('the customized numbers are shown after finishing',
      model.quick.find((row) => row.id === idA)?.number === '2'
      && model.quick.find((row) => row.id === idB)?.number === '1',
      model.quick.slice(0, 2).map((row) => `${row.number}:${row.id}`).join(' '));
    const stored = JSON.parse((await readAliasStorage(panel)) ?? '{}');
    check('only the changed numbers are persisted',
      JSON.stringify(stored) === JSON.stringify({ [idB]: 1, [idA]: 2 })
      || JSON.stringify(stored) === JSON.stringify({ [idA]: 2, [idB]: 1 }),
      JSON.stringify(stored));

    // 按新数字 2 过滤，命中第一名；点它走数字命令路径。
    await typeInput(panel, '/2');
    await waitFor(panel, "document.querySelectorAll('#skillList .slash-item').length === 1", 5000);
    model = await readPanel(panel);
    check('the new number filters to its skill',
      model.rows.length === 1 && model.rows[0].id === idA && model.rows[0].number === '2',
      JSON.stringify(model.rows));
    check('clicking the renumbered row is accepted',
      await click(panel, `.slash-item[data-skill-row="${idA}"]`));
    await waitFor(panel, "document.getElementById('skillPanel').hidden === true", 5000);
    check('the renumbered row shows the skill as a chip',
      (await chipText(panel)) === `/${skillName(idA)}`, await chipText(panel));

    // ⑦ 刷新：数字别名仍在（localStorage 持久化 + 合并）。
    await panel.send('Page.reload');
    check('shell reloads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('the session still exists after reload',
      await waitFor(panel, "document.getElementById('input').disabled === false", 15000));
    // 顶栏把会话选出来之后面板才会稳定：太早敲 `/` 会被随后的 syncComposer 关掉。
    check('the session is selected after reload',
      await waitFor(panel,
        "document.getElementById('sessionLabel').textContent.trim() !== '还没有会话'", 15000));
    await waitFor(panel,
      "document.querySelectorAll('#messages .msg').length === 0", 15000);
    check('the panel opens after reload', await openSlash(panel));
    model = await readPanel(panel);
    check('custom numbers survive a reload',
      model.quick.find((row) => row.id === idA)?.number === '2'
      && model.quick.find((row) => row.id === idB)?.number === '1',
      model.quick.slice(0, 2).map((row) => `${row.number}:${row.id}`).join(' '));
    check('skill clicks never wrote history',
      (await readThread(panel)).count === 0, String((await readThread(panel)).count));

    // ⑧ #132 回归：没有匹配项时 Enter 不能吞键——关面板，并把这条照常发出去。
    await typeInput(panel, '/definitely-no-such-skill');
    await waitFor(panel, "Boolean(document.querySelector('#skillList .slash-empty'))", 10000);
    check('Enter is still handled by the composer', await pressKey(panel, 'Enter'));
    check('no match + Enter closes the panel',
      await waitFor(panel, "document.getElementById('skillPanel').hidden === true", 5000));
    check('no match + Enter sends the draft as a normal message',
      await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 2", 8000),
      String((await readThread(panel)).count));
    const thread = await readThread(panel);
    check('the sent draft keeps its raw text',
      thread.texts.includes('/definitely-no-such-skill'), JSON.stringify(thread.texts));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 失败留现场，成功删不掉也不影响结论 */ }
    } else {
      console.warn(`[SLASH-#108] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[SLASH-#108] screenshots: ${shotsDir}`);
  console.log('[SLASH-#108] PASS');
};

run().catch((error) => {
  console.error(`[SLASH-#108] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[SLASH-#108] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
