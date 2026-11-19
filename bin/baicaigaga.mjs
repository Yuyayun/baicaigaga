#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { describe } from '../src/errors.mjs';

const helper = fileURLToPath(new URL('../', import.meta.url));
try {
  if (process.argv.includes('--version')) {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (process.argv.includes('--help')) {
    console.log('箱装小助手\n\nbaicaigaga            打开交互菜单\nbaicaigaga --version  查看助手版本\nbaicaigaga --help     查看帮助\n\n管理服务器插件、酒馆插件设置、后端分支及助手更新。\n助手只在本次调用期间运行，退出后进程结束。');
  } else {
    const result = await run({ helper });
    if (result?.restart) {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(result.helper, 'bin', 'baicaigaga.mjs')], { stdio: 'inherit', windowsHide: true });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
      });
    }
  }
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
}
