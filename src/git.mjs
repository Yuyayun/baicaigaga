import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.mjs';
import { jsonFile } from './environment.mjs';

const execute = promisify(execFile);
const context = new AsyncLocalStorage();
export const withGitSignal = (signal, action) => context.run(signal, action);
export const BACKEND_REPOSITORY = 'Yuyayun/boxed-lllllabc-server';
export const HELPER_REPOSITORY = 'Yuyayun/baicaigaga';

export function repositoryName(url) {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\s/?#]+\/[^\s/?#]+?)\/?$/i.exec(url.trim());
  return match ? match[1].replace(/\.git$/i, '').toLowerCase() : null;
}

export async function git(directory, args, message = 'Git 操作失败，已停止后续步骤。', allowFailure = false) {
  const signal = context.getStore();
  if (signal?.aborted) throw new UserError('操作已取消，已停止后续步骤。');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES)$/i.test(key)) delete env[key];
  }
  try {
    const result = await execute('git', [
      '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'submodule.recurse=false', '-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', ...args,
    ], { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal, killSignal: 'SIGINT' });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal?.aborted) throw new UserError('操作已取消，已停止后续步骤。');
    if (allowFailure && typeof error.code === 'number' && !error.killed) {
      return { ok: false, code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    if (error.code === 'ENOENT') throw new UserError('找不到 Git，请先在 Termux 执行：pkg install git');
    throw new UserError(message, error.stderr || error.message);
  }
}

async function output(directory, args, message) {
  return (await git(directory, args, message)).stdout.trim();
}

export async function validateRepository(directory, expected) {
  const canonical = await realpath(directory);
  const top = await output(directory, ['rev-parse', '--show-toplevel'], '此目录不是可用的 Git 工作区，已停止。');
  if (await realpath(top) !== canonical) throw new UserError('目录不是独立 Git 仓库的根目录，已停止，避免操作上层仓库。');
  const urls = (await output(directory, ['config', '--get-all', 'remote.origin.url'], '仓库缺少 origin 远端，无法确认仓库身份。')).split('\n');
  if (urls.length !== 1 || repositoryName(urls[0]) !== expected.toLowerCase()) {
    throw new UserError(`仓库身份不符：origin 必须指向 https://github.com/${expected}.git，已停止。`);
  }
}

export async function worktreeStatus(directory) {
  const result = await git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], '无法读取 Git 工作区状态，已停止。');
  const fields = result.stdout.split('\0').filter(Boolean);
  const lines = [];
  for (let i = 0; i < fields.length; i++) {
    const item = fields[i];
    const code = item.slice(0, 2);
    const file = JSON.stringify(item.slice(3));
    if (/[RC]/.test(code)) lines.push(`${code} ${JSON.stringify(fields[++i])} → ${file}`);
    else lines.push(`${code} ${file}`);
  }
  return lines;
}

async function ensureReady(directory) {
  const status = await worktreeStatus(directory);
  if (status.length) throw new UserError('工作区存在未提交修改，已停止。请自行处理后重试；助手不会自动暂存或覆盖。', status.join('\n'));
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock']) {
    const file = await output(directory, ['rev-parse', '--git-path', marker]);
    const exists = await stat(path.resolve(directory, file)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new UserError(`仓库存在未完成的 Git 操作或锁（${marker}），请自行处理后重试。`);
  }
  const flags = (await git(directory, ['ls-files', '-v', '-z'])).stdout.split('\0').filter(Boolean);
  if (flags.some(line => line[0] === 'S' || /[a-z]/.test(line[0]))) {
    throw new UserError('仓库存在跳过工作区检查的文件标记，无法可靠确认本地修改，已停止。请自行检查 sparse-checkout / skip-worktree / assume-unchanged。');
  }
}

export async function currentBranch(directory) {
  const result = await git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, true);
  if (result.ok) return result.stdout.trim();
  if (result.code === 1) return null;
  throw new UserError('无法读取当前分支，已停止。', result.stderr);
}

