import { readFile, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectEnvironment, atomicWrite, contains } from './environment.mjs';
import { UserError } from './errors.mjs';

// Same fallbacks as SillyTavern/src/plugin-loader.js. No npm install in the helper.
export const SETTINGS = {
  enableServerPlugins: { default: false, description: '允许 SillyTavern 加载 plugins 中的服务器插件' },
  enableServerPluginsAutoUpdate: { default: true, description: '允许 SillyTavern 启动时自动检查并更新 Git 安装的服务器插件' },
};

async function context(root) {
  const environment = await inspectEnvironment(root);
  if (!environment) throw new UserError('SillyTavern 根目录已失效，请重新定位。');
  const file = path.join(environment.root, 'config.yaml');
  let info, source;
  try {
    info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !contains(environment.root, await realpath(file))) throw new UserError('config.yaml 必须是酒馆根目录中的普通文件。');
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(error.code === 'ENOENT' ? 'config.yaml 文件不存在。' : '无法读取 config.yaml，请检查文件权限。', error.message);
  }
  let yaml;
  try { yaml = createRequire(path.join(environment.root, 'package.json'))('yaml'); }
  catch { throw new UserError('无法加载 SillyTavern 自带的 YAML 解析库，请先确认酒馆依赖完整。'); }
  const parse = text => {
    try {
      const doc = yaml.parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length || !yaml.isMap(doc.contents)) throw new UserError('config.yaml 无法解析为唯一的配置映射，未修改文件。', doc.errors.map(error => error.message).join('\n'));
      // Resolve aliases too: syntax alone does not reject missing aliases or
      // excessive alias expansion, whereas SillyTavern's yaml.parse does.
      doc.toJS({ maxAliasCount: 100 });
      return doc;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError('config.yaml 无法解析，未修改文件。', error.message);
    }
  };
  return { file, info, source, yaml, parse };
}

function values(doc, yaml) {
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, setting]) => {
    const node = doc.get(key, true);
    if (node !== undefined && (!yaml.isScalar(node) || typeof node.value !== 'boolean' || node.anchor)) throw new UserError(`${key} 不是独立布尔值，无法安全修改 config.yaml。`);
    return [key, { ...setting, value: node?.value ?? setting.default, explicit: node !== undefined }];
  }));
}

export async function readSettings(root) {
  const ctx = await context(root);
  return values(ctx.parse(ctx.source), ctx.yaml);
}

export async function toggleSetting(root, key) {
  if (!Object.hasOwn(SETTINGS, key)) throw new UserError('不支持修改此配置项。');
  const ctx = await context(root);
  const doc = ctx.parse(ctx.source);
  const current = values(doc, ctx.yaml);
  const value = !current[key].value;
  const node = doc.get(key, true);
  let source;
  if (node) {
    source = ctx.source.slice(0, node.range[0]) + String(value) + ctx.source.slice(node.range[1]);
  } else {
    if (doc.contents.flow) throw new UserError('config.yaml 使用行内映射，无法保留格式添加字段，请人工修改。');
    const eol = ctx.source.includes('\r\n') ? '\r\n' : '\n';
    // Insert before YAML document-end markers instead of creating a second document.
    const end = /^(?:\.\.\.)(?:[ \t]*(?:#.*)?)?\r?$/m.exec(ctx.source);
    const offset = end?.index ?? ctx.source.length;
    source = ctx.source.slice(0, offset) + (offset && !ctx.source.slice(0, offset).endsWith('\n') ? eol : '') + `${key}: ${value}${eol}` + ctx.source.slice(offset);
  }
  const checked = values(ctx.parse(source), ctx.yaml);
  if (checked[key].value !== value || !checked[key].explicit) throw new UserError('config.yaml 校验失败，保留旧文件。');
  // Validate the temporary contents before atomicWrite replaces the old file.
  // Refuse concurrent changes and preserve the existing file permissions.
  if (await readFile(ctx.file, 'utf8') !== ctx.source) throw new UserError('config.yaml 在操作期间发生变化，请重新读取后重试。');
  try { await atomicWrite(ctx.file, source, ctx.info.mode & 0o777); }
  catch (error) { throw new UserError(['EACCES', 'EPERM'].includes(error.code) ? '权限不足，无法写入 config.yaml；旧文件已保留。' : 'config.yaml 写入失败，旧文件已保留。', error.message); }
  return checked;
}
