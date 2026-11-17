#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { run } from '../src/cli.mjs';
import { describe } from '../src/errors.mjs';

const helper = fileURLToPath(new URL('../', import.meta.url));
try {
  if (process.argv.includes('--version')) {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (process.argv.includes('--help')) {
    console.log('箱装辣白菜测试助手\n\nbaicaigaga            打开交互菜单\nbaicaigaga --version  查看助手版本\nbaicaigaga --help     查看帮助\n\n助手只在本次调用期间运行，退出后进程结束。');
  } else {
    await run({ helper });
  }
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
}
