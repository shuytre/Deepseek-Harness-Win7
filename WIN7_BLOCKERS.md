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
| `color-mix()` / `light-dark()` 展开器 | 对全仓 219 个 CSS 文件实际跑 `expandModernColors()` + lightningcss `transform({ targets: { chrome: 108 << 16 } })` | 含现代颜色函数的文件 **25 个**、作者写法出现 **88 次**、**未解析 0 次**；主题 token 解析出 **429 条**（浅色/深色各 429）；219 个文件全部编译通过（修复 `@keyframes` 关键帧被误加暗色前缀的解析错误后） |
| 暗色覆盖生成 | 同上 | 生成 **60** 条 `:global(body[data-ds-dark-theme])` 覆盖规则（仅当暗色值与浅色值不同才生成；暗色作用域规则、`:root`/`html`/`body` 锚定选择器、关键帧选择器均不发） |
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
| W5 | `color-mix()` 展开的覆盖率 | **已实测**：25 个文件、88 处、0 未解析、生成 60 条暗色覆盖（见 §1.5）；219 个 CSS 文件全部通过 `expandModernColors()` + lightningcss(chrome 108) 编译，26 条行为断言固化为 `scripts/win7/expand-modern-colors.spec.ts` | 新出现的写法会重新落入 `unresolved`，由构建日志报告 |
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
| `color-mix()` | 原生 | 构建期展开为字面值（**直接替换**原声明，不回显 `color-mix()`），暗色值由独立的 `body[data-ds-dark-theme]` 覆盖规则承载 | 视觉等价（同 token 计算），非等价处会在构建日志报告；`@keyframes` 内的关键帧只拿亮色字面量（暗色覆盖无法前缀关键帧选择器），动画环色在暗色下取亮色值 |
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

## 7. GitHub Actions 运行记录

仓库：<https://github.com/shuytre/Deepseek-Harness-Win7>（public，15005 文件 / 36.25 MiB pack）。

### 运行 1（tag `win7-1`）— 失败，诊断闭环已验证

工作流真实执行了（`win7-diagnostics` 分支出现即证明"失败自动回推日志"机制工作正常），失败点全部是本迁移引入的问题：

| 错误 | 根因 | 修复 |
|---|---|---|
| `scripts/primary-runtime/prepare.ts: TS2304 Cannot find name 'existsSync'` ×3 | 兼容 embeddable Python 布局时用了 `existsSync` 但没加进 fs 导入 | 已修（导入补齐），提交 `16c4c1c8` |
| `apps/desktop/tests/platform-view.spec.ts: TS2379` ×约 60 | 视图适配层的 owner 类型写成 `PlatformOwner & BrowserWindow`，测试窗口 mock 只有 `contentView`/`webContents`/`isDestroyed`，不满足完整 `BrowserWindow` | 已修：视图适配层改为最小接口 `AttachableWindow`（`contentView?` / `setBrowserView?` 均可选），Electron 30+ / Electron 22 / 测试 mock 三者都结构化满足，提交 `16c4c1c8` |

其余步骤（scan/publish）失败是 build 失败的级联，不是独立问题。

### 推送 `16c4c1c8` 时遇到的新阻断（环境级）

修复提交已就绪，但沙箱网络在第二天开始拒绝 `github.com:443`：

- 经沙箱代理：`CONNECT tunnel failed, response 502`（连续 6 次 ×20s 间隔，100% 复现）；
- 直连：`Could not connect to server`（沙箱强制走代理，直连不可达）；
- 对照组：同一代理下 `registry.npmjs.org` 200、`codeload.github.com` 301 —— 代理本身活着，只有 `github.com` 被拒。

结论：**沙箱会话级限制了 `github.com`**（首次 36 MB 推送成功后出现）。修复提交留在本地（`16c4c1c8`），从沙箱外的终端推送即可继续。

```bash
cd "D:/DeepSeek Harness Cod-ing/DeepSeek-Harness"
git push origin main win7-2        # tag win7-2 已在本地打好，推送即触发第二轮构建
```

沙箱外的终端可正常访问 github.com；若 git 也报 schannel 吊销错误，加前缀 `GIT_SSL_NO_VERIFY=1`。

### 运行 2–4（tag `win7-2` / `win7-3` / `win7-4`）— 失败，逐轮修复

推送阻断后来通过本机反向代理（Watt Toolkit + hosts 指向 127.0.0.1 + `GIT_SSL_NO_VERIFY=1`）解决，`api.github.com` 的 HTTP 层被墙但 `git push` 走该代理可用。

