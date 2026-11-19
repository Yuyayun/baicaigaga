import { createInterface, cursorTo, clearScreenDown } from 'node:readline';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { inspectEnvironment, discover, configPath, readConfig, saveConfig, expandHome, assertIndependent } from './environment.mjs';
import { repositoryStatus, listBranches, switchBranch, checkHelperUpdate, updateHelper, withGitSignal } from './git.mjs';
import { installBackend } from './backend.mjs';
import { readSettings, toggleSetting } from './settings.mjs';
import { describe, plain, UserError } from './errors.mjs';

class Exit extends Error {}

export class Prompt {
  constructor(input = process.stdin, output = process.stdout, onInterrupt = () => {}) {
    this.output = output;
    this.terminal = Boolean(input.isTTY && output.isTTY && process.env.TERM !== 'dumb');
    this.temporaryScreen = false;
    this.reader = createInterface({ input, output, terminal: this.terminal, crlfDelay: Infinity });
    this.reader.setPrompt('');
    this.iterator = this.reader[Symbol.asyncIterator]();
    this.reader.on('SIGINT', () => { onInterrupt(); this.close(); });
  }
  async ask(question) {
    if (this.terminal) {
      this.reader.setPrompt(question);
      this.reader.prompt();
    } else this.output.write(question);
    const answer = await this.iterator.next();
    if (answer.done) throw new Exit();
    return answer.value.trim();
  }
  async menu(render, { accept, invalid, question = '请选择：' }) {
    if (this.temporaryScreen) throw new Error('不能嵌套显示临时菜单');
    try {
      if (this.terminal) {
        // Alternate screens preserve the operation transcript without counting
        // wrapped rows, including Chinese text and menus taller than the viewport.
        this.temporaryScreen = true;
        this.output.write('\x1b[?1049h');
        cursorTo(this.output, 0, 0);
        clearScreenDown(this.output);
      }
      await render();
      for (;;) {
        const value = await this.ask(question);
        if (accept(value)) return value;
        this.output.write(`${invalid}\n`);
      }
    } finally {
      this.restoreScreen();
    }
  }
  restoreScreen() {
    if (this.temporaryScreen) {
      this.temporaryScreen = false;
      this.output.write('\x1b[?1049l');
    }
  }
  async waitForReturn() {
    if (this.terminal) await this.ask('\n按回车返回主菜单：');
  }
  close() { this.restoreScreen(); this.reader.close(); }
}

export async function locate({ helper, prompt, print, home, cwd, file, useSaved = true }) {
  const accept = async environment => {
    assertIndependent(helper, environment);
    await saveConfig(environment.root, file);
    print(`✓ 已确认并保存 SillyTavern：${plain(environment.root)}`);
    return environment;
  };
  if (useSaved) {
    let saved;
    try { saved = await readConfig(file); } catch (error) { print(describe(error)); }
    if (saved) {
      const info = await inspectEnvironment(saved);
      if (info) {
        assertIndependent(helper, info);
        return info;
      }
      print(`已保存的 SillyTavern 路径失效：\n${plain(saved)}\n现在重新定位。`);
    }
  }
  print('正在检查当前目录、父目录及 HOME 下的有限浅层候选目录……');
  const candidates = (await discover({ cwd, home })).filter(info => {
    try { assertIndependent(helper, info); return true; } catch { return false; }
  });
  if (candidates.length === 1) return accept(candidates[0]);
  if (candidates.length > 1) {
    print('\n找到多个有效的 SillyTavern：');
    candidates.forEach((info, i) => print(`${i + 1}. ${plain(info.root)}`));
    print('m. 手动输入路径\n0. 返回');
    for (;;) {
      const value = await prompt.ask('请选择：');
      if (value === '0') return null;
      if (value.toLowerCase() === 'm') break;
      const selected = numericChoice(value, candidates.length);
      if (selected !== null) return accept(candidates[selected]);
      print('请输入列表中的编号、m 或 0。');
    }
  } else print('未找到有效的 SillyTavern 根目录，可手动输入路径。');
  for (;;) {
    const value = await prompt.ask('请输入 SillyTavern 根目录（可使用 ~，输入 0 返回）：');
    if (value === '0') return null;
    if (!value) continue;
    const info = await inspectEnvironment(expandHome(value, home));
    if (!info) {
      print('此路径未通过确认。请检查 SillyTavern 根目录的 package.json 和 server.js。');
      continue;
    }
    try { return await accept(info); } catch (error) { print(describe(error)); }
  }
}

function numericChoice(value, size) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= size ? number - 1 : null;
}

