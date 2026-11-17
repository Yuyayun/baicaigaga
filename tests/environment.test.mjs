import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { temporary, environment, write } from './fixtures.mjs';
import { discover, inspectEnvironment, saveConfig, readConfig, configPath, expandHome, assertIndependent, FRONTEND, BACKEND } from '../src/environment.mjs';
import { locate } from '../src/cli.mjs';

test('通过酒馆及前后端元数据确认候选，前端文件内容保留', async t => {
  const base = await temporary(t);
  const expected = await environment(path.join(base, 'SillyTavern'));
  const file = path.join(expected.frontend, 'index.js');
  const before = await readFile(file, 'utf8');
  const info = await inspectEnvironment(expected.root);
  assert.equal(info.root, expected.root);
  assert.equal(info.frontendVersion, '1.0.1');
  assert.equal(info.backendVersion, '1.0.1');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('同名普通目录、缺少前后端及损坏元数据均拒绝', async t => {
  const base = await temporary(t);
  await write(base, 'SillyTavern/package.json', { name: 'ordinary-directory' });
  assert.equal(await inspectEnvironment(path.join(base, 'SillyTavern')), null);
  const env = await environment(path.join(base, 'valid'));
  await write(env.root, `${BACKEND}/package.json`, { name: 'unrelated', version: '1' });
  assert.equal(await inspectEnvironment(env.root), null);
  await write(env.root, `${BACKEND}/package.json`, '{broken');
  assert.equal(await inspectEnvironment(env.root), null);
});

test('从当前目录及父目录定位，HOME 搜索深度有限', async t => {
  const base = await temporary(t);
  const near = await environment(path.join(base, 'near'));
  await environment(path.join(base, 'a', 'b', 'deep'));
  const candidates = await discover({ cwd: near.backend, home: base, maxDepth: 1 });
  assert.deepEqual(candidates.map(item => item.root), [near.root]);
});

test('多个候选保留供用户选择，相同候选去重', async t => {
  const base = await temporary(t);
  const first = await environment(path.join(base, 'SillyTavern'));
  const second = await environment(path.join(base, 'other'));
  const found = await discover({ cwd: first.backend, home: base });
  assert.equal(found.length, 2);
  assert.deepEqual(new Set(found.map(item => item.root)), new Set([first.root, second.root]));
});

test('候选数量上限阻止遍历过多目录', async t => {
  const base = await temporary(t);
  await environment(path.join(base, 'zzz', 'SillyTavern'));
  const found = await discover({ cwd: base, home: base, maxDirs: 1 });
  assert.deepEqual(found, []);
});

test('配置以绝对路径保存，移动失效后不再认可旧路径', async t => {
  const base = await temporary(t);
  const env = await environment(path.join(base, 'SillyTavern'));
  const file = configPath(base);
  await saveConfig(env.root, file);
  assert.equal(await readConfig(file), env.root);
  await rename(env.root, path.join(base, 'moved'));
  assert.equal(await inspectEnvironment(await readConfig(file)), null);
});

test('配置不存在、损坏或路径为相对路径时提供明确信息', async t => {
  const base = await temporary(t);
  const file = configPath(base);
  assert.equal(await readConfig(file), null);
  await write(base, '.config/baicaigaga/config.json', 'broken');
  await assert.rejects(readConfig(file), /无法读取配置/);
  await write(base, '.config/baicaigaga/config.json', { sillyTavernRoot: 'relative' });
  await assert.rejects(readConfig(file), /无法读取配置/);
});

test('已保存的有效路径优先使用，不再搜索其他候选或提问', async t => {
  const base = await temporary(t);
  const first = await environment(path.join(base, 'SillyTavern'));
  await environment(path.join(base, 'other'));
  const file = configPath(base);
  await saveConfig(first.root, file);
  const info = await locate({ helper: path.join(base, 'helper'), home: base, cwd: base, file,
    print() {}, prompt: { ask() { throw new Error('must not prompt'); } } });
  assert.equal(info.root, first.root);
});

test('多个候选时选择后保存，可取消并保留原配置', async t => {
  const base = await temporary(t);
  const first = await environment(path.join(base, 'a'));
  const second = await environment(path.join(base, 'b'));
  const file = configPath(base);
  const options = { helper: path.join(base, 'helper'), home: base, cwd: base, file, print() {}, useSaved: false };
  const selected = await locate({ ...options, prompt: { async ask() { return '2'; } } });
  assert.equal(selected.root, second.root);
  const cancelled = await locate({ ...options, prompt: { async ask() { return '0'; } } });
  assert.equal(cancelled, null);
  assert.equal(await readConfig(file), second.root);
  assert.notEqual(first.root, second.root);
});

test('未找到时接受手动路径，失败输入可重试', async t => {
  const base = await temporary(t);
  const env = await environment(path.join(base, 'a', 'b', 'c', 'd', 'SillyTavern'));
  const answers = ['does-not-exist', env.root];
  const selected = await locate({ helper: path.join(base, 'helper'), home: base, cwd: base, file: configPath(base), print() {},
    prompt: { async ask() { return answers.shift(); } } });
  assert.equal(selected.root, env.root);
});

test('助手目录不能位于前后端中', () => {
  const base = path.resolve('somewhere');
  const env = { frontend: path.join(base, FRONTEND), backend: path.join(base, BACKEND) };
  assert.throws(() => assertIndependent(path.join(env.backend, 'helper'), env), /独立目录/);
  assert.throws(() => assertIndependent(env.frontend, env), /独立目录/);
  assert.doesNotThrow(() => assertIndependent(path.join(base, 'helper'), env));
});

test('手动路径支持 ~、空格及外层引号', () => {
  const home = path.resolve('home');
  assert.equal(expandHome('"~/my tavern"', home), path.join(home, 'my tavern'));
  assert.equal(expandHome('~', home), home);
});

test('HOME 浅层遍历不跟随指向其他位置的目录链接', async t => {
  const base = await temporary(t);
  const outside = await temporary(t);
  await environment(path.join(outside, 'deep', 'SillyTavern'));
  try { await symlink(outside, path.join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('此设备不允许创建目录链接'); return; } throw error; }
  assert.deepEqual(await discover({ cwd: base, home: base }), []);
});
