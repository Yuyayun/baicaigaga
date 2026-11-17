import { realpath, readFile, lstat, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite, jsonFile } from './src/environment.mjs';
import { UserError, describe } from './src/errors.mjs';

const MARKER = '# baicaigaga managed command v1';
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

async function rejectPluginLocation(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    let pkg;
    try { pkg = await jsonFile(path.join(current, 'package.json')); } catch { /* Not a package directory. */ }
    if (['boxed-lllllabc', 'boxed-lllllabc-server'].includes(pkg?.name) || ['boxed-lllllabc', 'boxed-lllllabc-server'].includes(path.basename(current))) {
      throw new UserError('助手及命令入口必须独立于箱装前后端，请使用 ~/.local/share/baicaigaga 安装目录。');
    }
    if (path.dirname(current) === current) break;
  }
}

export async function install({ helper = fileURLToPath(new URL('./', import.meta.url)), prefix = process.env.PREFIX, home = os.homedir(), node = process.execPath } = {}) {
  helper = await realpath(helper);
  await rejectPluginLocation(helper);
  if ((await jsonFile(path.join(helper, 'package.json'))).name !== 'baicaigaga') throw new UserError('无法确认助手安装目录。');
  const entry = path.join(helper, 'bin', 'baicaigaga.mjs');
  try { if (!(await stat(entry)).isFile()) throw new Error('not a file'); } catch { throw new UserError('助手入口文件缺失，请重新获取完整仓库。'); }
  const bin = prefix ? path.join(prefix, 'bin') : path.join(home, '.local', 'bin');
  await rejectPluginLocation(path.resolve(bin));
  const shell = prefix ? path.join(prefix, 'bin', 'sh') : '/bin/sh';
  const launcher = path.join(bin, 'baicaigaga');
  if (![shell, node, helper, launcher].every(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value))) throw new UserError('安装路径必须为不含换行符的绝对路径。');
  if (/\s/.test(shell)) throw new UserError('命令解释器路径不能包含空格。请检查 PREFIX。');
  try { if (!(await stat(shell)).isFile()) throw new Error('not a file'); } catch { throw new UserError(`找不到命令解释器：${shell}。请检查 Termux PREFIX。`); }
  try {
    const existing = await lstat(launcher);
    if (!existing.isFile() || !(await readFile(launcher, 'utf8')).split('\n').includes(MARKER)) throw new UserError(`命令入口已存在且不属于本助手，拒绝覆盖：${launcher}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const script = `#!${shell}\n${MARKER}\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
  await atomicWrite(launcher, script, 0o755);
  return { launcher, bin, needsPath: !prefix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await install();
    console.log(`✓ 已安装命令：${result.launcher}\n\n请输入：\nbaicaigaga`);
    if (result.needsPath) console.log(`\n请确认 ${result.bin} 已加入 PATH。`);
  } catch (error) {
    console.error(describe(error));
    process.exitCode = 1;
  }
}
