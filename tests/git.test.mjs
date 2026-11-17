import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { repository, command, commitVersion, write } from './fixtures.mjs';
import { listBranches, switchBranch, updateHelper, validateRepository, worktreeStatus, repositoryName, BACKEND_REPOSITORY, git, withGitSignal } from '../src/git.mjs';

const head = work => command(work, 'rev-parse', 'HEAD');
const branch = work => command(work, 'branch', '--show-current');
const select = async (repo, name) => (await listBranches(repo.work)).find(item => item.name === name);

test('识别 HTTPS / SSH 官方地址，拒绝近似域名和其他仓库', () => {
  for (const url of ['https://github.com/Yuyayun/boxed-lllllabc-server.git', 'git@github.com:Yuyayun/boxed-lllllabc-server.git', 'ssh://git@github.com/Yuyayun/boxed-lllllabc-server']) {
    assert.equal(repositoryName(url), BACKEND_REPOSITORY.toLowerCase());
  }
  assert.equal(repositoryName('https://github.com.evil.invalid/Yuyayun/boxed-lllllabc-server'), null);
  assert.equal(repositoryName('https://github.com/Yuyayun/boxed-lllllabc-server/extra'), null);
});

test('远端分支建立本地 tracking branch，版本和实际提交一致', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'codex/large-chat-backups', '1.0.2');
  const choice = await select(repo, 'codex/large-chat-backups');
  assert.equal(choice.local, null);
  const result = await switchBranch(repo.work, choice);
  assert.equal(result.branch, 'codex/large-chat-backups');
  assert.equal(result.version, '1.0.2');
  assert.deepEqual(result.changes, []);
  assert.equal(command(repo.work, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/codex/large-chat-backups');
  assert.equal(head(repo.work), head(repo.seed));
  await switchBranch(repo.work, await select(repo, 'main'));
  assert.equal(branch(repo.work), 'main');
});

test('已有本地分支仅以快进方式接收远端更新', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'main', '1.0.3');
  const result = await switchBranch(repo.work, await select(repo, 'main'));
  assert.equal(result.version, '1.0.3');
  assert.equal(head(repo.work), head(repo.seed));
  assert.equal(command(repo.work, 'rev-list', '--count', 'HEAD'), '2');
});

test('分叉在切换前被拒绝，保留原分支与所有本地提交', async t => {
  const repo = await repository(t);
  command(repo.work, 'switch', '-c', 'test-branch');
  await write(repo.work, 'local.txt', 'local\n');
  command(repo.work, 'add', 'local.txt');
  command(repo.work, 'commit', '-m', 'local');
  const local = head(repo.work);
  command(repo.work, 'switch', 'main');
  const original = head(repo.work);
  await commitVersion(repo, 'test-branch');
  await assert.rejects(switchBranch(repo.work, await select(repo, 'test-branch')), /分叉/);
  assert.equal(branch(repo.work), 'main');
  assert.equal(head(repo.work), original);
  assert.equal(command(repo.work, 'rev-parse', 'test-branch'), local);
});

for (const scenario of ['modified', 'staged', 'untracked']) {
  test(`${scenario} 文件阻止 fetch 和切换，内容及状态保留`, async t => {
    const repo = await repository(t);
    const before = head(repo.work);
    const file = scenario === 'untracked' ? 'new file.txt' : 'plugin.mjs';
    await write(repo.work, file, 'KEEP ME\n');
    if (scenario === 'staged') command(repo.work, 'add', file);
    const status = command(repo.work, 'status', '--porcelain');
    await commitVersion(repo, 'codex/new');
    await assert.rejects(listBranches(repo.work), /未提交修改/);
    assert.equal(head(repo.work), before);
    assert.equal(command(repo.work, 'status', '--porcelain'), status);
    assert.equal(await readFile(path.join(repo.work, file), 'utf8'), 'KEEP ME\n');
    assert.equal(command(repo.work, 'branch', '-r', '--list', 'origin/codex/new'), '');
  });
}

test('选择列表后新增的本地修改也会阻止切换', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'test');
  const choice = await select(repo, 'test');
  await write(repo.work, 'plugin.mjs', 'changed after menu\n');
  await assert.rejects(switchBranch(repo.work, choice), /未提交修改/);
  assert.equal(branch(repo.work), 'main');
});

test('错误 origin 和上层 Git 仓库均被拒绝', async t => {
  const repo = await repository(t);
  command(repo.work, 'remote', 'set-url', 'origin', 'https://github.com/Yuyayun/boxed-lllllabc.git');
  await assert.rejects(listBranches(repo.work), /仓库身份不符/);
  const nested = path.join(repo.work, 'nested');
  await mkdir(nested);
  await assert.rejects(validateRepository(nested, BACKEND_REPOSITORY), /不是独立/);
});

