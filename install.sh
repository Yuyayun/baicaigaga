#!/bin/sh
# Run with sh -c "$(curl -fsSL https://raw.githubusercontent.com/Yuyayun/baicaigaga/main/install.sh)"
set -eu
umask 077
trap 'printf "\n安装已取消。\n"; exit 130' INT
trap 'printf "\n安装已取消。\n"; exit 143' TERM

minimum=22.14.0
repository=https://github.com/Yuyayun/baicaigaga.git
target=${HOME:?无法确定 HOME}/.local/share/baicaigaga

fail() { printf '\n✕ %s\n' "$*" >&2; exit 1; }
heading() { printf '\n──────────────────────────────────\n  安装箱装小助手\n──────────────────────────────────\n\n'; }
choose() {
  while :; do
    printf '\n  1  %s\n  0  退出\n\n请选择：' "$1"
    answer=
    if ! IFS= read -r answer; then printf '\n'; exit 0; fi
    case "$answer" in 1) return 0 ;; 0) exit 0 ;; *) printf '请输入 1 或 0。\n' ;; esac
  done
}
packages() {
  case "${PREFIX:-}" in */com.termux/files/usr) termux=yes ;; *) termux=${TERMUX_VERSION:-} ;; esac
  [ -n "$termux" ] && command -v pkg >/dev/null 2>&1 || fail '当前环境不支持 Termux pkg，请手动安装满足要求的 Node.js 和 Git 后重试。'
  pkg install -y "$1" || fail "包管理器安装失败：$1。请检查网络、软件源和权限后重试。"
}
node_usable() {
  command -v node >/dev/null 2>&1 || return 1
  node_version=$(node --version 2>/dev/null) || return 1
  version=${node_version#v}
  case "$version" in *[!0-9.]*|''|.*|*..*|*.) return 1 ;; esac
  old_ifs=$IFS; IFS=.; set -- $version; IFS=$old_ifs
  [ "$#" -eq 3 ] || return 1
  # Avoid octal arithmetic and accept only the standard decimal Node version.
  [ "$1" -gt 22 ] || { [ "$1" -eq 22 ] && [ "$2" -ge 14 ]; }
}
git_usable() { command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; }

heading
printf '正在检查运行环境…\n'
if ! node_usable; then
  heading
  if command -v node >/dev/null 2>&1; then
    printf '  Node.js\n  当前版本    %s\n  最低要求    %s\n  状态        ✕ 版本过低或无法使用\n' "${node_version:-未知}" "$minimum"
    choose '更新 Node.js'
  else
    printf '  Node.js\n  状态        ✕ 未安装\n  最低要求    %s\n' "$minimum"
    choose '安装 Node.js'
  fi
  packages nodejs-lts
  node_usable || fail "Node.js 安装后仍未满足最低要求 $minimum，请人工检查。"
fi
printf '✓ Node.js %s 可用\n' "$node_version"
if ! git_usable; then
  heading
  printf '  Git\n  状态        ✕ 未安装或无法使用\n'
  choose '安装 Git'
  packages git
  git_usable || fail 'Git 安装后仍无法使用，请人工检查。'
fi
printf '✓ Git 可用\n'

# Check the physical destination before clone can create anything there.
node - "$target" <<'NODE' || fail '助手安装路径异常或位于箱装前后端中，请使用独立目录。'
const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.argv[2]);
let existing = target;
while (!fs.existsSync(existing)) {
  if (path.dirname(existing) === existing) process.exit(1);
  existing = path.dirname(existing);
}
let current = path.join(fs.realpathSync(existing), path.relative(existing, target));
for (;;) {
  let name;
  try { name = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')).name; } catch {}
  if (['boxed-lllllabc', 'boxed-lllllabc-server'].includes(name) || ['boxed-lllllabc', 'boxed-lllllabc-server'].includes(path.basename(current))) process.exit(1);
  if (path.dirname(current) === current) break;
  current = path.dirname(current);
}
NODE

# Isolate Git from inherited repository-selection variables; keep normal URL
# rewrites and authentication. Never change global configuration or proxies.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
safe_git() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false "$@"; }
valid_install() {
  [ ! -L "$target" ] && [ -d "$target" ] || return 1
  top=$(safe_git -C "$target" rev-parse --show-toplevel 2>/dev/null) || return 1
  top=$(CDPATH= cd -P "$top" && pwd -P) || return 1
  canonical=$(CDPATH= cd -P "$target" && pwd -P) || return 1
  [ "$top" = "$canonical" ] || return 1
  origin=$(safe_git -C "$target" config --get-all remote.origin.url) || return 1
  case "$origin" in https://github.com/Yuyayun/baicaigaga.git|https://github.com/Yuyayun/baicaigaga|git@github.com:Yuyayun/baicaigaga.git|ssh://git@github.com/Yuyayun/baicaigaga.git) ;; *) return 1 ;; esac
  [ -f "$target/install.mjs" ] && [ -f "$target/bin/baicaigaga.mjs" ] && [ -f "$target/src/cli.mjs" ] || return 1
  installed_version=$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(p.name!=="baicaigaga" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(p.version))process.exit(1); console.log(p.version)' "$target/package.json") || return 1
}

if [ -e "$target" ] || [ -L "$target" ]; then
  valid_install || fail "安装目录冲突或非目标仓库，请人工检查：$target。不会删除、覆盖或更新此目录。"
  heading
  printf '  状态        ✓ 已安装\n  当前版本    %s\n' "$installed_version"
  choose '启动箱装小助手'
else
  printf '\n正在安装箱装小助手…\n'
  mkdir -p "$(dirname "$target")" || fail '无法创建助手安装路径，请检查权限。'
  mkdir "$target" || fail "安装目录已存在或权限不足：$target"
  safe_git clone --no-local --branch main --single-branch --origin origin "$repository" "$target" || fail "GitHub 网络访问或 Git clone 失败。请检查网络与权限；不完整安装目录请人工检查：$target"
  valid_install || fail "clone 不完整或 package.json 校验失败，请人工检查：$target"
  printf '✓ 已获取箱装小助手\n'
  node "$target/install.mjs" || fail '创建 baicaigaga 命令失败，请检查上方的权限或入口冲突提示。'
fi
printf '\n正在启动箱装小助手…\n'
exec node "$target/bin/baicaigaga.mjs"