const divider = '──────────────────────────────────';
function title(print, heading) { print(`\n${divider}\n  ${heading}\n${divider}\n`); }
function component(state, version) {
  return state === 'installed' ? plain(version) : state === 'missing' ? '未安装' : '⚠ 目录或元数据异常';
}

async function showStatus(environment, print) {
  title(print, '箱装小助手 · baicaigaga');
  if (!environment) {
    print('尚未定位 SillyTavern，请选择“重新定位 SillyTavern”。');
    return null;
  }
  const current = await inspectEnvironment(environment.root);
  if (!current) {
    print('✕ SillyTavern 路径失效，请重新定位。');
    return null;
  }
  print(`  SillyTavern    ✓ 已定位\n\n${plain(current.root)}\n\n  箱装辣白菜\n  前端    ${component(current.frontendState, current.frontendVersion)}\n  后端    ${component(current.backendState, current.backendVersion)}`);
  if (current.backendState === 'installed') try {
    const status = await repositoryStatus(current.backend);
    print(`  分支    ${plain(status.branch ?? '游离 HEAD（未处于分支）')}`);
    print(status.changes.length ? `  状态    ⚠ 工作区存在修改\n${status.changes.join('\n')}` : '  状态    ✓ 工作区干净');
  } catch (error) {
    print(`  状态    ⚠ Git 仓库异常\n${describe(error)}`);
  }
  return current;
}

async function selectBranch(environment, prompt, print) {
  if (!environment) throw new UserError('请先重新定位 SillyTavern。');
  environment = await inspectEnvironment(environment.root);
  if (!environment || environment.backendState !== 'installed') throw new UserError('后端未安装或元数据异常，请先进入“安装 / 管理服务器插件”。');
  print('正在检查工作区并获取 origin 远端分支……');
  const choices = await listBranches(environment.backend);
  if (!choices.length) throw new UserError('仓库中没有可用分支。');
  const value = await prompt.menu(() => {
    title(print, '请选择后端分支：');
    const width = String(choices.length).length;
    choices.forEach((item, index) => print(`  ${String(index + 1).padStart(width)}  ${plain(item.name)}${item.current ? '  ← 当前' : ''}${!item.local ? '  （远端，将建立本地跟踪分支）' : !item.remote ? '  （本地）' : ''}`));
    print(`\n  ${'0'.padStart(width)}  返回`);
  }, {
    accept: value => value === '0' || numericChoice(value, choices.length) !== null,
    invalid: '请输入列表中的编号或 0。',
  });
  if (value === '0') return false;
  const result = await switchBranch(environment.backend, choices[numericChoice(value, choices.length)]);
  print(`\n✓ 已切换至 ${plain(result.branch)}\n✓ 当前版本：${plain(result.version)}\n✓ 工作区干净`);
  if (result.ahead) print('提示：本地分支领先远端，已保留本地提交。');
  if (result.missingUpstream) print('提示：原上游分支已不存在，已切换到保留的本地分支。');
  print('\n请重启 SillyTavern 以加载当前版本。');
  return true;
}

export async function run(options = {}) {
  const controller = new AbortController();
  return withGitSignal(controller.signal, () => runSession({ ...options, controller }));
}

async function currentEnvironment(environment) {
  const current = environment && await inspectEnvironment(environment.root);
  if (!current) throw new UserError('请先重新定位有效的 SillyTavern 根目录。');
  return current;
}

async function manageBackend(environment, prompt, print) {
  const current = await currentEnvironment(environment);
  const missing = current.backendState === 'missing';
  const choice = await prompt.menu(async () => {
    title(print, '服务器插件管理');
    print(`  状态    ${missing ? '未安装' : current.backendState === 'installed' ? '✓ 已安装' : '⚠ 目录或元数据异常'}\n\n  位置\n${plain(current.backend)}\n`);
    if (current.backendState === 'installed') {
      print(`  版本    ${plain(current.backendVersion)}`);
      try {
        const status = await repositoryStatus(current.backend);
        print(`  分支    ${plain(status.branch ?? '游离 HEAD')}\n  工作区  ${status.changes.length ? '⚠ 存在修改' : '✓ 干净'}`);
        if (status.changes.length) print(status.changes.join('\n'));
      } catch (error) { print(`⚠ Git 仓库异常\n${describe(error)}`); }
    } else if (!missing) print(`请人工检查现有目录，助手不会覆盖。\n${plain(current.backendDetail ?? '')}`);
    print(`\n${divider}\n${missing ? '  1  安装服务器插件\n' : ''}  0  返回\n`);
  }, { accept: value => value === '0' || (missing && value === '1'), invalid: missing ? '请输入 1 或 0。' : '请输入 0 返回。' });
  if (choice === '0') return false;
  print('正在安装服务器插件……');
  const result = await installBackend(current.root);
  print(`✓ 服务器插件已安装\n\n  版本    ${plain(result.version)}\n  分支    ${plain(result.branch)}\n  状态    ✓ 工作区干净`);
  try {
    if (!(await readSettings(current.root)).enableServerPlugins.value) print('\n提示：SillyTavern 当前未启用服务器插件。\n可在“酒馆服务器插件设置”中修改。');
  } catch (error) { print(`\n⚠ 无法读取服务器插件设置\n${describe(error)}`); }
  return true;
}