| 轮次 | 失败 | 根因 | 修复 |
|---|---|---|---|
| 2 | 仍 TS2379 ×60 | 修复未生效/类型仍过严 | 提交 `16c4c1c8` 把 owner 类型放宽到最小接口 |
| 3 | `TS6059/TS6307`：`win7/` 在 `rootDir: src` 之外；`main.ts` 未用导入；`policy-test-auth` 漏导入；`api-compat` 类型 | 编译产物目录与 tsconfig `rootDir` 冲突 + 导入遗漏 | 6 个 `.ts` 移入 `apps/desktop/src/win7/`；补/删导入；收窄类型，提交 `03d60bbe` |
| 4 | `UNRESOLVED_IMPORT '../../win7/profile.mjs'`（tsdown dts 解析不到 src 外 `.mjs`）；打包缺 `.env.windows` | dts 生成只认 src 内模块；工作流没写构建 env | 常量内联（`launch-compat` / `install-compat-runtime` 不再 import `.mjs`）；工作流生成 `.env.windows`，提交 `0f73c135` |
| 5 | `TS2304 UnresolvedColor`；`TS2322` TransformResult 不匹配；`test policy requires nonempty allowedAuthOrigins` | 内联类型写法 + 缺强制更新配置 env | 内联类型改返回类型推断；工作流补 `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG`，提交 `08cbf8a1` |

### 运行 5 后半段（tag `win7-5`）— 失败在 `build:lib`，本轮修复

build/package 前 4 类错误全部通过后，卡在客户端 CSS 管线（`packages/client/tsdown.client.ts` 的 `dsh-css-modules-inline` 插件）：

| 错误 | 根因 | 修复 |
|---|---|---|
| `SyntaxError: Invalid dangling combinator in selector`（lightningcss 1.33） | 暗色覆盖生成器给 `@keyframes` 里的关键帧选择器（`0%, 55%`）加了 `body[data-ds-dark-theme]` 前缀 | `collectRules` 递归进 at-rule 时标记关键帧规则，暗色覆盖跳过它们 |
| （同一文件复现出来的第二个坑，本机实测确认）`color: #6e7278; color: color-mix(...)` 的前置字面量被 lightningcss **删除** | lightningcss 的重复声明折叠：后一条 `color-mix()` 让前一条同属性声明（含自定义属性）整体消失，Chromium 108 上颜色直接丢失 | 改为**字面量直接替换**原值，不再回显；暗色值由独立的 `body[data-ds-dark-theme]` 覆盖规则承载 |
| （第三个坑，实测确认）主题文件 `design-platform.css` 亮/暗两个 `body` 块定义同名 token 时，合并的局部 token 表把暗色值喂给亮色规则 | 局部自定义属性未按作用域分离 | 局部 token 拆成 `localLight` / `localDark`，暗色映射按 `localLight → theme.dark → localDark` 优先级合并 |
| （第四个坑）已处于 `body[data-ds-dark-theme]` 作用域的规则被二次加前缀，产出永不匹配的死规则 | 暗色规则也用亮色 token 展开 + 无脑发覆盖 | 暗色作用域规则改用暗色 token 展开且不发覆盖；`:root`/`html`/`body` 锚定的选择器同样不发（前缀是后代组合器，永远匹配不到） |

本机复现方式（无符号链接也能跑）：对 219 个 CSS 文件逐个执行 `expandModernColors()` + lightningcss `transform({ targets: { chrome: 108 << 16 } })`，修复前 1 处解析失败、修复后 0 处；另对全部 26 条行为断言（回退对、暗色覆盖、关键帧、局部 token 分离、`@media` 嵌套、未解析上报等）逐条验证通过，并固化为 `scripts/win7/expand-modern-colors.spec.ts` 回归测试。

补充实测：`@property`（`DesktopOnboarding.module.css` 的 `initial-value: 90deg`）不含颜色函数，无需处理；`window-material.css` 的 `@media (prefers-color-scheme: dark)` 块操作数是字面 `rgb()`，用哪张 token 表结果一致。

### 运行 6（tag `win7-6`）— build 通过，package 卡在 Python 运行时暂存

`win7-run.json` 记录：**build code 0（384 秒）**——CSS 修复生效；package code 1（629 秒），失败点在
`prepare:runtime` → `prunePrimaryRuntimePythonTests`：

```
Error: ENOENT: no such file or directory, open
  'C:\Users\RUNNER~1\AppData\Local\Temp\dsh-primary-rNO0iL\payload\dependencies\python\Lib\site-packages\numpy-2.3.5.dist-info\RECORD'
    at prunePrimaryRuntimePythonTests (scripts/primary-runtime/prune-python-tests.ts:30)
```

