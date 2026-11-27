// 真实 Git 对两个独立缓存和临时 bare 远端执行读写；不读取个人凭据、不连接 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitMemoryTransport, normalizeSyncTarget, verifyPrivateGitHubRepository, SYNC_FILE_MAX } from '../src/memory/sync-git.mjs';

const git = (args, cwd) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(cwd, '.no-hooks'), '-c', 'commit.gpgsign=false', '-c', 'push.gpgSign=false', ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL:path.join(cwd,'.no-config'),
    GIT_AUTHOR_NAME: 'Sync Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'Sync Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' }
}).trim();
const document = (name, content) => ({ path: `owner-memory/v1/knowledge/${name}.md`, content });
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sync-git-'));
  const remote = path.join(root, 'remote.git'); git(['init', '--bare', '--quiet', remote], root);
  const transport = (name) => new GitMemoryTransport({ root: path.join(root, name), repo: 'fixture/private-memory',
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' }, testRemote: remote });
  return { root, remote, a: transport('a'), b: transport('b'), close: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('同步目标只接受无凭据的 GitHub 仓库和普通分支', () => {
  assert.equal(normalizeSyncTarget('https://github.com/demo/memory.git', 'sync/notes').repo, 'demo/memory');
  for (const repo of ['https://token@github.com/demo/memory', '/tmp/repo', '../repo', 'demo/repo;echo', 'https://example.com/a/b', 'demo/repo?token=x']) {
    assert.throws(() => normalizeSyncTarget(repo), /同步仓库/);
  }
  for (const branch of ['-x', '../main', 'a..b', 'a.lock', 'a b', 'a@{b', 'a\\b', 'a:', 'a/']) assert.throws(() => normalizeSyncTarget('a/b', branch), /分支/);
});

test('首次推送能从另一份真实缓存读到中文和多行正文，重复推送不产生提交', async () => {
  const f = fixture();
  try {
    const first = await f.a.read(); assert.equal(first.head, ''); assert.deepEqual(first.documents, []);
    const docs = [document('lesson-source', '# 中文记忆\n\n多行正文。\n'), document('decision', '# 采用有上限的重试\n')];
    const sent = await f.a.publish({ head: first.head, documents: docs });
    assert.equal(sent.changed, true); assert.equal(sent.published.length, 2);
    const other = await f.b.read(); assert.equal(other.head, sent.head); assert.deepEqual(other.documents, [...docs].sort((a,b)=>a.path.localeCompare(b.path)));
    const repeated = await f.b.publish({ head: other.head, documents: other.documents });
    assert.equal(repeated.changed, false); assert.equal(repeated.head, sent.head);
    assert.equal(git(['--git-dir', f.remote, 'rev-list', '--count', 'refs/heads/main'], f.root), '1');
  } finally { f.close(); }
});

test('两台设备分别发布后仍保留另一台的文档和远端无关文件', async () => {
  const f = fixture();
  try {
    const checkout = path.join(f.root, 'human'); fs.mkdirSync(checkout); git(['init', '--quiet'], checkout);
    fs.writeFileSync(path.join(checkout, 'README.md'), '不要改这份远端文件\n');
    git(['add', 'README.md'], checkout); git(['commit', '--quiet', '-m', 'Initial unrelated file'], checkout);
    git(['push', '--quiet', f.remote, 'HEAD:refs/heads/main'], checkout);
    const a = await f.a.read(); await f.a.publish({ head: a.head, documents: [document('a', 'Alpha')] });
    const b = await f.b.read(); await f.b.publish({ head: b.head, documents: [document('b', 'Beta')] });
    const latest = await f.a.read(); assert.deepEqual(latest.documents.map(d=>d.content), ['Alpha', 'Beta']);
    assert.equal(git(['--git-dir', f.remote, 'show', 'refs/heads/main:README.md'], f.root), '不要改这份远端文件');
  } finally { f.close(); }
});

test('预览后远端变化会拒绝旧推送，不覆盖另一设备的新记录', async () => {
  const f = fixture();
  try {
    await f.a.publish({ head: '', documents: [document('a', '初始')] });
    const stale = await f.a.read(); const next = await f.b.read();
    await f.b.publish({ head: next.head, documents: [document('a', '另一设备的新内容')] });
    await assert.rejects(f.a.publish({ head: stale.head, documents: [document('a', '旧选择不得覆盖')] }), { code: 'remote-changed' });
    assert.equal((await f.a.read()).documents[0].content, '另一设备的新内容');
  } finally { f.close(); }
});

test('读取后到 push 之间的竞争由 Git 拒绝，不能通过强推绕过', async () => {
  const f = fixture();
  try {
    await f.a.publish({ head: '', documents: [document('a', '初始')] });
    const stale = await f.a.read(); const next = await f.b.read();
    const run = f.a.run.bind(f.a); let raced = false;
    f.a.run = async (args, options) => {
      if (args[0] === 'push' && !raced) { raced = true; await f.b.publish({ head: next.head, documents: [document('b', '并发内容')] }); }
      return run(args, options);
    };
    await assert.rejects(f.a.publish({ head: stale.head, documents: [document('a', '未获准的旧覆盖')] }), { code: 'git-failed' });
    const latest = await f.b.read(); assert.deepEqual(latest.documents.map(d=>d.content), ['初始', '并发内容']);
  } finally { f.close(); }
});

test('路径穿越、重复路径、非文本与超长正文在写入前拒绝', async () => {
  const f = fixture();
  try {
    for (const docs of [
      [{ path: '../README.md', content: 'x' }], [{ path: 'README.md', content: 'x' }],
      [document('a','x'),document('a','y')], [document('a','\0')], [document('a','a'.repeat(SYNC_FILE_MAX+1))]
    ]) await assert.rejects(f.a.publish({ head: '', documents: docs }));
    assert.equal((await f.b.read()).head, '');
  } finally { f.close(); }
});

test('远端 Markdown 符号链接不检出、不跟随，也不读取链接指向的文件', async () => {
  const f = fixture();
  try {
    await f.a.initialize();
    const oid = (await f.a.run(['hash-object','-w','--stdin'],{input:'/etc/passwd'})).toString().trim();
    const tree = (await f.a.run(['mktree','--missing'],{input:`120000 blob ${oid}\tevil.md\n`})).toString().trim();
    const v1 = (await f.a.run(['mktree'],{input:`040000 tree ${tree}\tknowledge\n`})).toString().trim();
    const ownerMemory = (await f.a.run(['mktree'],{input:`040000 tree ${v1}\tv1\n`})).toString().trim();
    const rootTree = (await f.a.run(['mktree'],{input:`040000 tree ${ownerMemory}\towner-memory\n`})).toString().trim();
    const commit = (await f.a.run(['commit-tree',rootTree,'-m','Unsafe fixture'])).toString().trim();
    await f.a.run(['push',f.remote,`${commit}:refs/heads/main`]);
    await assert.rejects(f.b.read(), { code: 'document-mode-invalid' });
    assert.equal(fs.existsSync(path.join(f.b.root,'owner-memory')),false);
  } finally { f.close(); }
});

test('凭据只存在子进程环境，缓存和 Git 配置文件不持久化 token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'owner-sync-credential-'));
  const token = 'SYNTHETIC-CREDENTIAL-NOT-REAL';
  try {
    const t = new GitMemoryTransport({ root, repo:'fixture/private', env:{ ...process.env, GH_TOKEN:token, GITHUB_TOKEN:'' } });
    await t.initialize();
    const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
    for (const file of walk(root)) {
      const content=fs.readFileSync(file).toString(); assert.ok(!content.includes(token)); assert.ok(!content.includes(Buffer.from(`x-access-token:${token}`).toString('base64')));
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('已取消的读取不会传输内容；缺少 Git 会给明确的可恢复原因', async () => {
  const f = fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.a.read({signal:controller.signal}),{code:'aborted'});
    const absent = new GitMemoryTransport({root:path.join(f.root,'absent'),repo:'fixture/private',git:path.join(f.root,'no-git'),testRemote:f.remote});
    await assert.rejects(absent.read(),{code:'git-unavailable'});
  } finally { f.close(); }
});

test('GitHub 预检只认可当前凭据的自有私有可写仓库，不能只看地址', async () => {
  const target=normalizeSyncTarget('fixture/private'); const token='SYNTHETIC-NOT-REAL';
  for (const [override,code] of [[{private:false},'repository-not-private'],[{owner:{login:'other'}},'repository-not-owned'],[{permissions:{push:false}},'repository-not-writable'],[{},'']]) {
    const fetchImpl=async (url,options)=>{
      assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,`Bearer ${token}`);
      return {ok:true,json:async()=>url.endsWith('/user')?{login:'fixture'}:{private:true,owner:{login:'fixture'},permissions:{push:true},...override}};
    };
    const call=verifyPrivateGitHubRepository({target,token,fetchImpl});
    if(code)await assert.rejects(call,{code});else assert.equal((await call).private,true);
  }
});

test('调用方的 Git 配置、仓库与跟踪环境不影响同步子进程', async()=>{
  const f=fixture();try{
    const trace=path.join(f.root,'must-not-exist.log');const foreign=path.join(f.root,'foreign');fs.mkdirSync(foreign);
    const t=new GitMemoryTransport({root:path.join(f.root,'hostile'),repo:'fixture/private',testRemote:f.remote,
      env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:'',GIT_DIR:foreign,GIT_COMMON_DIR:foreign,GIT_NAMESPACE:'foreign',GIT_INDEX_FILE:path.join(foreign,'index'),GIT_CONFIG_PARAMETERS:"'invalid-config'",GIT_TRACE:trace,GIT_TRACE2_EVENT:trace}});
    await t.publish({head:'',documents:[document('safe','隔离成功')]});
    assert.equal((await f.b.read()).documents[0].content,'隔离成功');assert.deepEqual(fs.readdirSync(foreign),[]);assert.equal(fs.existsSync(trace),false);
  }finally{f.close();}
});

test('发布后的整棵树受篇数限制，不会新增一个下次无法读取的提交',async()=>{
  const f=fixture();try{
    await assert.rejects(f.a.publish({head:'',documents:Array.from({length:10001},(_,i)=>document(`doc-${i}`,''))}),{code:'document-count-limit'});
    assert.equal((await f.b.read()).head,'');
  }finally{f.close();}
});

test('增量必须连同远端保留文档计算总量，覆盖同路径不重复计数',async()=>{
  const f=fixture();try{
    const docs=Array.from({length:64},(_,i)=>document(`full-${i}`,'x'.repeat(SYNC_FILE_MAX)));
    const first=await f.a.publish({head:'',documents:docs});
    await assert.rejects(f.a.publish({head:first.head,documents:[document('extra','x')]}),{code:'document-size-limit'});
    assert.equal(await f.a.remoteHead(),first.head);
    const replace=await f.a.publish({head:first.head,documents:[document('full-0','更小的替换')]});assert.equal(replace.changed,true);
  }finally{f.close();}
});
