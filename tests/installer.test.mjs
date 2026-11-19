import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, chmod, mkdir, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, repository, command, write } from './fixtures.mjs';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const script = fileURLToPath(new URL('../install.sh', import.meta.url));
const quote = value => `'${value.replaceAll('\\', '/').replace(/'/g, `'"'"'`)}'`;
const posix = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`);
const realGit = process.platform === 'win32' ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

async function fixture(t, { node = '24.12.0', git = true, pkgFailure = false, missingNode = false } = {}) {
  const home = await temporary(t);
  const bin = path.join(home, 'tools');
  const log = path.join(home, 'commands.log');
  const state = path.join(home, 'dependencies-ready');
  await mkdir(bin);
  await write(home, 'gitconfig', `[url "${path.join(home, 'offline-missing.git').replaceAll('\\', '/')}"]\n\tinsteadOf = https://github.com/Yuyayun/baicaigaga.git\n`);
  const executable = async (name, body) => {
    await write(bin, name, '#!/bin/sh\n' + body + '\n');
    await chmod(path.join(bin, name), 0o755);
  };
  const nodeBody = `if [ "$1" = --version ]; then if [ -f ${quote(state)} ]; then echo v24.12.0; else echo v${node}; fi; exit 0; fi\nexec ${quote(process.execPath)} "$@"`;
  if (!missingNode) await executable('node', nodeBody);
  await executable('git', `printf 'git %s\\n' "$*" >> ${quote(log)}\nif [ "$1" = --version ]; then ${git ? ':' : `[ -f ${quote(state)} ] || exit 1`}; fi\nexec ${quote(realGit)} "$@"`);
  await executable('pkg', `printf 'pkg %s\\n' "$*" >> ${quote(log)}\n${pkgFailure ? 'exit 1' : `: > ${quote(state)}`}`);
  // This PATH deliberately contains only the selected dependencies. Missing
  // dependencies can therefore be tested even on a developer's configured PC.
  const invoke = input => new Promise((resolve, reject) => {
    const child = spawn(shell, [], { cwd: home, windowsHide: true, stdio: 'pipe', env: { ...process.env, HOME: home, PREFIX: home, TERMUX_VERSION: 'fixture', PATH: posix(bin), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('安装器未及时退出')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    // Source with stdin redirected to a separate answer file, reproducing the
    // sh -c command's separation of program text and interactive input.
    write(home, 'answers', input).then(() => child.stdin.end(`PATH=${quote(posix(bin))}; export PATH\n. ${quote(script)} < ${quote(path.join(home, 'answers'))}\n`), reject);
  });
  const commands = () => readFile(log, 'utf8').catch(() => '');
  return { home, bin, log, state, executable, invoke, commands };
}

for (const version of ['20.18.0', '22.13.9']) test(`Node ${version} 低于最低要求，选择 0 不修改依赖`, async t => {
  const f = await fixture(t, { node: version });
  const result = await f.invoke('0\n');
  assert.equal(result.code, 0, result.stdout + result.stderr + await f.commands());
  assert.match(result.stdout, /1  更新 Node.js/);
  assert.doesNotMatch(await f.commands(), /pkg|clone/);
  await assert.rejects(lstat(path.join(f.home, '.local')), { code: 'ENOENT' });
});

test('Node 缺失时只有按数字才安装，EOF 正常结束', async t => {
  const f = await fixture(t, { missingNode: true });
  const result = await f.invoke('');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /✕ 未安装/);
  assert.match(result.stdout, /1  安装 Node.js/);
  assert.equal(await f.commands(), '');
});

test('Node 满足最低要求时不升级，Git 不可用且选择 0 时不安装', async t => {
  const f = await fixture(t, { node: '22.14.0', git: false });
  const result = await f.invoke('0\n');
  assert.equal(result.code, 0, result.stdout + result.stderr + await f.commands());
  assert.match(result.stdout, /✓ Node.js v22.14.0 可用/);
  assert.match(result.stdout, /1  安装 Git/);
  assert.doesNotMatch(await f.commands(), /pkg|clone/);
});

test('包管理器失败时明确停止，不执行全局升级或继续 clone', async t => {
  const f = await fixture(t, { node: '20.18.0', pkgFailure: true });
  const result = await f.invoke('1\n');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /包管理器安装失败/);
  assert.match(await f.commands(), /pkg install -y nodejs-lts/);
  assert.doesNotMatch(await f.commands(), /upgrade|clone/);
});