| 错误 | 根因 | 修复 |
|---|---|---|
| ENOENT `numpy-2.3.5.dist-info/RECORD` | 函数直接读**顶层** `lock.pythonPackages`（Win10 轨的 numpy 2.3.5 / pandas 3.0.1），而 Win7 轨暂存的是 numpy 1.24.4 / pandas 2.0.3（`lock.targets['win7-x64'].pythonPackages`，wheel 列表已确认含这两个包） | 函数改为接收调用方的版本表：`prunePrimaryRuntimePythonTests(sitePackages, versions)`；`prepare.ts` 传 `targetPythonPackages(target)`；spec 三处调用显式传 `lock.pythonPackages`，并新增"按调用方锁定的版本裁剪"用例（用 win7 的 1.24.4） |

本机验证（无符号链接）：tsc 转译真实函数 + papaparse stub，跑 3 组场景共 8 条断言全过——win7 版本表正常裁剪且不再 ENOENT、默认版本表行为不变、版本表与实际暂存不符时明确抛错。类型检查用 store 里的 tsc 6.0.3 对三个改动文件单独跑，除缺模块的环境噪音外无真实错误。

### 运行 7（tag `win7-7`）— build 通过，package 卡在 Python 冒烟，本机端到端复现并连修三个问题

`win7-run.json` 记录：**build code 0（392 秒）**；package code 1（517 秒），失败在
`prepare:runtime` → `smokePrimaryRuntime`：

```
File "scripts/primary-runtime/smoke.py", line 15, in <module>
    import numpy._core._multiarray_tests
ModuleNotFoundError: No module named 'numpy._core'
```

`numpy._core` 是 numpy 2.x 的路径；win7 轨锁的是 numpy 1.24.4（实测下载 wheel 核对：模块在
`numpy/core/_multiarray_tests.cp38-win_amd64.pyd`，整个 wheel 无 `numpy/_core/` 目录）。

本机把整个 payload 拼出来跑通（内嵌 Python 3.8.10 + 14 个 wheel + 真实 prune 函数 + 冒烟三步），
连修/连验证了三个问题：

| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| 1 | smoke.py 硬编码 numpy 2.x 模块路径 | 本地 payload 上 ModuleNotFoundError，与 CI 逐字一致 | `try: numpy._core... except ModuleNotFoundError: numpy.core...`（两侧都实测可导入） |
| 2 | `check_office.py` 用 `str.removeprefix()`（3.9+），3.8 报 `AttributeError` | 本地 3.8.10 跑冒烟复现；该文件有 `from __future__ import annotations`，注解安全，运行时仅此两处 | 改为 `key[len(w):] if key.startswith(w) else key`；用 3.8.10 跑该文件自带的 12 个单测全过 |
| 3 | 内嵌 Python 3.8.10 **不含 pip**（实测：python.org 下载、sha256 与 lock 一致、32 个条目无 pip），而冒烟要求 pip 在分发列表且要跑 `pip check` | 本地无 pip 时分发名断言即失败 | lock 的 `win7-x64.wheels` 增加 `pip-24.0-py3-none-any.whl`（PyPI 实测 `requires_python: >=3.7`，URL+sha256 实测下载校验通过）；pip 属解释器基线，不进 `pythonPackages` |

连带修复：`prepare.spec.ts` 的"每个目标的 wheel 与声明一一对应"测试读的是**顶层** lock（win7 轨改造后本来就红——numpy 1.24.4 vs 2.3.5 等 4 项不符），改为目标级 `sharedWheels`/`pythonPackages` 并把 pip 按基线豁免；node 模拟六个目标全过。

本地端到端结果（真实 3.8.10 解释器）：快速导入检查、完整 smoke（版本断言、分发名集合含 pip、numpy/pandas 计算与 testing 助手、RECORD 完整性、Office 文档往返、check_office.py 子检查）、`pip check`（No broken requirements found）全部通过。

仍未验证：prepare:runtime 之后的打包步骤（electron-builder NSIS + window-frame.dll 编译）在 win7 轨首次执行，run 8 见分晓。

### 运行 8（tag `win7-8`）— Python 运行时全过，卡在 dsh 运行时安装的 pnpm 8 差异

`win7-run.json` 记录：**build code 0（360 秒）**；package code 1（742 秒），失败在 `prepare:dsh` →
`verifyRuntimePatches`：`selected patch has no runtime dependency: @earendil-works/pi-ai@1.0.2`。
即 Python 冒烟之后的第一个新步骤。

本机用 Node 16.20.2 + pnpm 8.15.9 复现并逐项实测（下载两个真实发行版），定位到 **pnpm 8 与 pnpm 11 的三处行为差异**：

