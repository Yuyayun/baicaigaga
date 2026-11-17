# 箱装辣白菜测试助手

`baicaigaga` 是独立的 Node.js 终端工具，用于开发测试时查看环境、安全切换箱装辣白菜 **后端** Git 分支，以及手动更新助手自身。只使用 Node.js 内置模块，无需 `npm install`。

只有输入命令时才运行。退出菜单、输入结束或按 Ctrl+C 后进程结束，不创建服务、后台进程或定时任务。

## Termux 安装

需要 Node.js 22.14.0 或更新版本，以及支持 `git switch` 的 Git。推荐安装在独立路径：

```bash
pkg install nodejs-lts git
mkdir -p "$HOME/.local/share"
git clone https://github.com/Yuyayun/baicaigaga.git "$HOME/.local/share/baicaigaga"
node "$HOME/.local/share/baicaigaga/install.mjs"
baicaigaga
```

安装器在 `$PREFIX/bin/baicaigaga` 写入一个可执行入口，使用当前 Node.js 的绝对路径；无论当前目录在哪里，都可输入 `baicaigaga`。已有同名非助手文件或链接时拒绝覆盖。重复运行安装器可以刷新本助手的入口。

助手源码不能放在前端或后端目录中。配置保存在 `~/.config/baicaigaga/config.json`，源码更新不会覆盖它。移动助手目录后，请从新位置重新执行 `node install.mjs`；更新 Node.js 导致其绝对路径改变时也应重装入口。

在普通 Linux 上，未设置 `PREFIX` 时使用 `~/.local/bin/baicaigaga`，需将该目录加入 `PATH`。Windows 开发环境可直接执行 `node bin/baicaigaga.mjs`；Termux 命令入口需在 Termux 本机安装。

## 使用

```text
baicaigaga
baicaigaga --version
baicaigaga --help
```

启动会显示 SillyTavern、前端、后端的绝对路径、前后端版本、后端分支及工作区状态。

```text
1. 切换后端分支
2. 更新测试助手
3. 重新定位 SillyTavern
0. 退出
```

第一次定位依次检查当前目录及父目录、HOME 中的常见路径，并在 HOME 下最多三层、240 个目录、3000 个目录条目内查找。跳过隐藏目录、`node_modules`、`storage` 等大目录，不跟随浅层查找中的目录链接，不遍历设备存储。常见路径包括 `~/SillyTavern`、`~/sillytavern`、`~/st/SillyTavern`、`~/apps/SillyTavern`、`~/.local/share/SillyTavern`。

候选必须包含 SillyTavern 的 `package.json`（名称为 `sillytavern`）与 `server.js`，并通过以下两个目录的元数据检查：

- `public/scripts/extensions/third-party/boxed-lllllabc`：`manifest.json` 的显示名称为“箱装辣白菜”，含版本及入口信息。
- `plugins/boxed-lllllabc-server`：`package.json` 名称为 `boxed-lllllabc-server`，含版本信息。

只有一个有效候选时自动确认并保存；多个候选时选择；没有找到时可手动输入根目录，支持 `~`、空格及外层引号。输入 `0` 可跳过定位，仍能使用助手更新菜单。以后优先使用已保存的有效路径。酒馆移动后选择“重新定位 SillyTavern”；取消重新定位会保留原配置。

## 切换后端分支

1. 确认后端是独立 Git 仓库根目录，且 `origin` 配置指向 `Yuyayun/boxed-lllllabc-server`，支持 GitHub HTTPS 与 SSH 地址。
2. 检查暂存、未暂存、未跟踪文件及子模块状态。发现修改时列出状态并停止，连 fetch 都不会执行。未完成的合并、变基、拣选、二分查找、索引锁，以及隐藏工作区修改的文件标记也会阻止操作。
3. 按需 fetch `origin` 的分支，清理已删除的远端跟踪引用。不会把 fetch 目标设为本地分支。
4. 列出本地分支与 `origin` 远端分支，标明当前分支和仅存在于远端的分支。
5. 选择后再次检查状态。已有本地分支直接使用；只有远端分支时建立同名本地 tracking branch。本地分支已有上游时使用其 `origin` 上游；上游已删除时保留并切换本地分支、给出提示；跟踪其他远端时停止操作。
6. 在切换前检查目标元数据和提交历史。远端领先时只允许 fast-forward；分叉时保留原分支并停止。本地领先的提交会保留并提示。只有本地的分支仍可切换。
7. 保护可能被目标分支覆盖的 Git 忽略文件，禁用 Git hooks、自动 stash 与递归子模块更新。切换后核对分支、实际提交、版本和干净状态。

成功后手动重启 SillyTavern 再测试。测试结束再次运行助手，选择 `main` 即可恢复正式分支，不需要单独的测试模式。

分支列表中的 `origin` 是助手支持的唯一操作远端；本地仓库自己的 Git URL 重写和认证配置仍由 Git 处理。后端需为独立克隆或独立 Git 工作树，不能只是 SillyTavern 上层仓库中的普通目录。

## 更新助手自身

只在主动选择菜单 `2` 时执行：确认助手是 `Yuyayun/baicaigaga` 的 Git 安装、位于 `main` 且工作区干净，再 fetch 并比较当前提交、版本与 `origin/main`。即使版本号相同，存在新提交时也会快进更新；提交完全相同时显示“当前已是最新版本”。

工作区有修改、未发布的本地提交、分叉、开发分支、游离 HEAD 或非 Git 安装均会拒绝自动更新。更新成功后当前进程立即退出，请重新输入 `baicaigaga` 使用新版。

网络、权限或 Git 操作失败时给出中文说明，保留诊断信息并停止该操作。fetch 已取得的远端跟踪引用不会自动撤销；如果切换成功后快进步骤因权限、磁盘等异常失败，保留当时的 Git 状态并显示当前状态，不执行自动回滚、覆盖或历史改写。不要在助手操作期间并行操作同一个仓库。

## 安全范围

助手仅读取前端元数据，不对前端执行 Git 或文件修改。它不读取或修改聊天数据库、备份数据库或备份位置，不启动、停止、终止或重启 SillyTavern，也不安装其依赖。

助手不会自动 stash、reset、clean、强制切换、强制覆盖、处理分叉或自动重启。配置与命令入口只在定位保存、安装等明确操作时写入。没有启动自动更新、后台更新、守护进程或定时任务。

## 开发与验证

```bash
npm test
node bin/baicaigaga.mjs --version
```

测试使用系统临时目录中的独立 Git 仓库与离线远端，不连接生产酒馆，不操作真实聊天或备份数据。集成测试覆盖环境确认、路径配置、候选数量和深度限制、远端跟踪分支、快进、分叉、修改保护、忽略文件保护及自更新。

Termux 本机验收：安装入口后从 HOME 和任意其他目录分别启动；确认实际酒馆路径；切换测试分支后手动重启并测试；再切回 `main`。退出后确认返回 shell。开发机的模拟测试不能代替设备上的这一步。