test('依赖安装返回成功但版本仍不满足要求时不继续', async t => {
  const f = await fixture(t, { missingNode: true });
  const result = await f.invoke('1\n');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /安装后仍未满足/);
  assert.match(await f.commands(), /pkg install -y nodejs-lts/);
});

test('首次安装自动启动，重复安装仅选择启动且不 fetch/pull/重装依赖', async t => {
  const f = await fixture(t);
  // Add only the POSIX tools used after dependency checks.
  for (const name of ['mkdir', 'dirname']) await f.executable(name, `exec /usr/bin/${name} "$@"`);
  await write(f.home, 'bin/sh', '#!/bin/sh\nexec /bin/sh "$@"\n');
  await chmod(path.join(f.home, 'bin/sh'), 0o755);
  const repo = await repository(t, { name: 'baicaigaga' });
  for (const file of ['install.mjs', 'src/environment.mjs', 'src/errors.mjs']) await write(repo.seed, file, await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  await write(repo.seed, 'src/cli.mjs', '// identity fixture');
  await write(repo.seed, 'bin/baicaigaga.mjs', 'console.log("HELPER_STARTED");\n');
  command(repo.seed, 'add', 'install.mjs', 'src', 'bin');
  command(repo.seed, 'commit', '-m', 'installer fixture');
  command(repo.seed, 'push', 'origin', 'main');
  await write(f.home, 'gitconfig', `[url "${repo.remote.replaceAll('\\', '/')}"]\n\tinsteadOf = https://github.com/Yuyayun/baicaigaga.git\n`);
  const first = await f.invoke('');
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /HELPER_STARTED/);
  const target = path.join(f.home, '.local/share/baicaigaga');
  const head = command(target, 'rev-parse', 'HEAD');
  const before = await f.commands();
  const second = await f.invoke('1\n');
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /✓ 已安装/);
  assert.match(second.stdout, /HELPER_STARTED/);
  assert.equal(command(target, 'rev-parse', 'HEAD'), head);
  assert.doesNotMatch((await f.commands()).slice(before.length), /clone|fetch|pull|merge|pkg /);
  assert.doesNotMatch(await f.commands(), /pkg |upgrade/);
  assert.doesNotMatch(first.stdout + second.stdout, /\x1b/);
});

test('未知安装目录不覆盖或清除', async t => {
  const f = await fixture(t);
  const target = path.join(f.home, '.local/share/baicaigaga');
  await write(target, 'unknown.txt', 'KEEP');
  const result = await f.invoke('');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /目录冲突或非目标仓库/);
  assert.equal(await readFile(path.join(target, 'unknown.txt'), 'utf8'), 'KEEP');
  assert.doesNotMatch(await f.commands(), /clone|pull|fetch|pkg /);
});

test('助手安装路径经过链接进入前端时在 clone 前停止', async t => {
  const f = await fixture(t);
  const frontend = path.join(f.home, 'boxed-lllllabc');
  await mkdir(frontend);
  await mkdir(path.join(f.home, '.local'));
  await symlink(frontend, path.join(f.home, '.local/share'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.invoke('');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /安装路径异常或位于箱装前后端/);
  assert.doesNotMatch(await f.commands(), /clone/);
  await assert.rejects(lstat(path.join(frontend, 'baicaigaga')), { code: 'ENOENT' });
});
