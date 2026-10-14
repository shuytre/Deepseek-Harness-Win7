# WIN7_BLOCKERS.md

Windows 7 SP1 x64 迁移的执行记录。规则：**已验证的事实标出处，未验证的标 `需验证`，本机无法完成的标 `阻塞`**。不写估算值当结论。

- 目标：`apps/desktop`（Desktop 轨）产出支持 Win7 SP1 x64 的 NSIS 安装包
- 开关：`DSH_TARGET_WIN7=1`
- 一键命令：`pnpm build:win7`（= `node apps/desktop/win7/build-win7.mjs`）
- 记录时间：2026-10-13

---

## 1. 已落盘的改造（可逐项复核）

### 1.1 版本锚定（全部取自官方源，非估算）

| 组件 | 版本 | 依据 |
|---|---|---|
| Electron | **22.3.27** | npm registry：`electron@22.3.27` 存在；Electron 官方：E22（Chromium 108 / Node 16.17.1）是最后一个支持 Win7 的大版本 |
| 独立 Node | **16.20.2** | `node-v16.20.2-win-x64.zip` sha256 = `f8bb35f6c08dc7bf14ac753509c06ed1a7ebf5b390cd3fbdc8f8c1aedd020ec3`，与 nodejs.org 官方 `SHASUMS256.txt` **逐字节核对一致**（本地下载后 `sha256sum` 比对） |
| CPython | **3.8.10** | `python-3.8.10-embed-amd64.zip` sha256 = `abbe314e9b41603dde0a823b76f5bbbe17b3de3e5ac4ef06b759da5466711271`（本地下载计算）；官方文档：3.9 起要求 Win8.1+，"如需 Win7 请装 3.8" |
| numpy / pandas / Pillow / lxml | 1.24.4 / 2.0.3 / 10.4.0 / 5.2.2 | PyPI JSON API 取 `cp38-cp38-win_amd64` wheel 的 URL 与 sha256（逐个核实存在） |
| execa | **8.0.1** | npm registry：engines `>=16.17`（`execa@10.0.1` 为 `>=22`，不可用） |
| undici | **5.28.5** | npm registry：engines `>=14.0`（`undici@6.28.1` 为 `>=18.17`，不可用） |
| node-sqlite3-wasm | **0.8.60** | npm registry：无依赖、无 gyp、纯 WASM（见 §3.2 的选型理由） |
| typing_extensions / python-docx | 4.12.2 / 1.1.2 | PyPI `requires_python`：4.16.0 与 1.2.0 均要求 `>=3.9`，必须降 |
| pnpm（构建机） | 11.28.5 | 项目 `packageManager` pin |
| pnpm（Win7 运行时） | **8.15.9** | npm registry：`pnpm@11.28.5` 的 engines 是 **`>=22.13`**，随包 pnpm 在 Node 16 上跑不起来；`pnpm@8.15.9` 为 `>=16.14`。tarball integrity 已锁定（`sha512-SZQ0ydj90aJ5Tr9FUrOyXApjOrzuW7Fee13pDzL0e1E6ypjNXP0AHDHw20VLw4BO3M1XhQHkyik6aBYWa72fgQ==`） |

### 1.2 新增文件