async function settingsPage(environment, prompt, print) {
  const current = await currentEnvironment(environment);
  let message = '';
  for (;;) {
    const settings = await readSettings(current.root);
    const keys = Object.keys(settings);
    const choice = await prompt.menu(() => {
      title(print, '酒馆服务器插件设置');
      for (const key of keys) {
        const setting = settings[key];
        print(`  ${key}\n  当前    ${setting.value}${setting.explicit ? '' : '（默认）'}\n  作用    ${setting.description}\n`);
      }
      print('加载与自动更新是独立设置。修改后通常需要重启 SillyTavern。');
      if (message) print(`\n${message}`);
      print(`\n${divider}\n  1  修改 enableServerPlugins\n  2  修改 enableServerPluginsAutoUpdate\n\n  0  返回\n`);
    }, { accept: value => ['0', '1', '2'].includes(value), invalid: '请输入 0、1 或 2。' });
    if (choice === '0') return false;
    const key = keys[Number(choice) - 1];
    const result = await toggleSetting(current.root, key);
    message = `✓ ${key} 已修改为 ${result[key].value}`;
    print(message);
  }
}

async function helperUpdatePage(helper, prompt, print) {
  print('正在检查助手自身工作区并获取正式分支……');
  const checked = await checkHelperUpdate(helper);
  const choice = await prompt.menu(() => {
    title(print, '检查助手更新');
    print(`  当前版本    ${plain(checked.currentVersion)}\n  最新版本    ${plain(checked.remoteVersion)}\n`);
    print(checked.available ? `  发现新提交，可更新到 ${plain(checked.remoteVersion)}` : '  ✓ 当前已是最新版本');
    print(`\n${divider}\n${checked.available ? `  1  更新到 ${plain(checked.remoteVersion)}\n` : ''}  0  返回\n`);
  }, { accept: value => value === '0' || (checked.available && value === '1'), invalid: checked.available ? '请输入 1 或 0。' : '请输入 0 返回。' });
  if (choice === '0') return false;
  const result = await updateHelper(helper, checked);
  print(`✓ 箱装小助手已更新至 ${plain(result.remoteVersion)}\n\n正在重新启动……`);
  return true;
}

async function runSession({ helper, home = os.homedir(), cwd = process.cwd(), input = process.stdin, output = process.stdout, controller }) {
  const print = value => output.write(`${value}\n`);
  const prompt = new Prompt(input, output, () => controller.abort());
  const interrupt = () => { controller.abort(); prompt.close(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const file = configPath(home);
  try {
    helper = await realpath(helper);
    let environment = await locate({ helper, prompt, print, home, cwd, file });
    for (;;) {
      if (controller.signal.aborted) throw new Exit();
      const choice = await prompt.menu(async () => {
        environment = await showStatus(environment, print);
        if (controller.signal.aborted) throw new Exit();
        print(`\n${divider}\n  1  安装 / 管理服务器插件\n  2  酒馆服务器插件设置\n  3  切换后端分支\n  4  检查助手更新\n  5  重新定位 SillyTavern\n\n  0  退出\n`);
      }, { accept: value => ['0', '1', '2', '3', '4', '5'].includes(value), invalid: '请输入 0 到 5 的菜单编号。' });
      if (choice === '0') break;
      let showResult = false;
      try {
        if (choice === '1') showResult = await manageBackend(environment, prompt, print);
        else if (choice === '2') showResult = await settingsPage(environment, prompt, print);
        else if (choice === '3') showResult = await selectBranch(environment, prompt, print);
        else if (choice === '4') {
          if (await helperUpdatePage(helper, prompt, print)) return { restart: true, helper };
        } else if (choice === '5') {
          const found = await locate({ helper, prompt, print, home, cwd, file, useSaved: false });
          if (found) environment = found;
          showResult = Boolean(found);
        }
      } catch (error) {
        if (controller.signal.aborted) throw new Exit();
        if (error instanceof Exit) throw error;
        print(`\n${describe(error)}`);
        showResult = true;
      }
      if (showResult) await prompt.waitForReturn();
    }
  } catch (error) {
    if (!(error instanceof Exit) && !controller.signal.aborted) throw error;
  } finally {
    prompt.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  print('\n助手已退出。');
}
