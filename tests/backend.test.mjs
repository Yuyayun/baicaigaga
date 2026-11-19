import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { temporary, environment, repository, write, command } from './fixtures.mjs';
import { installBackend } from '../src/backend.mjs';
import { inspectEnvironment, BACKEND } from '../src/environment.mjs';
import { git } from '../src/git.mjs';

async function host(t) {
  const home = await temporary(t);
  const root = path.join(home, 'SillyTavern');
  await write(root, 'package.json', { name: 'sillytavern' });
  await write(root, 'server.js', '// fixture');
  return { home, root, backend: path.join(root, BACKEND) };
}

test('没有前后端也可识别和发现酒馆本体，分别显示未安装', async t => {
  const env = await host(t);
  const current = await inspectEnvironment(env.root);
  assert.equal(current.root, env.root);
  assert.equal(current.frontendState, 'missing');
  assert.equal(current.backendState, 'missing');
  await write(env.root, 'public/scripts/extensions/third-party/boxed-lllllabc/manifest.json', '{broken');
  assert.equal((await inspectEnvironment(env.root)).frontendState, 'invalid');
});

test('安装 main 后校验仓库、版本、分支、工作区，配置与用户数据保持原样', async t => {
  const env = await host(t);
  const repo = await repository(t);
  await write(env.root, 'config.yaml', 'enableServerPlugins: false\n');
  await write(env.root, 'data/chats/sentinel.jsonl', 'KEEP CHAT\n');
  const result = await installBackend(env.root, { execute: (cwd, args, message) => git(cwd, ['-c', `url.${repo.remote.replaceAll('\\', '/')}.insteadOf=https://github.com/Yuyayun/boxed-lllllabc-server.git`, ...args], message) });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.branch, 'main');
  assert.deepEqual(result.changes, []);
  assert.equal(command(env.backend, 'remote', 'get-url', 'origin'), 'https://github.com/Yuyayun/boxed-lllllabc-server.git');
  assert.equal(await readFile(path.join(env.root, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
  assert.equal(await readFile(path.join(env.root, 'data/chats/sentinel.jsonl'), 'utf8'), 'KEEP CHAT\n');
});

test('已安装、空目录、未知文件目录均在 clone 前停止', async t => {
  const env = await environment(path.join(await temporary(t), 'SillyTavern'));
  await assert.rejects(installBackend(env.root, { execute() { throw new Error('must not clone'); } }), /已存在/);
  const empty = await host(t);
  await mkdir(empty.backend, { recursive: true });
  await assert.rejects(installBackend(empty.root), /已存在/);
  await write(empty.backend, 'unknown.txt', 'KEEP');
  await assert.rejects(installBackend(empty.root), /已存在/);
  assert.equal(await readFile(path.join(empty.backend, 'unknown.txt'), 'utf8'), 'KEEP');
});

test('clone 不完整时保留现场并报告失败，不留下伪成功状态', async t => {
  const env = await host(t);
  await assert.rejects(installBackend(env.root, { execute: async () => { await write(env.backend, 'package.json', '{broken'); } }), /clone 不完整|校验失败/);
  assert.equal(await readFile(path.join(env.backend, 'package.json'), 'utf8'), '{broken');
  await assert.rejects(installBackend(env.root), /已存在/);
});

test('网络失败和失效酒馆不报告安装成功', async t => {
  const env = await host(t);
  await assert.rejects(installBackend(env.root, { execute: async () => { throw new Error('offline'); } }), /安装未完成/);
  assert.equal((await lstat(env.backend)).isDirectory(), true);
  await assert.rejects(installBackend(path.join(env.home, 'missing')), /根目录已失效/);
});

test('plugins 指向酒馆外部时拒绝写入', async t => {
  const env = await host(t);
  const outside = await temporary(t);
  await symlink(outside, path.join(env.root, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installBackend(env.root), /越出|冲突|链接/);
  await assert.rejects(lstat(path.join(outside, 'boxed-lllllabc-server')), { code: 'ENOENT' });
});