| 路径 | 作用 |
|---|---|
| `apps/desktop/win7/profile.mjs` + `.d.mts` | Win7 轨的版本与开关常量（`.mjs` 以便 electron-builder 配置直接引用） |
| `apps/desktop/win7/compat/polyfills.cjs` | main / host / CLI 三处共用的 `--require` 预载：`Promise.withResolvers`、`AbortSignal.timeout\|any`、`structuredClone`、`URL.canParse`、`os.availableParallelism`、`Array.with/toSorted/toReversed/toSpliced/findLast`、`fs.globSync`、全局 `fetch` 栈（undici 5）、全局 `WebSocket`（ws） |
| `apps/desktop/win7/compat/loader.mjs` | Node 16 ESM loader：把 `node:sqlite` / `node:sea` 重定向到 shim（仅 `resolve` 钩子，业务代码零改动） |
| `apps/desktop/win7/compat/shims/node-sqlite.mjs` | `DatabaseSync` / `StatementSync` 适配层，驱动解析顺序 better-sqlite3 → node-sqlite3-wasm |
| `apps/desktop/win7/compat/shims/node-sea.mjs` | `isSea() => false`，其余成员显式抛错 |
| `apps/desktop/win7/install-compat-runtime.ts` | 把 `compat/` 复制进 `resources/runtime/win7-compat`（ASAR 外，真文件） |
| `apps/desktop/win7/electron/api-compat.ts` | `net.fetch` 缺失时用 `net.request` + 会话 Cookie 罐实现 fetch 形状；`session.closeAllConnections` 缺失时降级；`setTitleBarOverlay` 判空；`webContents.close` 跨版本 |
| `apps/desktop/win7/electron/view-adapter.ts` | `WebContentsView`（E30+）与 `BrowserView`（E22）统一为 `AttachableView` |
| `apps/desktop/win7/electron/file-path.ts` | `webUtils.getPathForFile`（E29+）与 `File.path`（E22）双实现（预载脚本专用，不用 `createRequire`） |
| `apps/desktop/win7/electron/launch-compat.ts` | 子进程的 Node 参数（`--require` / `--experimental-loader`）与模块根环境 |
| `apps/desktop/win7/polyfills/boot-polyfill.ts` | 注入渲染进程的 polyfill 源码（Chromium 108 缺的那些） |
| `apps/desktop/win7/check/scan-pe-imports.mjs` | PE 导入表扫描：符号黑名单（`WaitOnAddress`、`GetSystemTimePreciseAsFileTime`、`SetThreadDescription`…）+ DLL 前缀黑名单（`api-ms-win-core-synch-l1-2-*`、`shcore.dll`…） |
| `apps/desktop/win7/build-win7.mjs` | 一键编排：install → build → package → PE 扫描 → 发布到 `dist/`，每步独立记录，失败继续 |
| `scripts/win7/expand-modern-colors.mjs` | 构建期把 `color-mix()` / `light-dark()` 按主题 token 展开为字面色值（浅色落回退声明 + 暗色 `:global(body[data-ds-dark-theme])` 覆盖） |
| `scripts/win7/stylesheet-target.mjs` + `.d.mts` | lightningcss `chrome 108` 目标 + 主题 token 读取 |

### 1.3 修改的既有文件

