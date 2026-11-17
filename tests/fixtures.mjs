import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FRONTEND, BACKEND } from '../src/environment.mjs';
import { contains } from '../src/environment.mjs';

export function assertTemporaryPath(target, root) {
  const resolvedRoot = path.resolve(root);
  if (path.dirname(resolvedRoot) !== path.resolve(tmpdir()) || !path.basename(resolvedRoot).startsWith('baicaigaga-') || !contains(resolvedRoot, path.resolve(target))) {
    throw new Error(`Refusing filesystem operation outside fixture: ${target}`);
  }
}

export function command(directory, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'baicaigaga-'));
  t.after(() => {
    assertTemporaryPath(directory, directory);
    return rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export async function write(directory, file, contents) {
  const target = path.join(directory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

export async function environment(root) {
  await write(root, 'package.json', { name: 'sillytavern', version: '1.16.0' });
  await write(root, 'server.js', '// fixture\n');
  await write(root, `${FRONTEND}/manifest.json`, { display_name: '箱装辣白菜', js: 'index.js', version: '1.0.1' });
  await write(root, `${FRONTEND}/index.js`, '// FRONTEND MUST STAY UNTOUCHED\n');
  await write(root, `${BACKEND}/package.json`, { name: 'boxed-lllllabc-server', version: '1.0.1' });
  return { root, frontend: path.join(root, FRONTEND), backend: path.join(root, BACKEND) };
}

export async function repository(t, { name = 'boxed-lllllabc-server', root } = {}) {
  const base = root ?? await temporary(t);
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  await mkdir(seed, { recursive: true });
  command(base, 'init', '--bare', '--initial-branch=main', remote);
  command(seed, 'init', '--initial-branch=main');
  command(seed, 'config', 'user.name', 'Test');
  command(seed, 'config', 'user.email', 'test@example.invalid');
  command(seed, 'config', 'core.autocrlf', 'false');
  await write(seed, 'package.json', { name, version: '1.0.0' });
  await write(seed, 'plugin.mjs', '// initial\n');
  await write(seed, '.gitignore', 'ignored.txt\nignored-dir/\n');
  command(seed, 'add', 'package.json', 'plugin.mjs', '.gitignore');
  command(seed, 'commit', '-m', 'initial');
  command(seed, 'remote', 'add', 'origin', remote);
  command(seed, 'push', 'origin', 'main');
  command(base, 'clone', remote, work);
  command(work, 'config', 'user.name', 'Test');
  command(work, 'config', 'user.email', 'test@example.invalid');
  command(work, 'config', 'core.autocrlf', 'false');
  const official = `https://github.com/Yuyayun/${name}.git`;
  command(work, 'remote', 'set-url', 'origin', official);
  // Use Git's normal URL rewriting for local, offline network fixtures.
  command(work, 'config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, official);
  return { base, remote, seed, work, name };
}

export async function commitVersion(repo, branch, version = '1.0.1', file = 'plugin.mjs', text = '// updated\n') {
  if (command(repo.seed, 'branch', '--list', branch)) command(repo.seed, 'switch', branch);
  else command(repo.seed, 'switch', '-c', branch);
  await write(repo.seed, 'package.json', { name: repo.name, version });
  await write(repo.seed, file, text);
  command(repo.seed, 'add', 'package.json', file);
  command(repo.seed, 'commit', '-m', `version ${version}`);
  command(repo.seed, 'push', 'origin', branch);
}
