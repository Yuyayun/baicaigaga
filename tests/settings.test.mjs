import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import { temporary, environment, write, settingsFixture } from './fixtures.mjs';
import { readSettings, toggleSetting } from '../src/settings.mjs';

test('配置未显式写入时区分默认值，读取不产生写入', async t => {
  const env = await settingsFixture(t);
  const before = await readFile(env.file, 'utf8');
  const settings = await readSettings(env.root);
  assert.deepEqual([settings.enableServerPlugins.value, settings.enableServerPlugins.explicit], [false, false]);
  assert.deepEqual([settings.enableServerPluginsAutoUpdate.value, settings.enableServerPluginsAutoUpdate.explicit], [true, false]);
  assert.equal(await readFile(env.file, 'utf8'), before);
});

test('toggle 只改变布尔值，保留 BOM、CRLF、注释、顺序和其它字段', async t => {
  const source = '\uFEFF# 重要注释\r\nport: 8000\r\nenableServerPlugins: true # 保留注释\r\nnested:\r\n  enableServerPlugins: false\r\n  text: "中文: # 值"\r\n';
  const env = await settingsFixture(t, source);
  const beforeMode = (await stat(env.file)).mode & 0o777;
  const result = await toggleSetting(env.root, 'enableServerPlugins');
  assert.equal(result.enableServerPlugins.value, false);
  assert.equal(await readFile(env.file, 'utf8'), source.replace('true #', 'false #'));
  assert.equal((await stat(env.file)).mode & 0o777, beforeMode);
  await toggleSetting(env.root, 'enableServerPlugins');
  assert.equal(await readFile(env.file, 'utf8'), source);
});

test('默认值 toggle 添加显式值且在 YAML 文档结束符之前插入', async t => {
  const env = await settingsFixture(t, '---\nport: 8000\n... # end\n');
  const result = await toggleSetting(env.root, 'enableServerPluginsAutoUpdate');
  assert.equal(result.enableServerPluginsAutoUpdate.value, false);
  assert.equal(result.enableServerPluginsAutoUpdate.explicit, true);
  assert.equal(await readFile(env.file, 'utf8'), '---\nport: 8000\nenableServerPluginsAutoUpdate: false\n... # end\n');
});

test('不存在的配置项仅追加一行，其它配置语义保持一致', async t => {
  const source = 'port: 8000\ntext: |\n  enableServerPlugins: true\n  # literal\nobject: {x: [1, 2], y: null}';
  const env = await settingsFixture(t, source);
  await toggleSetting(env.root, 'enableServerPlugins');
  const actual = await readFile(env.file, 'utf8');
  assert.equal(actual, source + '\nenableServerPlugins: true\n');
  assert.deepEqual(yaml.parse(actual), { ...yaml.parse(source), enableServerPlugins: true });
});

for (const source of [
  'port: [broken\n',
  'enableServerPlugins: true\nenableServerPlugins: false\n',
  'enableServerPlugins: "false"\n',
  'enableServerPlugins: &shared true\nother: *shared\n',
  'value: &shared true\nenableServerPlugins: *shared\n',
  'unrelated: *missing\n',
  '---\nport: 1\n---\nport: 2\n',
  '- enableServerPlugins: true\n',
  '{port: 8000}\n',
]) test(`异常或无法无损修改的 YAML 被拒绝并保留原文：${JSON.stringify(source)}`, async t => {
  const env = await settingsFixture(t, source);
  await assert.rejects(toggleSetting(env.root, 'enableServerPlugins'), /无法|不是/);
  assert.equal(await readFile(env.file, 'utf8'), source);
});

test('配置不存在、YAML 库缺失和非目标字段均给出明确错误', async t => {
  const home = await temporary(t);
  const env = await environment(path.join(home, 'SillyTavern'));
  await assert.rejects(readSettings(env.root), /文件不存在/);
  await write(env.root, 'config.yaml', 'port: 8000\n');
  await assert.rejects(readSettings(env.root), /YAML 解析库/);
  await assert.rejects(toggleSetting(env.root, 'port'), /不支持/);
});

test('原子替换失败时保留旧配置', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const env = await settingsFixture(t, 'enableServerPlugins: true\n');
  await chmod(env.root, 0o500);
  try {
    await assert.rejects(toggleSetting(env.root, 'enableServerPlugins'), /权限不足|写入失败/);
    assert.equal(await readFile(env.file, 'utf8'), 'enableServerPlugins: true\n');
    assert.equal((await lstat(env.file)).isFile(), true);
  } finally { await chmod(env.root, 0o700); }
});