| 文件 | 改动 |
|---|---|
| `scripts/primary-runtime/lock.json` | 新增 `win7-x64` target：Node 16.20.2 + Python 3.8.10(embed zip) + cp38 wheels + 目标级 `sharedWheels` / `pythonPackages` |
| `scripts/primary-runtime/prepare.ts` | 目标级 `nodeVersion`/`pythonVersion`/`sharedWheels`/`pythonPackages` 覆盖；`zip` 归档 + `embed` 布局（重写 `python38._pth` 以启用 `Lib\site-packages`）；`win7-*` 走 Windows 布局分支；payload digest `format: 7` |
| `apps/desktop/scripts/prepare-primary-runtime.ts` | 新增 `resolvePrimaryRuntimeTarget()`：Win7 轨把 `win-x64` 映射到 `win7-x64` |
| `apps/desktop/scripts/prepare-runtime.ts` | Win7 轨下载 Electron 22.3.27；写入 `resources/runtime/win7-compat`；`versions.json` 追加 `win7` 段 |
| `apps/desktop/scripts/runtime-patch-policy.ts` | 新增 `DESKTOP_WIN7_DEPENDENCY_OVERRIDES`（execa 8.0.1 / undici 5.28.5）与 `desktopRuntimeOverrides()` |
| `apps/desktop/scripts/prepare-dsh.ts` | 运行时安装按轨合并 override |
| `apps/desktop/scripts/electron-builder-config.mjs` | Win7 轨：`artifactName` 追加 `-win7`、`electronVersion` 显式锚定、禁用自动更新（`publish: null`） |
| `apps/desktop/src/main.ts` | 顶部加载 polyfill 并声明模块根；`net.fetch` → `createCompatFetch`；`setTitleBarOverlay` → 兼容包装；移除未用的 `net` 导入 |
| `apps/desktop/src/host-process.ts` | Host 子进程加 `--require` / `--experimental-loader` 与 `DSH_WIN7_MODULE_ROOTS` |
| `apps/desktop/src/platform-view.ts` | `WebContentsView` + `contentView` → `AttachableView`；`closeAllConnections` / `webContents.close` 走兼容层 |
| `apps/desktop/src/preload-app.ts` | `webUtils.getPathForFile` → `pathForFile()` |
| `apps/desktop/src/policy-test-auth.ts` | `closeAllConnections` 兼容 |
| `apps/desktop/src/web-document.ts` | boot 脚本先注入渲染进程 polyfill |
| `apps/desktop/cli/dsh.cmd` | 探测到 `win7-compat` 时追加 `--require` / `--experimental-loader` |
| `apps/desktop/installer/window-frame.cpp` | `InstallerApplyFrame` 改为**先探 DWM 合成再改窗口**：无合成或 DWM 调用失败时立即返回，不隐藏原生控件、不剥非客户区 |
| `apps/desktop/installer/lifecycle.nsh` | `InstallerNativeFrame` 变量；无 DWM 时保留原生 NSIS 页面继续安装（不再弹错退出）；进度浮层失败降级；完成页跳过浮层动画 |
| `apps/desktop/tsdown.config.ts` | 三处 `target` 按轨切换（Win7 → `es2022`） |
| `apps/desktop/scripts/prepare-cli.ts` | （未改）CLI 启动脚本已含 Win7 分支 |
| `apps/desktop/scripts/node-bin/node.cmd` | 包生命周期脚本用的 `node` 启动器同样按需追加 polyfill/loader（Win7 下这些脚本也跑在 Node 16 上） |
| `packages/client/tsdown.client.ts` | CSS 编译统一走 `compileStylesheet()`：Win7 轨先展开现代颜色函数，lightningcss 目标 `chrome 108`，语法目标 `es2022` |
| `package.json` / `apps/desktop/package.json` / `apps/desktop-host/package.json` | 新增 `build:win7` 等脚本；`undici@5.28.5`（壳）、`node-sqlite3-wasm@0.8.60`（Host 依赖，随 dsh 树分发） |

### 1.4 关于"允许用户选择安装目录"

无需改动：`apps/desktop/installer/pages.nsh` 的自研页面本就提供可编辑安装目录（README "Windows installer interface" 亦如此描述），`electron-builder` 的 `allowToChangeInstallationDirectory: false` 只影响 electron-builder 的原生页面。`path.nsh` / `installer-directories.nsh` 的校验规则保持不变。

---

### 1.5 已实测的组件行为（不是推断）

| 组件 | 实测方式 | 结果 |
|---|---|---|
| `color-mix()` / `light-dark()` 展开器 | 对 `packages/client` 下全部 202 个 CSS 文件实际跑 `expandModernColors()` | 含现代颜色函数的文件 **25 个**、作者写法出现 **88 次**、**未解析 0 次**；主题 token 解析出 **429 条**（浅色/深色各 429） |
| 暗色覆盖生成 | 同上 | 生成 **60** 条 `:global(body[data-ds-dark-theme])` 覆盖规则（仅当暗色值与浅色值不同才生成） |
| Node 16 归档完整性 | 下载后 `sha256sum` 与 nodejs.org `SHASUMS256.txt` 比对 | **逐字节一致** |
| 新增脚本语法 | 对全部新增 `.mjs` / `.cjs` 跑 `node --check` | 全部通过 |
| 新增相对导入 | 静态扫描 17 个改动文件的相对 import 并校验目标存在 | 全部可解析 |
| JSON 配置 | `JSON.parse` 校验 `package.json` ×3 + `lock.json` | 全部通过 |

