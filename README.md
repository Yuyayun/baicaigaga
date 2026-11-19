# 箱装小助手

`baicaigaga` 是箱装辣白菜配套的独立终端管理工具，用于检查环境、安装与管理服务器插件、查看和修改酒馆服务器插件设置、安全切换后端分支，以及检查助手更新。

在 Termux 中复制这一条命令即可安装并启动：

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/Yuyayun/baicaigaga/main/install.sh)"
```

安装器检查 Node.js 和 Git。Node.js **>= 22.14.0** 就直接使用，已有 Git 不升级；只有依赖缺失或不满足要求时，才显示数字菜单，由你选择安装或退出。不会执行 `pkg upgrade`。需要安装依赖时仅支持 Termux 的 `pkg`，其它环境请先手动准备依赖。

首次安装到 `~/.local/share/baicaigaga`，调用 `install.mjs` 创建命令并自动启动。重复运行安装命令只提供“启动箱装小助手 / 退出”，不会更新、拉取或覆盖已有源码。遇到未知安装目录或命令入口冲突时停止，保留已有内容。命令使用 `sh -c`，让脚本内容与交互输入分开；请保留这一写法。

## 日常使用

```text
baicaigaga
baicaigaga --version
baicaigaga --help
```

主菜单：

```text
1  安装 / 管理服务器插件
2  酒馆服务器插件设置
3  切换后端分支
4  检查助手更新
5  重新定位 SillyTavern

0  退出
```

启动只检查和显示状态。任何安装、配置修改、分支切换或源码更新，都由你主动按数字触发。助手只在调用期间运行，退出后进程结束，不创建服务、后台进程或定时任务。

## 功能说明

### 定位酒馆与查看状态

首次启动依次检查当前目录及父目录、HOME 常见路径和有限的浅层候选目录。一个有效候选会自动保存；多个候选由你选择；没有找到时可手动输入根目录，支持 `~`、空格及外层引号。输入 `0` 可跳过定位，仍可检查助手更新。取消重新定位会保留原配置。

SillyTavern 本体只需根目录可访问、`package.json` 名称为 `sillytavern` 且存在 `server.js`。前后端分别显示已安装、未安装或异常，缺少任何一端都不妨碍定位酒馆。

- 前端：`public/scripts/extensions/third-party/boxed-lllllabc`，只读取元数据，不安装或修改。
- 后端：`plugins/boxed-lllllabc-server`，显示版本、Git 分支和工作区状态。

路径配置保存在 `~/.config/baicaigaga/config.json`，源码更新不会覆盖它。自动搜索最多三层、240 个目录、3000 个条目，跳过隐藏目录、`node_modules`、`storage`、数据和备份目录，不跟随浅层搜索中的目录链接。

### 安装 / 管理服务器插件

未安装时进入管理页，按 `1` 才会从 `https://github.com/Yuyayun/boxed-lllllabc-server.git` 的 `main` 分支安装。已有目标目录（包括空目录、未知内容及异常仓库）不会被自动覆盖、删除或重装。

安装成功后校验版本、分支和工作区。若酒馆未启用服务器插件，只显示提示，由你进入设置页修改。安装失败时保留现场；不完整目录需要人工检查后再处理。没有内置代理、镜像或全局 Git 配置修改。

### 酒馆服务器插件设置

设置页显示 `config.yaml` 中的两个布尔值，未显式设置的值标注“默认”：

| 设置 | 作用 | 缺失时的默认值 |
| --- | --- | --- |
| `enableServerPlugins` | 允许酒馆加载服务器插件 | `false` |
| `enableServerPluginsAutoUpdate` | 允许酒馆启动时自动检查并更新 Git 安装的服务器插件 | `true` |