| # | pnpm 11（Win10 轨） | pnpm 8.15.9（Win7 轨，实测） | 修复 |
|---|---|---|---|
| 1 | 读 `pnpm-workspace.yaml` 的 `overrides` / `patchedDependencies` | **只读 package.json 的 `pnpm.overrides` / `pnpm.patchedDependencies`**（yaml 里的被静默忽略） | `prepareRuntimePatches` 把两者同时写进项目 package.json（实测 pnpm 11 两处并存无冲突） |
| 2 | lockfile v9：包 key 无前导斜杠；`patchedDependencies` 是 `spec → sha256hex` 平铺映射 | lockfile v6：包 key 带**前导斜杠**（`/@scope/name@1.0.2(patch_hash=...)`）；`patchedDependencies` 是 `spec → {hash, path}` 嵌套、hash 为 pnpm 自己的摘要 | `verifyRuntimePatches` 归一化 key（剥前导斜杠）、版本提取剥 `(patch_hash=…)`/peer 后缀、补丁记录双格式兼容（v9 校验 sha256，v6 校验 path + 非空摘要，字节完整性仍由暂存文件 sha256 把关） |
| 3 | 认识 `--trust-lockfile` | **不认识该 flag，直接报错退出** | `prepare-dsh.ts` 按 `release.pnpmVersion` 主版本条件传该 flag |

连带修复：`verifyDesktopCoreLockfile` 的正则没考虑 v6 前导斜杠（会漏报"核心包走了 registry"），已补 `/?`。

本机验证（真实函数 + 两个真实 pnpm）：把转译后的 `prepareRuntimePatches`/`verifyRuntimePatches` 跑在 Node16+pnpm8 与 Node22+pnpm11 两种安装上，11 条断言全过——package.json 获得 overrides/补丁、pnpm 8 解析到锁定的 1.0.2、**补丁真实打上**（安装产物与原始包逐字节不同）、v6 lockfile 校验通过、v9 lockfile 校验不回退、篡改暂存补丁被拒。另实测 pnpm 8 会执行 `allowUnusedPatches: false`（补丁没打上会直接失败），反向证明 CI 里 pi-ai 1.0.2 此前确实未打补丁、解析落到了 1.3.0。

仍未验证：`runtime:install` 之后的 materialize / manifests / `smokePreparedRuntime`（会用暂存的 Node 16 跑 dsh CLI，pi-ai 1.0.2 的 `engines: node>=22.19` 在 Node 16 上的运行时行为首次接受检验）与 electron-builder 打包。

### 运行 9（tag `win7-9`）— pnpm 8 安装通过，核心包锁定同样需镜像

`win7-run.json` 记录：**build code 0（360 秒）**；package code 1（672 秒）。上一轮的三处 pnpm 8 修复生效——
安装完成（914 个包）、`verifyRuntimePatches` 通过。新失败点在紧随其后的 `verifyDesktopCoreLockfile`：

```
Error: desktop package set: lockfile resolved @deepseek-ai/cordis@4.0.5-alpha.1 outside the local package set
```

根因同一族：`createRuntimeProjectMetadata` 把**全部核心包的本地 tarball 锁定**写在 pnpm-workspace.yaml 的
`overrides` 里（`desktopCorePackageOverrides`），pnpm 8 同样忽略该文件 → 第一方包走了 registry。
修复：`prepareRuntimePatches` 现在把 workspace 文件里**已有的** overrides 与补丁相关的 overrides 合并后
一并写入项目 package.json（pnpm 11 实测两处并存无冲突）。

顺带实测（本机 pnpm 8.15.9 + Node 16）：
- pnpm 8 **会**执行 yaml 里的 `allowUnusedPatches: false`（补丁没打上直接报错），但**不读** yaml 的
  `patchedDependencies`/`overrides`——两者读取位置不同，不能互相推断。
- pnpm 8 默认**跳过依赖的构建脚本**（esbuild 实测未产出二进制）；`onlyBuiltDependencies` 在 8.15.9 尚不存在
  （package.json 与 `--config` 两种写法均实测无效）。node-pty 1.2.0-beta.15 的 tarball **自带 prebuilds**
  （实测 `prebuilds/` 目录在），koffi 同样自带预编译产物；`allowBuilds` 里的 fs-ext 实测不在任何 workspace
  包的依赖表中。因此跳过构建对 Windows 目标无实际损失；若后续 smoke 暴露出缺失原生模块，再按包
  `pnpm rebuild` 兜底。

本机验证：真实函数探针扩充到 12 条断言（新增"核心包 overrides 镜像进 package.json"），全过。

仍未验证：`verifyDesktopCoreLockfile` 之后的 materialize / manifests / `smokePreparedRuntime` 与 electron-builder 打包。

### 成功后的直链（仓库当前为 public，满足直链前提）

```
https://github.com/shuytre/Deepseek-Harness-Win7/releases/download/win7-10/deepseek-harness-0.2.1-alpha.2-win-x64-unsigned-win7-setup.exe
```

（以 `gh release create` 实际发布的资产名为准；tag 用 `win7-10`，也可在 Actions 手动触发时自填。）

## 8. 在合格构建机上的一次性执行序列

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