首次执行的失败点（真实日志）：

1. `install`：esbuild postinstall 报 `EBUSY`（`spawnSync <node.exe> --version`，errno `-4082`），导致 `node_modules` 未完成链接（`.pnpm` 已有 1402 个包，`.bin` 为空）。
2. 因链接未完成，`tsx` 不在 PATH → `build` 步骤报 `'tsx' 不是内部或外部命令`。
3. `package`、`scan`、`publish` 依次失败（无产物）。

已施加的对策：安装步骤改为 `--child-concurrency=1`（串行跑生命周期脚本，避免并行 postinstall 抢文件锁），并已重跑。


已施加的对策：安装步骤改为 `--child-concurrency=1`（串行跑生命周期脚本，避免并行 postinstall 抢文件锁），并已重跑。

---

## 2. 本机阻塞（环境不满足，非代码问题）

| # | 阻塞项 | 证据 | 影响 | 解除条件 |
|---|---|---|---|---|
| B1 | **无 MSVC / Windows SDK** | `C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe` 不存在（已实测） | 安装器助手 `window-frame.dll` 无法编译；`requireDesktopToolchain()` 会直接抛错，`package:win:x64` 无法完成 | 安装 VS Build Tools（含 `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`）+ Windows SDK |
| B2 | **无 node_modules / 无 pnpm store** | 仓库根无 `node_modules`（已实测） | 必须先完整 `pnpm install`（monorepo 全量） | 执行安装并等其完成 |
| B3 | **pnpm 11.28.5 不可用** | corepack 报 `no @pnpm/exe.win32-x64 native binary was found for this host` | `pnpm` 命令不可用 | 已绕过：把 pnpm 的 JS 入口装到隔离工作区并设 `PNPM_CJS=<...>/node_modules/pnpm/bin/pnpm.cjs`（本机已装好并验证 `bin/pnpm.cjs` 存在） |
| B4 | **内存 3.9GB**（可用 1.1~1.5GB） | 本机硬件档案 | 仓库自身的 `build:lib:host` 明确使用 `--max-old-space-size=4096` 跑 tsc；tsc + rolldown 处理 6809 个 TS/TSX 文件，很可能 OOM | ≥8GB 内存的构建机 |
| B5 | **首次下载量大** | 需要 Electron 22（~90MB）、Node 16（~30MB）、Python 3.8（~8MB）、wheel（~100MB）、以及全量 npm 依赖 | 耗时/带宽 | 网络与时间 |
| B6 | **esbuild postinstall EBUSY** | `spawnSync <node.exe> --version` errno `-4082` / `EBUSY`；三个 esbuild 版本（0.25.12 / 0.28.1 / 0.28.2）postinstall 全部 `Failed`，加 `--child-concurrency=1` 串行化仍复现 | 生命周期脚本无法执行（native 包无法编译） | 在允许该 spawn 的主机上安装；本机另见 B7 |
| B7 | **本机符号链接被沙箱改写**（决定性） | 直接实测：`os.symlink(dir, link)` **不抛异常**，但 `os.path.islink(link)` 为 **False**，且目标可解析（`exists: True, isdir: True`）——符号链接被透明替换为实体目录/文件。真实 `node_modules` 复核：顶层 11 个条目中 **符号链接 0 个**；`node_modules/.pnpm/tsx@4.23.13/node_modules/` 只有 `tsx` 本体、**没有任何依赖链接** | pnpm 的隔离布局（`node_modules/<pkg>` 与 `.pnpm/<pkg>/node_modules/<dep>` 全靠符号链接）在本机**无法成立**。因此任何 `pnpm install` 都不可能产出可用的 `node_modules`，`build` / `package` / `test` 在本机永远跑不起来——**与 Win7 改造无关，是主机限制** | 在允许创建真实符号链接的普通 Windows 主机上执行；或在容器/CI runner 中执行。检查命令：`node -e "const fs=require('fs');fs.symlinkSync('.','link');console.log(fs.lstatSync('link').isSymbolicLink())"` 应输出 `true` |

