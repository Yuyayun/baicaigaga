import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Prompt, run } from '../src/cli.mjs';
import { temporary, environment, repository, commitVersion, assertTemporaryPath } from './fixtures.mjs';

const ENTER = '\x1b[?1049h';
const LEAVE = '\x1b[?1049l';
const options = { accept: value => ['0', '1'].includes(value), invalid: '请输入 0 或 1。' };

function streams(t, { inputTTY = true, outputTTY = true, term = 'xterm-256color', onInterrupt, createPrompt = true } = {}) {
  const previous = process.env.TERM;
  process.env.TERM = term;
  t.after(() => {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  });
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = inputTTY;
  input.setRawMode = () => {};
  output.isTTY = outputTTY;
  output.columns = 24;
  let transcript = '';
  output.on('data', data => { transcript += data; });
  const prompt = createPrompt ? new Prompt(input, output, onInterrupt) : null;
  t.after(() => { prompt?.close(); input.destroy(); output.destroy(); });
  const until = async (text, offset = 0) => {
    if (transcript.slice(offset).includes(text)) return;
    await new Promise((resolve, reject) => {
      const check = () => {
        if (!transcript.slice(offset).includes(text)) return;
        clearTimeout(timer);
        output.off('data', check);
        resolve();
      };
      const timer = setTimeout(() => {
        output.off('data', check);
        reject(new Error(`未等到终端内容：${text}`));
      }, 10000);
      output.on('data', check);
    });
  };
  return { input, output, prompt, until, text: () => transcript };
}

test('TTY 菜单在有效选择后恢复原终端，再输出操作结果', async t => {
  const ui = streams(t);
  ui.output.write('以前的操作记录\n');
  const pending = ui.prompt.menu(() => {
    ui.output.write('箱装辣白菜测试助手\n1. 切换分支\n0. 退出\n');
  }, options);
  await Promise.resolve();
  assert.ok(ui.text().includes(ENTER));
  assert.ok(ui.text().includes('请选择：'));
  assert.ok(!ui.text().includes(LEAVE));
  ui.input.write('1\r');
  assert.equal(await pending, '1');
  ui.output.write('开始所选操作\n');
  assert.ok(ui.text().indexOf('以前的操作记录') < ui.text().indexOf(ENTER));
  assert.ok(ui.text().indexOf('请选择：') < ui.text().indexOf(LEAVE));
  assert.ok(ui.text().indexOf(LEAVE) < ui.text().indexOf('开始所选操作'));
  ui.prompt.close();
  assert.equal(ui.text().split(LEAVE).length - 1, 1);
});