两者独立；自动更新开关不决定插件是否加载。默认值与含义依据 [SillyTavern 插件加载器](https://github.com/SillyTavern/SillyTavern/blob/release/src/plugin-loader.js)。表格表示配置文件及默认值；使用自定义 `--configPath` 或环境变量覆盖的部署，请在相应启动环境中管理配置。

按 `1` 或 `2` 直接切换对应值，写入校验成功后立即刷新本页，没有第二层确认。修改后通常需要手动重启 SillyTavern。

配置解析复用该酒馆已安装的 `yaml` 库，无需给助手安装运行依赖。修改仅替换目标布尔值或追加目标行，保留其它内容、注释、换行和文件权限，通过临时文件原子替换。解析失败、重复字段、非布尔值、共享锚点或不能保留格式的结构会停止修改；酒馆依赖不完整时会明确提示。

### 安全切换后端分支

切换前确认后端是独立 Git 仓库根目录，且 `origin` 指向 `Yuyayun/boxed-lllllabc-server`，支持官方 HTTPS 和 SSH 地址。检查暂存、未暂存、未跟踪文件、子模块、未完成 Git 操作和隐藏修改标记；有异常时停止，工作区有修改时连 fetch 都不执行。

获取 `origin` 分支后列出本地及远端分支。远端分支可建立同名本地跟踪分支，已有分支按其 `origin` 上游更新。远端领先时只允许 fast-forward；分叉会停止，本地领先的提交会保留，已删除上游的本地分支仍可切换并提示。保护可能被目标分支覆盖的忽略文件，禁用 Git hooks、自动 stash 和递归子模块更新；切换后核对分支、提交、版本与干净状态。

助手不会自动 stash、reset、clean、强制切换、覆盖或自动回滚。不要在助手操作期间并行操作同一仓库。完成后由你手动重启酒馆；再次选择 `main` 可回到正式分支。

### 检查助手更新

主菜单 `4` 仅检查：确认助手是 `Yuyayun/baicaigaga` 的 Git 安装、处于 `main` 且工作区干净，然后只读查询远端提交。没有新版时不执行 fetch、不写本地文件，只提供返回；发现远端提交不同后，才 fetch Git 元数据以比较历史和版本，源码及当前分支仍不改变。有新提交时显示“更新到版本”，再按 `1` 才执行快进更新。版本号相同但存在新提交时也可更新。

确认前会再次检查工作区与引用，拒绝本地修改、未发布提交、分叉、开发分支、游离 HEAD、非 Git 安装和忽略文件冲突。更新成功后清理当前交互状态，自动启动新版助手，无需重新输入命令。

## 手动安装 / 开发者安装

需要 Node.js >= 22.14.0 和支持 `git switch` 的 Git。准备好依赖后：

```sh
mkdir -p "$HOME/.local/share"
git clone --branch main https://github.com/Yuyayun/baicaigaga.git "$HOME/.local/share/baicaigaga"
node "$HOME/.local/share/baicaigaga/install.mjs"
baicaigaga
```

`install.mjs` 只创建命令入口，不获取源码或安装依赖；一键安装器负责首次安装后的自动启动。Termux 入口位于 `$PREFIX/bin/baicaigaga`，使用当前 Node.js 的绝对路径。普通 Linux 未设置 `PREFIX` 时写入 `~/.local/bin/baicaigaga`，请将其加入 `PATH`。Windows 开发环境直接运行 `node bin/baicaigaga.mjs`。

助手及命令入口应独立于箱装前后端目录。移动助手目录或更换 Node.js 路径后，重新运行 `node install.mjs` 刷新入口；不属于助手的同名文件或链接会拒绝覆盖。

## 终端与安全范围

主菜单和子菜单统一排版，长路径独立显示。输入、输出均为 TTY 且 `TERM` 不是 `dumb` 时使用临时屏幕；有效选择后菜单消失，回到正常终端显示操作结果。普通结果按回车返回主菜单，子菜单 `0` 直接返回。EOF、Ctrl+C 和 SIGTERM 会恢复终端。非 TTY 输出确定性的纯文本，不发临时屏幕控制字符，不增加回车等待。

助手不安装前端，不读取或修改聊天数据库、备份数据库或备份位置，不启动或重启 SillyTavern，不改代理、不自动安装后端、不自动改酒馆配置，也不在启动时更新自身。

## 开发测试

```sh
npm ci --ignore-scripts
npm test
node bin/baicaigaga.mjs --help
```

开发依赖 `yaml` 只供测试构建模拟酒馆，正常使用助手无需 `npm install`。测试使用系统临时目录和离线 Git 远端，不连接生产酒馆。CI 覆盖 Linux / Windows 与 Node.js 22 / 24。

Termux 真机仍需验收：复制一键命令、检查依赖交互、从任意目录启动、配置切换、安装后端、切换分支及更新后重启。桌面模拟测试不能代替这一步。

## 许可

作者：**辣白菜 / labaicai0969**。

本项目采用 [CC BY-NC-SA 4.0](LICENSE) 许可：允许在署名、非商业的前提下使用、修改与分享；公开分享改编或衍生作品时，应继续采用 CC BY-NC-SA 4.0。完整授权范围以 LICENSE 正文为准。

本许可自首次加入 `LICENSE` 的提交起适用。