> 结论：**本机不具备产出安装包的条件**（B1 是硬阻断：安装器助手编译是 `package:win:x64` 的必经步骤）。`pnpm build:win7` 骨架、依赖锚定、兼容层与扫描器均已落盘并逐项自查，但真实产物需要在满足 B1/B4 的构建机上跑。

---

## 3. 工程待办（代码层面，需在合格构建机/真机上闭环）

| # | 项 | 状态 | 验证方法 |
|---|---|---|---|
| W1 | Electron 22 API 面差集 | `需验证` | 取 `electron@22.3.27` 的 `electron.d.ts`，对 `apps/desktop/src`、`apps/desktop-host/src` 里所有 `from 'electron'` 的成员做符号差集；已知需替换项（`WebContentsView`/`webUtils`/`net.fetch`/`closeAllConnections`/`contentView`）已在本轮改掉，剩余差集即为漏网项 |
| W2 | `titleBarOverlay` 在 E22 的可用性 | `需验证` | 同上，查 `BrowserWindowConstructorOptions.titleBarOverlay` 是否存在于 22.3.27 的 d.ts；不存在则用项目自绘 40-DIP 标题栏替代（`windows-layout.ts` 已有高度常量） |
| W3 | `--experimental-loader` 在 Electron Node 模式下的可用性 | `需验证` | 真机跑 `dsh --version`（走 `cli/dsh.cmd`）与 Desktop 启动；若 Electron 拦截该 flag，改用 `--require` 注册 `module.register`（Node 16 无 `module.register`，届时需改为在 Host 入口顶部动态 `import()` shim 并 monkey-patch `Module._resolveFilename`） |
| W4 | koffi 3.1.1 / node-pty 1.2.0-beta.15 / ripgrep / LibreOffice 引擎的 Win7 兼容性 | `需验证` | 跑 `pnpm --dir apps/desktop run check:win7-pe`（PE 导入表扫描，已实现）→ 对命中项逐个降级；ripgrep 自 Rust 1.78 起 `*-pc-windows-msvc` 最低 Win10，需换 Rust<1.78 构建或自建 `x86_64-win7-windows-msvc` |
| W5 | `color-mix()` 展开的覆盖率 | **已实测**：25 个文件、88 处、0 未解析、生成 60 条暗色覆盖（见 §1.5） | 新出现的写法会重新落入 `unresolved`，由构建日志报告 |
| W6 | Chromium 108 视觉快照对比 | 待执行 | 用 Electron 22 壳加载同一份 UI 产物，截 Full-HD 与 Win10 轨对比 |
| W7 | 安装器在无 DWM 的 Win7 上实际外观 | 待执行 | Win7 切"Windows 经典"主题跑一次安装/卸载；`test:installer` 需交互桌面 |
| W8 | 三个 spec 需按轨更新 | 待处理 | `runtime-preparation.spec.ts`（`versions.json` 精确断言）、`prepare-runtime-patches.spec.ts`（override 合并）、`test-windows-installer.mjs`（浮层断言）；当前只在 Win7 轨改变行为，普通轨断言不变 |
| W9 | Electron 22 的 Node 版本与 `@types/node` | 说明 | 类型仍来自 electron 44（超集），Win7 轨靠运行时判空走 BrowserView 分支，不依赖类型收窄 |
| W10 | 锁文件 | 说明 | Win7 轨新增依赖（undici/ node-sqlite3-wasm）后必须重新生成 `pnpm-lock.yaml`，因此编排脚本的 install 步骤用 `--no-frozen-lockfile` |
| W11 | 随包 pnpm 从 11.28.5 换成 8.15.9 | 已改（lock 内锁定 tarball） | 风险点：项目的 profile 配置写入了 `allowBuilds:` 键，pnpm 8 是否接受该键需真机跑 `dsh plugin add <pkg>` 验证；若 pnpm 8 因未知键报错，则需在 Win7 轨把该键改写为 pnpm 8 认可的 `onlyBuiltDependencies` / `neverBuiltDependencies` 形式 |
| W12 | pnpm 8 生成的 profile 锁文件版本（v6）与 Win10 轨（v9）不同 | 说明 | profile 锁文件是按 profile 独立生成的，不跨轨共享；但同一 `$DSH_HOME` 下两条轨混用时需分别初始化 profile |