test('fetch 失败后不切换分支或修改工作区', async t => {
  const repo = await repository(t);
  command(repo.work, 'config', '--unset-all', `url.${repo.remote.replaceAll('\\', '/')}.insteadOf`);
  command(repo.work, 'config', `url.${path.join(repo.base, 'missing.git').replaceAll('\\', '/')}.insteadOf`, 'https://github.com/Yuyayun/boxed-lllllabc-server.git');
  const before = head(repo.work);
  await assert.rejects(listBranches(repo.work), /获取远端分支失败/);
  assert.equal(head(repo.work), before);
  assert.equal(branch(repo.work), 'main');
  assert.deepEqual(await worktreeStatus(repo.work), []);
});

test('本地领先远端的提交保留，不被回退', async t => {
  const repo = await repository(t);
  await write(repo.work, 'local.txt', 'keep\n');
  command(repo.work, 'add', 'local.txt');
  command(repo.work, 'commit', '-m', 'ahead');
  const before = head(repo.work);
  const result = await switchBranch(repo.work, await select(repo, 'main'));
  assert.equal(result.ahead, true);
  assert.equal(head(repo.work), before);
});

test('忽略文件与目标分支冲突时停止，保留文件内容和原分支', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'test', '1.0.2');
  await write(repo.seed, 'ignored.txt', 'remote\n');
  command(repo.seed, 'add', '-f', 'ignored.txt');
  command(repo.seed, 'commit', '-m', 'track formerly ignored file');
  command(repo.seed, 'push', 'origin', 'test');
  await write(repo.work, 'ignored.txt', 'PRIVATE LOCAL CONTENT\n');
  const before = head(repo.work);
  await assert.rejects(switchBranch(repo.work, await select(repo, 'test')), /忽略的本地文件/);
  assert.equal(await readFile(path.join(repo.work, 'ignored.txt'), 'utf8'), 'PRIVATE LOCAL CONTENT\n');
  assert.equal(head(repo.work), before);
  assert.equal(branch(repo.work), 'main');
});

test('目标分支元数据错误时在切换前拒绝', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'wrong');
  await write(repo.seed, 'package.json', { name: 'unrelated', version: '5.0.0' });
  command(repo.seed, 'add', 'package.json');
  command(repo.seed, 'commit', '-m', 'wrong project');
  command(repo.seed, 'push', 'origin', 'wrong');
  await assert.rejects(switchBranch(repo.work, await select(repo, 'wrong')), /不符合预期/);
  assert.equal(branch(repo.work), 'main');
});

test('未完成的合并与隐藏修改标记均拒绝操作', async t => {
  const repo = await repository(t);
  const mergeHead = command(repo.work, 'rev-parse', '--git-path', 'MERGE_HEAD');
  await write(repo.work, mergeHead, `${head(repo.work)}\n`);
  await assert.rejects(listBranches(repo.work), /未完成/);
});

test('assume-unchanged 文件无法绕过修改保护', async t => {
  const repo = await repository(t);
  command(repo.work, 'update-index', '--assume-unchanged', 'plugin.mjs');
  await write(repo.work, 'plugin.mjs', 'hidden edits\n');
  await assert.rejects(listBranches(repo.work), /跳过工作区检查/);
});

test('选择列表后引用变动时拒绝操作', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'test');
  const choice = await select(repo, 'test');
  command(repo.work, 'update-ref', 'refs/remotes/origin/test', head(repo.work));
  await assert.rejects(switchBranch(repo.work, choice), /引用发生变化/);
  assert.equal(branch(repo.work), 'main');
});

test('删除的远端分支不再列出，本地分支仍保留', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'obsolete');
  await select(repo, 'obsolete');
  command(repo.seed, 'push', 'origin', '--delete', 'obsolete');
  assert.equal((await listBranches(repo.work)).some(item => item.name === 'obsolete'), false);
});

test('助手无更新时报告最新版本', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  assert.deepEqual(await updateHelper(repo.work), { updated: false, currentVersion: '1.0.0', remoteVersion: '1.0.0' });
});

test('助手更新只快进到正式 main，重新读取版本', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.1.0');
  const result = await updateHelper(repo.work);
  assert.equal(result.updated, true);
  assert.equal(result.remoteVersion, '1.1.0');
  assert.equal(head(repo.work), head(repo.seed));
  assert.deepEqual(await worktreeStatus(repo.work), []);
});

