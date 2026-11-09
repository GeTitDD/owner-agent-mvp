// 项目来源主机推断：本机盘符 / POSIX 路径 / UNC / ssh 前缀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOfRoot, hostLabelOf } from '../src/project-source.mjs';

const LOCAL = 'workstation-01';

test('盘符与 POSIX 路径视为本机', () => {
  assert.equal(hostOfRoot('D:\\projects\\demo', LOCAL), LOCAL);
  assert.equal(hostOfRoot('C:/work/demo', LOCAL), LOCAL);
  assert.equal(hostOfRoot('/home/me/demo', LOCAL), LOCAL);
  assert.equal(hostOfRoot('', LOCAL), LOCAL);
});

test('UNC 路径取共享前的主机', () => {
  assert.equal(hostOfRoot('\\\\build01\\share\\demo', LOCAL), 'build01');
  assert.equal(hostOfRoot('//build01/share/demo', LOCAL), 'build01');
});

test('ssh / sftp / git URL 取主机，忽略用户名', () => {
  assert.equal(hostOfRoot('ssh://git@devbox/srv/app', LOCAL), 'devbox');
  assert.equal(hostOfRoot('sftp://10.0.0.5/data/app', LOCAL), '10.0.0.5');
  assert.equal(hostOfRoot('git://gitserver/repo', LOCAL), 'gitserver');
});

test('分组标题区分本机与远程', () => {
  assert.equal(hostLabelOf(LOCAL, LOCAL), `本机 · ${LOCAL}`);
  assert.equal(hostLabelOf('build01', LOCAL), '远程 · build01');
});