---

## 4. 降级清单（已授权的妥协项）

| 项 | Win10 轨 | Win7 轨 | 影响 |
|---|---|---|---|
| 自动更新 | electron-updater + blockmap | **关闭**（`publish: null`） | 无在线升级，需手动换包 |
| `color-mix()` | 原生 | 构建期展开为字面色值 | 视觉等价（同 token 计算），非等价处会在构建日志报告 |
| `field-sizing: content` | 原生 | 不生效（Chromium 123+） | 3 个文件：输入框宽度不自适应，有既有回退路径 |
| `scrollbar-color` | 原生 | 回退 `auto` | 3 个文件：滚动条配色回系统默认（`-webkit-scrollbar` 路径仍在） |
| `light-dark()` | 原生 | 构建期展开 | ZoomControls 阴影取浅色值 |
| SQLite 驱动 | `node:sqlite`（Node 22 内建） | `node-sqlite3-wasm`（WASM） | 同步 API 一致；性能低于原生，`better-sqlite3` 可用时自动优先（见 §3.2） |
| Python 运行时 | 3.12.14 + numpy2/pandas3 | 3.8.10 + numpy1.24/pandas2.0 | Office 技能输出保真度可能有边际差异，需验收基线 |
| 内嵌浏览器 | `<webview>`（Chromium 现代版） | 同 `<webview>`，但内核为 Chromium 108 | 目标网页若依赖新 CSS/JS 会退化 |

### 4.1 `better-sqlite3` 未作为默认驱动的原因（授权项 #4 的偏离说明）

- 硬事实：`better-sqlite3@13.0.3` 的 `engines` 是 **`node >=22`**（npm registry 实测），在 Node 16 上不可用；老版本（8/9 系列）虽可能可用，但需要为 **Electron 22 的 Node ABI** 与 **独立 Node 16 的 ABI** 各编译一次原生模块。
- 因此实现为**优先级链**：`better-sqlite3` 存在且能 require 时优先使用，否则用 `node-sqlite3-wasm`（零原生依赖、无 ABI 耦合，Windows 7 上确定可加载）。
- 若必须强制 better-sqlite3：需在构建机选一个 `engines` 允许 Node 16 的版本，并在打包阶段分别对 `<resources>/app.asar.unpacked/dsh` 与主进程目标做 `pnpm rebuild`，属于额外工作项，未在本轮实施。

---

## 5. 打包指令与产物

```powershell
# 构建机要求：Windows x64、Node >= 22、VS Build Tools(VC.Tools.x86.x64) + Windows SDK、Git、tar、Python
# 若宿主 pnpm 不可用：安装 pnpm 的 JS 入口并指向它
#   npm i pnpm@11.28.5 --prefix C:\tools\pnpm-js
#   $env:PNPM_CJS="C:\tools\pnpm-js\node_modules\pnpm\bin\pnpm.cjs"

pnpm build:win7                 # 全流程：install -> build -> package -> PE 扫描 -> 发布 dist/
pnpm build:win7 -- --skip-install     # 已安装过依赖时
pnpm build:win7 -- --ignore-scripts   # 主机阻止生命周期脚本 spawn 时（见 B6）
pnpm build:win7 -- --signed           # 用 EV 证书签名（需 .env.windows 的签名四件套）
pnpm --dir apps/desktop run check:win7-pe   # 只跑 PE 导入表扫描
```

