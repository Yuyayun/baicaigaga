import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, environment, repository, commitVersion, command, write, assertTemporaryPath } from './fixtures.mjs';
import { saveConfig, configPath } from '../src/environment.mjs';
import { install } from '../install.mjs';

const cliModule = new URL('../src/cli.mjs', import.meta.url).href;
const entry = fileURLToPath(new URL('../bin/baicaigaga.mjs', import.meta.url));
const actualHelper = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function invoke({ helper = actualHelper, home, input }) {
  const script = `import {run} from ${JSON.stringify(cliModule)}; await run(${JSON.stringify({ helper, home, cwd: home })});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: home, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('助手没有及时退出')); }, 30000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('帮助和版本命令直接结束，不进入环境搜索', async () => {
  const version = await execute(process.execPath, [entry, '--version']);
  const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(version.stdout.trim(), expected);
  const help = await execute(process.execPath, [entry, '--help']);
  assert.match(help.stdout, /打开交互菜单/);
  assert.doesNotMatch(help.stdout, /正在检查/);
});

test('无酒馆时可跳过定位并正常退出，EOF 也完全结束进程', async t => {
  const home = await temporary(t);
  const result = await invoke({ home, input: '0\n0\n' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /尚未定位/);
  assert.match(result.stdout, /助手已退出/);
  assert.doesNotMatch(result.stdout, /\x1b|按回车返回主菜单/);
  const eof = await invoke({ home, input: '' });
  assert.equal(eof.code, 0);
  assert.match(eof.stdout, /助手已退出/);
});

test('完整菜单切换分支后退出，前端和数据文件保持原样', async t => {
  const home = await temporary(t);
  const env = await environment(path.join(home, 'SillyTavern'));
  const repo = await repository(t);
  await commitVersion(repo, 'test', '1.0.2');
  // Both paths are known temporary fixture directories, never production paths.
  assertTemporaryPath(env.backend, home);
  assertTemporaryPath(repo.work, repo.base);
  await rm(env.backend, { recursive: true });
  await rename(repo.work, env.backend);
  await saveConfig(env.root, configPath(home));
  await write(env.root, 'data/chats/sentinel.jsonl', 'KEEP CHAT\n');
  await write(env.root, 'data/backups/sentinel.sqlite', 'KEEP BACKUP\n');
  const frontendFile = path.join(env.frontend, 'index.js');
  const before = await readFile(frontendFile, 'utf8');
  const result = await invoke({ home, input: '1\n2\n0\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已切换至 test/);
  assert.match(result.stdout, /当前版本：1.0.2/);
  assert.match(result.stdout, /请重启 SillyTavern/);
  assert.doesNotMatch(result.stdout, /\x1b|按回车返回主菜单/);
  assert.match(result.stdout, /分支：test\n版本：1.0.2/);
  assert.equal(command(env.backend, 'branch', '--show-current'), 'test');
  assert.equal(await readFile(frontendFile, 'utf8'), before);
  assert.equal(await readFile(path.join(env.root, 'data/chats/sentinel.jsonl'), 'utf8'), 'KEEP CHAT\n');
  assert.equal(await readFile(path.join(env.root, 'data/backups/sentinel.sqlite'), 'utf8'), 'KEEP BACKUP\n');
});

test('自更新成功后立即结束进程，不再次进入菜单', async t => {
  const home = await temporary(t);
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.2.0');
  const result = await invoke({ helper: repo.work, home, input: '0\n2\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /测试助手已更新/);
  assert.match(result.stdout, /请重新输入：\nbaicaigaga/);
  assert.equal((result.stdout.match(/1\. 切换后端分支/g) ?? []).length, 1);
  assert.equal(command(repo.work, 'rev-parse', 'HEAD'), command(repo.seed, 'rev-parse', 'HEAD'));
});

test('安装拒绝覆盖不属于助手的入口文件', async t => {
  const home = await temporary(t);
  await write(home, 'bin/sh', 'fixture shell');
  await write(home, 'bin/baicaigaga', 'DO NOT OVERWRITE');
  await assert.rejects(install({ prefix: home }), /拒绝覆盖/);
  assert.equal(await readFile(path.join(home, 'bin/baicaigaga'), 'utf8'), 'DO NOT OVERWRITE');
});

test('命令入口使用绝对解释器及路径，支持引号和空格并可重复安装', async t => {
  const home = await temporary(t);
  await write(home, 'bin/sh', '#!/bin/sh\nexec /bin/sh "$@"\n');
  await chmod(path.join(home, 'bin', 'sh'), 0o755);
  const helper = path.join(home, "helper with ' quote");
  await write(helper, 'package.json', { name: 'baicaigaga', version: '0.1.0' });
  await write(helper, 'bin/baicaigaga.mjs', 'console.log(JSON.stringify(process.argv.slice(2)));');
  const result = await install({ helper, prefix: home });
  const script = await readFile(result.launcher, 'utf8');
  assert.match(script, /managed command/);
  assert.match(script, /exec /);
  assert.ok(script.includes(process.execPath));
  assert.ok(script.includes(`'"'"'`));
  assert.ok(script.endsWith('"$@"\n'));
  await install({ helper, prefix: home });
  assert.equal(await readFile(result.launcher, 'utf8'), script);
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
  if (await stat(shell).then(() => true, () => false)) {
    const args = ['argument with spaces', "quote'argument", '$(literal)'];
    // Feed POSIX source through stdin: Windows/MSYS native argv parsing is a
    // separate layer and would otherwise consume apostrophes before the script.
    const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(shell, [], { cwd: path.dirname(home), windowsHide: true, stdio: 'pipe' });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      child.stdin.end(`exec ${[result.launcher, ...args].map(shellQuote).join(' ')}\n`);
    });
    assert.deepEqual(JSON.parse(stdout.trim()), args);
  }
});