test('助手工作区存在修改时拒绝更新', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.1.0');
  await write(repo.work, 'plugin.mjs', 'my changes\n');
  const before = head(repo.work);
  await assert.rejects(updateHelper(repo.work), /未提交修改/);
  assert.equal(head(repo.work), before);
});

test('助手自身分叉时停止并保留提交', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  await write(repo.work, 'local.txt', 'keep\n');
  command(repo.work, 'add', 'local.txt');
  command(repo.work, 'commit', '-m', 'local');
  const before = head(repo.work);
  await commitVersion(repo, 'main', '1.1.0');
  await assert.rejects(updateHelper(repo.work), /分叉/);
  assert.equal(head(repo.work), before);
});

test('助手开发分支、游离 HEAD 或非 Git 安装不能自动更新', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  command(repo.work, 'switch', '-c', 'codex/development');
  await assert.rejects(updateHelper(repo.work), /main 正式分支/);
  command(repo.work, 'switch', '--detach');
  await assert.rejects(updateHelper(repo.work), /main 正式分支/);
  await assert.rejects(updateHelper(repo.base), /不是可用的 Git/);
});

test('只有本地的分支可以切换', async t => {
  const repo = await repository(t);
  command(repo.work, 'branch', '--no-track', 'local-only');
  const result = await switchBranch(repo.work, await select(repo, 'local-only'));
  assert.equal(result.branch, 'local-only');
  assert.equal(result.version, '1.0.0');
});

test('已删除远端的本地分支保留并允许切换', async t => {
  const repo = await repository(t);
  await commitVersion(repo, 'old-test');
  await switchBranch(repo.work, await select(repo, 'old-test'));
  const before = head(repo.work);
  command(repo.work, 'switch', 'main');
  command(repo.seed, 'push', 'origin', '--delete', 'old-test');
  const result = await switchBranch(repo.work, await select(repo, 'old-test'));
  assert.equal(result.missingUpstream, true);
  assert.equal(head(repo.work), before);
});

test('游离 HEAD 可以安全返回 main', async t => {
  const repo = await repository(t);
  command(repo.work, 'switch', '--detach');
  const result = await switchBranch(repo.work, await select(repo, 'main'));
  assert.equal(result.branch, 'main');
});

test('不执行后端 checkout / merge hooks', async t => {
  const repo = await repository(t);
  for (const hook of ['post-checkout', 'post-merge']) {
    const file = `.git/hooks/${hook}`;
    await write(repo.work, file, '#!/bin/sh\necho HOOK_RAN > hook-must-not-run.txt\n');
    await chmod(path.join(repo.work, file), 0o755);
  }
  await commitVersion(repo, 'main', '1.0.2');
  await switchBranch(repo.work, await select(repo, 'main'));
  await assert.rejects(readFile(path.join(repo.work, 'hook-must-not-run.txt')), { code: 'ENOENT' });
});

test('助手版本号不变而提交有更新时仍可快进', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.0.0');
  const result = await updateHelper(repo.work);
  assert.equal(result.updated, true);
  assert.equal(result.currentVersion, result.remoteVersion);
  assert.equal(head(repo.work), head(repo.seed));
});

test('助手忽略文件冲突时拒绝更新并保留本地文件', async t => {
  const repo = await repository(t, { name: 'baicaigaga' });
  await commitVersion(repo, 'main', '1.0.1');
  await write(repo.seed, 'ignored.txt', 'remote file\n');
  command(repo.seed, 'add', '-f', 'ignored.txt');
  command(repo.seed, 'commit', '-m', 'tracked file');
  command(repo.seed, 'push', 'origin', 'main');
  await write(repo.work, 'ignored.txt', 'keep local file\n');
  const before = head(repo.work);
  await assert.rejects(updateHelper(repo.work), /忽略的本地文件/);
  assert.equal(head(repo.work), before);
  assert.equal(await readFile(path.join(repo.work, 'ignored.txt'), 'utf8'), 'keep local file\n');
});

test('用户取消后不再启动后续 Git 命令', async t => {
  const repo = await repository(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withGitSignal(controller.signal, () => git(repo.work, ['branch', 'must-not-exist'])), /已取消/);
  assert.equal(command(repo.work, 'branch', '--list', 'must-not-exist'), '');
});

test('用户取消时中断助手自己正在等待的 Git 子进程', { timeout: 10000 }, async t => {
  const repo = await repository(t);
  const controller = new AbortController();
  // This read-only Git command waits for stdin, so cancellation is exercised
  // without touching a remote or an unrelated application process.
  const pending = withGitSignal(controller.signal, () => git(repo.work, ['hash-object', '--stdin']));
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, /已取消/); } finally { clearTimeout(timer); }
  assert.deepEqual(await worktreeStatus(repo.work), []);
});