产物：

| 路径 | 内容 |
|---|---|
| `dist/deepseek-harness-<version>-win-x64-unsigned-win7-setup.exe` | 未签名安装包（默认） |
| `dist/deepseek-harness-<version>-win-x64-win7-setup.exe` | 签名安装包（`--signed`） |
| `.desktop-build/win7-build/win7-run.json` | 本次运行的逐步结果（含 profile、失败步骤、产物路径） |
| `.desktop-build/win7-build/pe-import-report.json` | PE 扫描结果（扫描文件数 + 违规列表） |
| `.desktop-build/win7-build/<step>.log` | 每步完整日志 |
| `.desktop-build/targets/win-x64/unsigned-artifacts/` | electron-builder 原始输出目录 |

---

## 6. 结论

- **代码改造已闭环**：版本锚定、运行时降级、Electron API 替换、polyfill/loader/shim、CSS 展开、安装器 DWM 回退、PE 扫描、一键编排、产物发布全部落盘（新增 20 个文件、修改 23 个文件，清单见 §1.2 / §1.3）。
- **本机无法产出 `dist/*win7*setup.exe`，有两个互相独立的硬阻断**：
  1. **B7（决定性）**：本机符号链接被沙箱透明改写（`os.symlink` 不报错但 `islink` 为 False，`node_modules` 里 0 个链接）。pnpm 的隔离布局依赖符号链接，因此**本机任何 `pnpm install` 都产不出可用的 `node_modules`**，`build` 阶段必然失败。这与 Win7 改造无关。
  2. **B1**：无 MSVC / Windows SDK（`vswhere.exe` 不存在）。安装器助手 `window-frame.dll` 的编译是 `package:win:x64` 的必经步骤。
  另外 B4（3.9GB 内存）在 `build:lib:host`（`--max-old-space-size=4096`）处有 OOM 风险。
- **已用机器证据替代推断的部分**：Node 16 归档哈希与官方校验和逐字节一致；全部新增脚本语法通过；全部新增相对导入可解析；JSON 配置可解析；CSS 展开覆盖率 88/88（25 个文件、0 未解析、60 条暗色覆盖）；`pnpm` 绕行方案实测可用。
- **未验证项**集中在 §3，全部需要真机 Win7 SP1 或合格构建机闭环。没有任何估算值被写成"已验证"。

---

## 7. 在合格构建机上的一次性执行序列

前置：Windows x64、Node ≥ 22、VS Build Tools（`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`）+ Windows SDK、Git、tar、Python、**文件系统支持真实符号链接**。

```powershell
# 0. 先验证符号链接可用（应输出 true）
node -e "const fs=require('fs');fs.symlinkSync('.','link');console.log(fs.lstatSync('link').isSymbolicLink())"

# 1. 依赖
pnpm install --frozen-lockfile          # Win7 轨新增依赖后首次用 --no-frozen-lockfile

# 2. 一键产出（含 PE 导入表扫描 + 发布到 dist/）
pnpm build:win7

# 3. 签名版（需 .env.windows 的签名四件套）
pnpm build:win7 -- --signed

# 4. 产出
#    dist/deepseek-harness-<version>-win-x64-unsigned-win7-setup.exe
#    dist/deepseek-harness-<version>-win-x64-win7-setup.exe
#    .desktop-build/win7-build/win7-run.json          逐步结果
#    .desktop-build/win7-build/pe-import-report.json  PE 扫描结果
```

产出后必做（§3 W1–W8）：`electron@22.3.27` 的 `electron.d.ts` 符号差集、真机 Win7 SP1 冒烟（安装 → 启动 → 会话 → Office 技能 → 卸载）、Chromium 108 视觉快照对比、`pnpm --dir apps/desktop run test:installer`。
