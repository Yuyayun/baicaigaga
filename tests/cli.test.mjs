import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, rm, stat, chmod, readdir, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, environment, repository, commitVersion, command, write, assertTemporaryPath, settingsFixture } from './fixtures.mjs';
import { saveConfig, configPath } from '../src/environment.mjs';
import { install } from '../install.mjs';

const cliModule = new URL('../src/cli.mjs', import.meta.url).href;
const entry = fileURLToPath(new URL('../bin/baicaigaga.mjs', import.meta.url));
const actualHelper = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function invoke({ helper = actualHelper, home, input }) {
  const script = `import {run} from ${JSON.stringify(cliModule)}; const result = await run(${JSON.stringify({ helper, home, cwd: home })}); if(result?.restart) console.log('RESTART_REQUESTED');`;
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
  const result = await invoke({ home, input: '3\n2\n0\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已切换至 test/);
  assert.match(result.stdout, /当前版本：1.0.2/);
  assert.match(result.stdout, /请重启 SillyTavern/);
  assert.doesNotMatch(result.stdout, /\x1b|按回车返回主菜单/);
  assert.match(result.stdout, /后端    1.0.2\n  分支    test/);
  assert.equal(command(env.backend, 'branch', '--show-current'), 'test');
  assert.equal(await readFile(frontendFile, 'utf8'), before);
  assert.equal(await readFile(path.join(env.root, 'data/chats/sentinel.jsonl'), 'utf8'), 'KEEP CHAT\n');
  assert.equal(await readFile(path.join(env.root, 'data/backups/sentinel.sqlite'), 'utf8'), 'KEEP BACKUP\n');
});

test('检查后按 1 才更新，清理当前会话并请求重启', async t => {
  const home = await temporary(t);
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.2.0');
  const result = await invoke({ helper: repo.work, home, input: '0\n4\n1\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /箱装小助手已更新至 1.2.0/);
  assert.match(result.stdout, /正在重新启动/);
  assert.match(result.stdout, /RESTART_REQUESTED/);
  assert.equal((result.stdout.match(/1  安装 \/ 管理服务器插件/g) ?? []).length, 1);
  assert.equal(command(repo.work, 'rev-parse', 'HEAD'), command(repo.seed, 'rev-parse', 'HEAD'));
});

test('更新检查后返回不改变源码或 HEAD，无新版时只有返回选项', async t => {
  const home = await temporary(t);
  const repo = await repository(t, { name: 'baicaigaga' });
  const before = command(repo.work, 'rev-parse', 'HEAD');
  const pkg = await readFile(path.join(repo.work, 'package.json'), 'utf8');
  const latest = await invoke({ helper: repo.work, home, input: '0\n4\n0\n0\n' });
  assert.match(latest.stdout, /当前已是最新版本/);
  assert.doesNotMatch(latest.stdout, /1  更新到/);
  await commitVersion(repo, 'main', '1.3.0');
  const cancelled = await invoke({ helper: repo.work, home, input: '0\n4\n0\n0\n' });
  assert.match(cancelled.stdout, /1  更新到 1.3.0/);
  assert.doesNotMatch(cancelled.stdout, /已更新至|RESTART_REQUESTED/);
  assert.equal(command(repo.work, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(path.join(repo.work, 'package.json'), 'utf8'), pkg);
});

test('真实命令入口在更新后启动新版文件，无需用户重输命令', { timeout: 30000 }, async t => {
  const home = await temporary(t);
  const repo = await repository(t, { name: 'baicaigaga' });
  for (const file of await readdir(new URL('../src/', import.meta.url))) await write(repo.seed, 'src/' + file, await readFile(new URL('../src/' + file, import.meta.url), 'utf8'));
  await write(repo.seed, 'bin/baicaigaga.mjs', await readFile(entry, 'utf8'));
  command(repo.seed, 'add', 'src', 'bin');
  command(repo.seed, 'commit', '-m', 'runnable old helper');
  command(repo.seed, 'push', 'origin', 'main');
  command(repo.work, 'pull', '--ff-only');
  await commitVersion(repo, 'main', '1.2.0', 'bin/baicaigaga.mjs', 'console.log("RESTARTED_VERSION_1.2.0");\n');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo.work, 'bin/baicaigaga.mjs')], { cwd: home, windowsHide: true, stdio: 'pipe', env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end('0\n4\n1\n');
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /RESTARTED_VERSION_1.2.0/);
  assert.match(result.stdout, /正在重新启动/);
});

test('未安装后端时只查看管理页不会创建目录，0 直接返回', async t => {
  const home = await temporary(t);
  await write(home, 'SillyTavern/package.json', { name: 'sillytavern' });
  await write(home, 'SillyTavern/server.js', '// host');
  const result = await invoke({ home, input: '1\n0\n0\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /前端    未安装\n  后端    未安装/);
  assert.match(result.stdout, /1  安装服务器插件/);
  assert.doesNotMatch(result.stdout, /正在安装服务器插件|\x1b|按回车/);
  await assert.rejects(stat(path.join(home, 'SillyTavern/plugins')), { code: 'ENOENT' });
});

test('设置页数字直接 toggle 并原地刷新，没有额外确认或回车输入', async t => {
  const env = await settingsFixture(t, '# keep\nport: 8000\n');
  const result = await invoke({ home: env.home, input: '2\n2\n1\n0\n0\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /当前    true（默认）/);
  assert.match(result.stdout, /enableServerPluginsAutoUpdate 已修改为 false/);
  assert.match(result.stdout, /enableServerPlugins 已修改为 true/);
  assert.match(result.stdout, /允许 SillyTavern 加载/);
  assert.match(result.stdout, /启动时自动检查并更新 Git/);
  assert.doesNotMatch(result.stdout, /按回车|保持 false|1[. ]+改为 true|\x1b/);
  assert.equal(await readFile(env.file, 'utf8'), '# keep\nport: 8000\nenableServerPluginsAutoUpdate: false\nenableServerPlugins: true\n');
});

test('安装拒绝覆盖不属于助手的入口文件', async t => {
  const home = await temporary(t);
  await write(home, 'bin/sh', 'fixture shell');
  await write(home, 'bin/baicaigaga', 'DO NOT OVERWRITE');
  await assert.rejects(install({ prefix: home }), /拒绝覆盖/);
  assert.equal(await readFile(path.join(home, 'bin/baicaigaga'), 'utf8'), 'DO NOT OVERWRITE');
});

test('命令入口路径通过链接进入前端时拒绝写入', async t => {
  const home = await temporary(t);
  const frontend = path.join(home, 'boxed-lllllabc');
  await mkdir(frontend);
  const prefix = path.join(home, 'prefix');
  await symlink(frontend, prefix, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install({ prefix }), /必须独立/);
  await assert.rejects(stat(path.join(frontend, 'bin/baicaigaga')), { code: 'ENOENT' });
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