test('无效选择保留临时界面，长中文内容与尺寸变化不影响返回', async t => {
  const ui = streams(t);
  const pending = ui.prompt.menu(() => {
    for (let i = 0; i < 40; i++) ui.output.write(`${i}. codex/很长的分支名称-weak-network-rename-migration\n`);
  }, options);
  await Promise.resolve();
  ui.input.write('x\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ui.text().includes('请输入 0 或 1。'));
  assert.ok(!ui.text().includes(LEAVE));
  ui.output.columns = 12;
  ui.output.emit('resize');
  ui.input.write('0\r');
  assert.equal(await pending, '0');
  assert.equal(ui.text().split(ENTER).length - 1, 1);
  assert.equal(ui.text().split(LEAVE).length - 1, 1);
});

for (const mode of [
  { label: '管道输入', inputTTY: false, outputTTY: true },
  { label: '重定向输出', inputTTY: true, outputTTY: false },
  { label: 'dumb 终端', term: 'dumb' },
]) {
  test(`${mode.label} 保留纯文本，不清屏也不增加回车等待`, async t => {
    const ui = streams(t, mode);
    const pending = ui.prompt.menu(() => ui.output.write('菜单\n'), options);
    ui.input.end('x\n1\n0\n');
    assert.equal(await pending, '1');
    await ui.prompt.waitForReturn();
    assert.equal(await ui.prompt.ask('后续输入：'), '0');
    assert.doesNotMatch(ui.text(), /\x1b|按回车返回主菜单/);
    assert.match(ui.text(), /菜单\n请选择：请输入 0 或 1。\n请选择：后续输入：/);
  });
}

test('TTY 操作结果停留到回车，再重新绘制菜单', async t => {
  const ui = streams(t);
  ui.output.write('✓ 操作结果\n');
  let returned = false;
  const waiting = ui.prompt.waitForReturn().then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  assert.match(ui.text(), /按回车返回主菜单/);
  assert.ok(!ui.text().includes(ENTER));
  ui.input.write('\r');
  await waiting;
  const menu = ui.prompt.menu(() => ui.output.write('重新读取的完整状态\n'), options);
  await Promise.resolve();
  assert.ok(ui.text().indexOf('按回车返回主菜单') < ui.text().indexOf(ENTER));
  assert.match(ui.text(), /重新读取的完整状态/);
  ui.input.write('0\r');
  await menu;
});

test('EOF、Ctrl+C 和渲染错误均恢复终端，重复关闭不残留临时屏幕', async t => {
  for (const reason of ['eof', 'interrupt', 'render-error']) {
    await t.test(reason, async t => {
      let interrupted = false;
      const ui = streams(t, { onInterrupt: () => { interrupted = true; } });
      const pending = ui.prompt.menu(() => {
        ui.output.write('菜单\n');
        if (reason === 'render-error') throw new Error('模拟读取状态失败');
      }, options);
      const rejected = assert.rejects(pending);
      await Promise.resolve();
      if (reason === 'eof') ui.input.end();
      if (reason === 'interrupt') ui.input.write('\x03');
      await rejected;
      ui.prompt.close();
      assert.equal(ui.text().split(LEAVE).length - 1, 1);
      assert.equal(interrupted, reason === 'interrupt');
    });
  }
});

test('TTY 完整切分支流程：清除两级菜单、保留结果、回车后重新读取状态', { timeout: 30000 }, async t => {
  const home = await temporary(t);
  const env = await environment(path.join(home, 'SillyTavern'));
  const repo = await repository(t);
  await commitVersion(repo, 'test', '1.0.2');
  assertTemporaryPath(env.backend, home);
  assertTemporaryPath(repo.work, repo.base);
  await rm(env.backend, { recursive: true });
  await rename(repo.work, env.backend);
  const ui = streams(t, { createPrompt: false });
  const session = run({ helper: fileURLToPath(new URL('../', import.meta.url)), home, cwd: home, input: ui.input, output: ui.output });
  session.catch(() => {});
  await ui.until('请选择：');
  const firstChoice = ui.text().length;
  ui.input.write('1\r');
  await ui.until('请选择后端分支：', firstChoice);
  await ui.until('请选择：', firstChoice);
  assert.ok(ui.text().indexOf(LEAVE) < ui.text().indexOf('正在检查工作区'));
  ui.input.write('2\r');
  await ui.until('按回车返回主菜单：', firstChoice);
  const result = ui.text().indexOf('✓ 已切换至 test');
  assert.ok(result > ui.text().lastIndexOf(LEAVE));
  assert.equal(ui.text().split(ENTER).length - 1, 2);
  assert.equal(ui.text().split(LEAVE).length - 1, 2);
  const returnAt = ui.text().length;
  ui.input.write('\r');
  await ui.until('分支：test\n版本：1.0.2', returnAt);
  await ui.until('请选择：', returnAt);
  assert.match(ui.text().slice(returnAt), /箱装辣白菜测试助手[\s\S]*SillyTavern：[\s\S]*前端：[\s\S]*后端：[\s\S]*1\. 切换后端分支/);
  ui.input.write('0\r');
  await session;
  assert.equal(ui.text().split(ENTER).length - 1, 3);
  assert.equal(ui.text().split(LEAVE).length - 1, 3);
  assert.match(ui.text(), /助手已退出/);
});
