import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { inspectEnvironment, discover, configPath, readConfig, saveConfig, expandHome, assertIndependent } from './environment.mjs';
import { repositoryStatus, listBranches, switchBranch, updateHelper, withGitSignal } from './git.mjs';
import { describe, plain, UserError } from './errors.mjs';

class Exit extends Error {}

export class Prompt {
  constructor(input = process.stdin, output = process.stdout, onInterrupt = () => {}) {
    this.output = output;
    this.reader = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), crlfDelay: Infinity });
    this.iterator = this.reader[Symbol.asyncIterator]();
    this.reader.on('SIGINT', () => { onInterrupt(); this.reader.close(); });
  }
  async ask(question) {
    this.output.write(question);
    const answer = await this.iterator.next();
    if (answer.done) throw new Exit();
    return answer.value.trim();
  }
  close() { this.reader.close(); }
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
      print(`已保存的路径失效或缺少箱装前后端：${plain(saved)}\n现在重新定位。`);
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
  } else print('未找到有效目录。需要 SillyTavern 及箱装前端、后端均已安装。');
  for (;;) {
    const value = await prompt.ask('请输入 SillyTavern 根目录（可使用 ~，输入 0 返回）：');
    if (value === '0') return null;
    if (!value) continue;
    const info = await inspectEnvironment(expandHome(value, home));
    if (!info) {
      print('此路径未通过确认。请检查 SillyTavern 的 package.json、server.js，以及箱装前端 manifest.json 和后端 package.json。');
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

async function showStatus(environment, print) {
  print('\n箱装辣白菜测试助手\n');
  if (!environment) {
    print('尚未定位 SillyTavern，请选择“重新定位 SillyTavern”。');
    return null;
  }
  const current = await inspectEnvironment(environment.root);
  if (!current) {
    print('SillyTavern 路径失效或箱装前后端信息不完整，请重新定位。');
    return null;
  }
  print(`SillyTavern：\n${plain(current.root)}\n\n前端：\n${plain(current.frontend)}\n版本：${plain(current.frontendVersion)}\n✓ 已确认\n\n后端：\n${plain(current.backend)}`);
  try {
    const status = await repositoryStatus(current.backend);
    print(`分支：${plain(status.branch ?? '游离 HEAD（未处于分支）')}\n版本：${plain(current.backendVersion)}`);
    print(status.changes.length ? `⚠ 工作区存在修改：\n${status.changes.join('\n')}` : '✓ 工作区干净');
  } catch (error) {
    print(`版本：${plain(current.backendVersion)}\n${describe(error)}`);
  }
  return current;
}

async function selectBranch(environment, prompt, print) {
  if (!environment) throw new UserError('请先重新定位 SillyTavern。');
  print('正在检查工作区并获取 origin 远端分支……');
  const choices = await listBranches(environment.backend);
  if (!choices.length) throw new UserError('仓库中没有可用分支。');
  print('\n请选择后端分支：\n');
  choices.forEach((item, index) => print(`${index + 1}. ${plain(item.name)}${item.current ? '  ← 当前' : ''}${!item.local ? '  （远端，将建立本地跟踪分支）' : !item.remote ? '  （本地）' : ''}`));
  print('\n0. 返回');
  for (;;) {
    const value = await prompt.ask('请选择：');
    if (value === '0') return;
    const index = numericChoice(value, choices.length);
    if (index === null) { print('请输入列表中的编号或 0。'); continue; }
    const result = await switchBranch(environment.backend, choices[index]);
    print(`\n✓ 已切换至 ${plain(result.branch)}\n✓ 当前版本：${plain(result.version)}\n✓ 工作区干净`);
    if (result.ahead) print('提示：本地分支领先远端，已保留本地提交。');
    if (result.missingUpstream) print('提示：原上游分支已不存在，已切换到保留的本地分支。');
    print('\n请重启 SillyTavern 后进行测试。');
    return;
  }
}

export async function run(options = {}) {
  const controller = new AbortController();
  return withGitSignal(controller.signal, () => runSession({ ...options, controller }));
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
      environment = await showStatus(environment, print);
      print('\n1. 切换后端分支\n2. 更新测试助手\n3. 重新定位 SillyTavern\n0. 退出\n');
      const choice = await prompt.ask('请选择：');
      if (choice === '0') break;
      try {
        if (choice === '1') await selectBranch(environment, prompt, print);
        else if (choice === '2') {
          print('正在检查助手自身工作区并获取正式分支……');
          const result = await updateHelper(helper);
          print(`当前版本：${plain(result.currentVersion)}\n远端版本：${plain(result.remoteVersion)}`);
          if (result.updated) {
            print('\n✓ 箱装辣白菜测试助手已更新\n\n请重新输入：\nbaicaigaga\n\n以使用新版。');
            break;
          }
          print('当前已是最新版本');
        } else if (choice === '3') {
          const found = await locate({ helper, prompt, print, home, cwd, file, useSaved: false });
          if (found) environment = found;
        } else print('请输入 0、1、2 或 3。');
      } catch (error) {
        if (controller.signal.aborted) throw new Exit();
        if (error instanceof Exit) throw error;
        print(`\n${describe(error)}`);
      }
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
