import { mkdir, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { inspectEnvironment, contains, BACKEND } from './environment.mjs';
import { git, repositoryStatus, BACKEND_REPOSITORY } from './git.mjs';
import { UserError } from './errors.mjs';

export async function installBackend(root, { execute = git } = {}) {
  const environment = await inspectEnvironment(root);
  if (!environment) throw new UserError('SillyTavern 根目录已失效，请重新定位。');
  const plugins = path.join(environment.root, 'plugins');
  const target = path.join(environment.root, BACKEND);
  try {
    // Refuse every existing entry, including empty directories and broken links.
    try { await lstat(target); throw new UserError('服务器插件目标目录已存在，拒绝覆盖。请人工检查。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(plugins, { recursive: true });
    if ((await lstat(plugins)).isSymbolicLink()) throw new UserError('plugins 目录是链接，无法确认安装边界，请人工检查。');
    if (!contains(environment.root, await realpath(plugins))) throw new UserError('plugins 目录越出酒馆根目录，已停止。');
    await access(plugins, constants.R_OK | constants.W_OK | constants.X_OK);
    // Exclusive reservation prevents a second install from using this directory.
    await mkdir(target);
    try {
      await execute(plugins, ['clone', '--no-local', '--branch', 'main', '--single-branch', '--origin', 'origin',
        `https://github.com/${BACKEND_REPOSITORY}.git`, '--', target],
      'GitHub 网络访问或 Git clone 失败。请检查网络、访问权限及磁盘空间；不完整目录请人工检查。');
      const installed = await inspectEnvironment(environment.root);
      if (installed?.backendState !== 'installed') throw new UserError('服务器插件 clone 不完整或 package.json 校验失败，请人工检查目标目录。');
      const status = await repositoryStatus(installed.backend);
      if (status.branch !== 'main' || status.changes.length) throw new UserError('安装后的分支或工作区校验失败，请人工检查。');
      return { ...status, version: installed.backendVersion };
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError('服务器插件安装未完成，请人工检查目标目录；助手不会删除或覆盖已有内容。', error.message);
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(['EACCES', 'EPERM'].includes(error.code) ? '权限不足，无法安装服务器插件。' : '目标目录冲突或无法访问 plugins，已停止安装。', error.message);
  }
}