export async function repositoryStatus(directory, expected = BACKEND_REPOSITORY) {
  await validateRepository(directory, expected);
  const branch = await currentBranch(directory);
  const changes = await worktreeStatus(directory);
  return { branch, changes };
}

async function fetchOrigin(directory) {
  // Explicit refspec avoids a custom fetch configuration writing local branches.
  // Pruning affects remote-tracking refs only. Local branches are never fetch destinations.
  await git(directory, ['fetch', '--prune', '--no-prune-tags', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/*:refs/remotes/origin/*'],
    '获取远端分支失败，已停止。请检查网络、仓库访问权限或远端分支是否被改写。');
}

async function refs(directory) {
  const data = await output(directory, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream)', 'refs/heads/', 'refs/remotes/origin/']);
  return data ? data.split('\n').map(line => {
    const [ref, oid, upstream] = line.split('\0');
    return { ref, oid, upstream };
  }).filter(item => item.ref !== 'refs/remotes/origin/HEAD') : [];
}

export async function listBranches(directory) {
  await validateRepository(directory, BACKEND_REPOSITORY);
  await ensureReady(directory);
  await fetchOrigin(directory);
  const all = await refs(directory);
  const local = new Map(all.filter(item => item.ref.startsWith('refs/heads/')).map(item => [item.ref.slice(11), item]));
  const remote = new Map(all.filter(item => item.ref.startsWith('refs/remotes/origin/')).map(item => [item.ref.slice(20), item]));
  const branch = await currentBranch(directory);
  return [...new Set([...local.keys(), ...remote.keys()])].sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)).map(name => ({
    name, local: local.get(name) ?? null, remote: remote.get(name) ?? null, current: branch === name,
  }));
}

async function ancestor(directory, from, to) {
  const result = await git(directory, ['merge-base', '--is-ancestor', from, to], undefined, true);
  if (result.ok) return true;
  if (result.code === 1) return false;
  throw new UserError('无法判断分支历史关系，已停止。请检查仓库是否完整。', result.stderr);
}

async function relation(directory, local, remote) {
  if (local === remote) return 'equal';
  if (await ancestor(directory, local, remote)) return 'behind';
  if (await ancestor(directory, remote, local)) return 'ahead';
  throw new UserError('本地分支与远端已分叉，无法安全快进，已停止。请自行检查，助手不会自动合并或覆盖。');
}

async function checkTargetPackage(directory, oid, expected) {
  let pkg;
  try {
    pkg = JSON.parse(await output(directory, ['show', `${oid}:package.json`], '目标分支缺少 package.json，已停止。'));
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('目标分支的 package.json 无法解析，已停止。');
  }
  if (pkg.name !== expected || typeof pkg.version !== 'string' || !pkg.version) throw new UserError('目标分支的项目名称或版本不符合预期，已停止。');
  return pkg.version;
}

async function protectIgnoredFiles(directory, target) {
  const ignored = (await git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  if (!ignored.length) return;
  const tracked = (await git(directory, ['ls-tree', '-r', '--name-only', '-z', target])).stdout.split('\0').filter(Boolean);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const targetPaths = new Set(tracked.map(normalize));
  const targetDirectories = new Set();
  for (const file of targetPaths) {
    for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) targetDirectories.add(parent);
  }
  const collisions = ignored.filter(file => {
    const normalized = normalize(file);
    if (targetPaths.has(normalized) || targetDirectories.has(normalized)) return true;
    for (let parent = path.posix.dirname(normalized); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (targetPaths.has(parent)) return true;
    }
    return false;
  });
  if (collisions.length) throw new UserError('目标分支可能覆盖被 Git 忽略的本地文件，已停止。请自行处理。', collisions.map(file => JSON.stringify(file)).join('\n'));
}

export async function switchBranch(directory, selection) {
  await validateRepository(directory, BACKEND_REPOSITORY);
  await ensureReady(directory);
  const all = await refs(directory);
  const get = ref => all.find(item => item.ref === ref);
  const local = get(`refs/heads/${selection.name}`);
  const remote = get(`refs/remotes/origin/${selection.name}`);
  if (local?.oid !== selection.local?.oid || remote?.oid !== selection.remote?.oid || local?.upstream !== selection.local?.upstream) {
    throw new UserError('分支列表显示后仓库引用发生变化，请重新获取分支列表。');
  }
  if (!local && !remote) throw new UserError('所选分支已不存在，请重新获取分支列表。');
  let upstream = remote;
  if (local?.upstream) {
    if (!local.upstream.startsWith('refs/remotes/origin/')) throw new UserError('所选分支跟踪的不是 origin 远端，已停止。请自行确认跟踪关系。');
    upstream = get(local.upstream);
  }
  const state = local && upstream ? await relation(directory, local.oid, upstream.oid) : 'equal';
  const target = local && state !== 'behind' ? local.oid : upstream.oid;
  await checkTargetPackage(directory, target, 'boxed-lllllabc-server');
  await protectIgnoredFiles(directory, target);
  if (local) {
    await git(directory, ['switch', '--no-guess', '--no-overwrite-ignore', selection.name], '无法切换分支，已停止。请检查其他工作树占用、文件权限或本地文件冲突。');
  } else {
    await git(directory, ['switch', '--no-overwrite-ignore', '--track', '-c', selection.name, remote.ref], '无法建立并切换本地跟踪分支，已停止。');
  }
  if (state === 'behind') {
    await git(directory, ['merge', '--ff-only', '--no-edit', upstream.oid], '快进更新失败，已停止。请检查当前分支及工作区状态。');
  }
  const result = await repositoryStatus(directory);
  const version = (await jsonFile(path.join(directory, 'package.json'))).version;
  const head = await output(directory, ['rev-parse', 'HEAD']);
  if (result.branch !== selection.name || result.changes.length || head !== target) throw new UserError('切换后的分支、提交或工作区状态与预期不符，请自行检查。');
  return { ...result, version, ahead: state === 'ahead', missingUpstream: Boolean(local?.upstream && !upstream) };
}

export async function updateHelper(directory) {
  await validateRepository(directory, HELPER_REPOSITORY);
  await ensureReady(directory);
  if (await currentBranch(directory) !== 'main') throw new UserError('助手自身必须位于 main 正式分支才能自动更新，请自行确认分支后重试。');
  await fetchOrigin(directory);
  const remote = (await refs(directory)).find(item => item.ref === 'refs/remotes/origin/main');
  if (!remote) throw new UserError('助手远端缺少 main 正式分支，已停止。');
  const head = await output(directory, ['rev-parse', 'HEAD']);
  const currentVersion = (await jsonFile(path.join(directory, 'package.json'))).version;
  const remoteVersion = await checkTargetPackage(directory, remote.oid, 'baicaigaga');
  const state = await relation(directory, head, remote.oid);
  if (state === 'ahead') throw new UserError('助手本地包含尚未发布到 origin/main 的提交，已停止。请自行检查。');
  if (state === 'equal') return { updated: false, currentVersion, remoteVersion };
  await protectIgnoredFiles(directory, remote.oid);
  await ensureReady(directory);
  if (await currentBranch(directory) !== 'main' || await output(directory, ['rev-parse', 'HEAD']) !== head) throw new UserError('更新前助手分支发生变化，已停止。');
  await git(directory, ['merge', '--ff-only', '--no-edit', remote.oid], '助手快进更新失败，已停止。请检查工作区。');
  const result = await repositoryStatus(directory, HELPER_REPOSITORY);
  if (result.branch !== 'main' || result.changes.length || await output(directory, ['rev-parse', 'HEAD']) !== remote.oid) throw new UserError('助手更新后的状态与预期不符，请自行检查。');
  return { updated: true, currentVersion, remoteVersion };
}
