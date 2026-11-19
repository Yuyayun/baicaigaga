import { readFile, realpath, readdir, stat, lstat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { UserError } from './errors.mjs';

export const FRONTEND = 'public/scripts/extensions/third-party/boxed-lllllabc';
export const BACKEND = 'plugins/boxed-lllllabc-server';

export async function jsonFile(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function expandHome(input, home = os.homedir()) {
  const value = input.trim().replace(/^(["'])(.*)\1$/, '$2');
  return value === '~' ? home : /^~[\\/]/.test(value) ? path.join(home, value.slice(2)) : path.resolve(value);
}

export async function inspectEnvironment(candidate) {
  try {
    const root = await realpath(candidate);
    const [host, server] = await Promise.all([
      jsonFile(path.join(root, 'package.json')),
      stat(path.join(root, 'server.js')),
    ]);
    if (host.name?.toLowerCase() !== 'sillytavern' || !server.isFile()) return null;
    const inspect = async (relative, metadata, valid) => {
      const directory = path.join(root, relative);
      try { await lstat(directory); } catch (error) {
        return { directory, state: error.code === 'ENOENT' ? 'missing' : 'invalid', detail: error.message };
      }
      try {
        const canonical = await realpath(directory);
        if (!contains(root, canonical) || !(await stat(canonical)).isDirectory()) throw new Error('目录越出酒馆根目录或不是目录');
        const pkg = await jsonFile(path.join(canonical, metadata));
        if (!valid(pkg)) throw new Error('项目名称、版本或入口元数据异常');
        return { directory: canonical, state: 'installed', version: pkg.version };
      } catch (error) { return { directory, state: 'invalid', detail: error.message }; }
    };
    const [front, back] = await Promise.all([
      inspect(FRONTEND, 'manifest.json', pkg => pkg.display_name === '箱装辣白菜' && typeof pkg.version === 'string' && pkg.version && pkg.js),
      inspect(BACKEND, 'package.json', pkg => pkg.name === 'boxed-lllllabc-server' && typeof pkg.version === 'string' && pkg.version),
    ]);
    if (contains(front.directory, back.directory) || contains(back.directory, front.directory)) {
      front.state = back.state = 'invalid';
      front.detail = back.detail = '前后端目录重叠，已停止相关操作，请人工检查目录链接。';
    }
    return { root, frontend: front.directory, backend: back.directory,
      frontendState: front.state, backendState: back.state,
      frontendVersion: front.version, backendVersion: back.version,
      frontendDetail: front.detail, backendDetail: back.detail };
  } catch {
    return null;
  }
}

// Only directory entries under HOME, at most three levels deep. Never follow symlinks.
export async function discover({ cwd = process.cwd(), home = os.homedir(), maxDepth = 3, maxDirs = 240, maxEntries = 3000 } = {}) {
  const found = new Map();
  const checked = new Set();
  const check = async candidate => {
    const key = path.resolve(candidate);
    if (checked.has(key)) return false;
    checked.add(key);
    const info = await inspectEnvironment(key);
    if (info) found.set(info.root, info);
    return Boolean(info);
  };
  for (let current = path.resolve(cwd);; current = path.dirname(current)) {
    await check(current);
    if (path.dirname(current) === current) break;
  }
  for (const candidate of ['SillyTavern', 'sillytavern', 'st/SillyTavern', 'apps/SillyTavern', '.local/share/SillyTavern']) {
    await check(path.join(home, candidate));
  }
  const queue = [{ dir: home, depth: 0 }];
  const skip = new Set(['node_modules', 'storage', 'Downloads', 'Android', 'data', 'backups']);
  let dirs = 0;
  let entriesSeen = 0;
  for (let index = 0; index < queue.length && dirs < maxDirs && entriesSeen < maxEntries; index++) {
    const { dir, depth } = queue[index];
    dirs++;
    if (await check(dir) || depth >= maxDepth) continue;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++entriesSeen > maxEntries) break;
      if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue;
      if (queue.length >= maxDirs) break;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root));
}

export function configPath(home = os.homedir()) {
  return path.join(home, '.config', 'baicaigaga', 'config.json');
}

export async function readConfig(file = configPath()) {
  try {
    const config = await jsonFile(file);
    if (typeof config.sillyTavernRoot !== 'string' || !path.isAbsolute(config.sillyTavernRoot)) {
      throw new Error('配置中的 SillyTavern 路径不是绝对路径');
    }
    return config.sillyTavernRoot;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new UserError(`无法读取配置：${file}。请重新定位 SillyTavern。`, error.message);
  }
}

export async function atomicWrite(file, contents, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function saveConfig(root, file = configPath()) {
  await atomicWrite(file, `${JSON.stringify({ sillyTavernRoot: root }, null, 2)}\n`);
}

export function assertIndependent(helper, environment) {
  for (const directory of [environment.frontend, environment.backend]) {
    if (contains(directory, helper) || contains(helper, directory)) {
      throw new UserError('助手必须放在独立目录中，不能与箱装前端或后端目录重叠。请使用 ~/.local/share/baicaigaga。');
    }
  }
}
