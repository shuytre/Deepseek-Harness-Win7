/** Materialize the complete production runtime before publishing Desktop resources. */

import { packagingStep } from './packaging-step.mjs'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { createPluginProfile, createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { prepareRuntimeManifests } from './prepare-runtime-manifests.ts'
import { prepareRuntimePatches, verifyRuntimePatches } from './prepare-runtime-patches.ts'
import { desktopRuntimeOverrides } from './runtime-patch-policy.ts'
import { probeHostAttempt } from '../win7/probe-host-boot.mjs'
import { probeEntryImports } from '../win7/probe-imports.mjs'
import { stripJsonImportAttributesInTree } from '../win7/strip-json-import-attributes.mjs'
import { WIN7_COMPAT_DIRECTORY, win7Profile } from '../win7/profile.mjs'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
  resolveNpmRegistry,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
const STORE_ROOT = join(BUILD_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const PNPM = join(RUNTIME_ROOT, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const registry = resolveNpmRegistry(process.env)
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    // pnpm 8 does not read nodeLinker, autoInstallPeers or the engines-check
    // Node identity from pnpm-workspace.yaml; the .npmrc form reaches every
    // pnpm generation. node-version lets the staged Node 16 resolve packages
    // that declare the Node 22 floor the Win10 track's dependencies require.
    writeFileSync(userConfig, 'node-linker=hoisted\nauto-install-peers=false\nnode-version=22.19.0\n')
    const child = spawn(NODE, [
      '--expose-internals',
      PNPM,
      `--config.registry=${registry}`,
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        ...desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), {}),
        PATH: `${join(RUNTIME_ROOT, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

/** One boot in the matrix: a single varying input, and what the boot proved. */
interface BootMatrixAttempt {
  readonly label: string
  readonly entries?: number | undefined
  readonly skipped?: readonly string[] | undefined
  readonly verdict: string
  readonly outcome: string
  readonly code: number | null
  readonly ms: number
  readonly traceTail?: string | undefined
  readonly outputTail?: string | undefined
  readonly fatal?: string | undefined
}

/** Every boot the diagnostic ran, plus the one line that names the finding. */
interface BootMatrix {
  readonly tracePath: string
  readonly attempts: readonly BootMatrixAttempt[]
  readonly summary: string
}

/**
 * Boot the Host with one input changed at a time, and name where the tree aborts.
 *
 * The Host dies natively inside the config tree with no JavaScript stack, and the
 * per-entry import probe shows every row imports on its own, so the verdict has to
 * come from a boot. Each attempt is a fresh Host process with its own profile and
 * its own trace file; `profile-boot: booted` in that trace — not the exit code — is
 * what distinguishes "the tree mounted" from "the process died", because a boot
 * that mounts still exits non-zero when it is killed after reporting readiness.
 * @returns Attempts in execution order, and a summary line for the build log.
 */
async function bootMatrix(): Promise<BootMatrix> {
  const compat = join(RUNTIME_ROOT, WIN7_COMPAT_DIRECTORY)
  const primaryRuntime = join(RUNTIME_ROOT, 'primary-runtime')
  const entry = join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-win7-boot-'))
  const profileDirectory = join(home, 'profiles', 'desktop')
  createPluginProfile(profileDirectory)
  writeFileSync(join(home, 'npmrc'), '')
  const runDirectory = dirname(process.env.DSH_WIN7_TRACE_FILE ?? join(home, 'win7-trace.log'))
  const tracePath = join(runDirectory, 'win7-boot-matrix-trace.log')
  // The profile the smoke would have used is deleted with its temp home, so the
  // matrix builds one: a boot needs a profile, not the smoke's plugin rows.
  const baseEnvironment: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), process.env))
      .filter(([, value]) => value !== undefined)),
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home, HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
    npm_config_userconfig: join(home, 'npmrc'),
    npm_config_globalconfig: join(home, 'npmrc'),
    DSH_WIN7_COMPAT_DIR: compat,
    DSH_WIN7_MODULE_ROOTS: DSH_OUTPUT_ROOT,
    DSH_WIN7_TRACE_REQUIRE: '1',
    // The trace mirror floods the child's stderr, which is the only pipe a fatal
    // report and an uncaught error reach; the matrix reads the file instead.
    DSH_WIN7_TRACE_MIRROR: '0',
    DSH_WIN7_TRACE_FILE: tracePath,
  }
  const args = [
    '--require', join(compat, 'polyfills.cjs'),
    '--experimental-json-modules',
    '--report-on-fatalerror',
    '--report-directory', compat,
    entry,
    DSH_OUTPUT_ROOT,
    profileDirectory,
    primaryRuntime,
    join(primaryRuntime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    join(RUNTIME_ROOT, 'bin'),
  ]
  const attempts: BootMatrixAttempt[] = []
  const boot = async (label: string, extra: {
    entries?: number
    skipped?: readonly string[]
    args?: readonly string[]
    ipc?: boolean
    aliveMs?: number
    timeoutMs?: number
    environment?: Record<string, string | undefined>
  }): Promise<BootMatrixAttempt> => {
    const environment = { ...baseEnvironment, ...(extra.environment ?? {}) }
    if (extra.entries !== undefined) environment.DSH_WIN7_MAX_ENTRIES = String(extra.entries)
    if (extra.skipped !== undefined) environment.DSH_WIN7_SKIP_ENTRIES = extra.skipped.join(',')
    process.stdout.write(`desktop runtime: win7 boot probe ${label}\n`)
    const result = await probeHostAttempt({
      executable: NODE,
      args: extra.args ?? args,
      environment,
      projectDir: profileDirectory,
      tracePath,
      reportDirectory: compat,
      timeoutMs: extra.timeoutMs ?? 90_000,
      aliveMs: extra.aliveMs,
      ipc: extra.ipc,
      log: (line: string) => { process.stdout.write(`${line}\n`) },
    })
    const attempt: BootMatrixAttempt = {
      label,
      entries: extra.entries,
      skipped: extra.skipped,
      verdict: result.verdict,
      outcome: result.outcome,
      code: result.code,
      ms: result.ms,
      traceTail: result.traceTail,
      outputTail: result.outputTail,
      fatal: result.fatal,
    }
    attempts.push(attempt)
    return attempt
  }
  // Controls first: if a process that only sleeps dies on the same clock, the
  // abort belongs to the runtime or to the preload, not to the config tree.
  const controlScript = join(home, 'win7-control.mjs')
  writeFileSync(controlScript, "setTimeout(() => { process.stdout.write('control alive\\n') }, 3000)\n")
  const polyfills = join(compat, 'polyfills.cjs')
  await boot('control: polyfills + ipc', { args: ['--require', polyfills, controlScript], aliveMs: 2_500, timeoutMs: 15_000 })
  await boot('control: no preload, ipc', { args: [controlScript], aliveMs: 2_500, timeoutMs: 15_000 })
  await boot('control: polyfills, no ipc', { args: ['--require', polyfills, controlScript], ipc: false, aliveMs: 2_500, timeoutMs: 15_000 })
  await boot('whole tree', {})
  // The preload replaces globals, patches builtin module objects and installs a
  // fetch stack; keeping only what a module needs to load tests that set.
  await boot('whole tree, minimal polyfills', { environment: { DSH_WIN7_POLYFILLS: 'none' } })
  const one = await boot('first entry only', { entries: 1 })
  const two = await boot('first two entries', { entries: 2 })
  // The row the failed trace names last is the one whose mount aborts; dropping it
  // and booting everything else separates "this row is the fault" from "any second
  // row is the fault".
  const timerRow = '@deepseek-ai/cordis-plugin-timer'
  await boot(`whole tree without ${timerRow}`, { skipped: [timerRow] })
  // A boundary between the mount counts that still boot and the first that dies
  // names the row without needing the trace to survive the abort.
  if (one.verdict === 'booted' && two.verdict === 'died') {
    for (const entries of [4, 8, 16]) {
      const attempt = await boot(`${String(entries)} entries`, { entries })
      if (attempt.verdict === 'died') break
    }
  }
  const summary = attempts.map(attempt => `${attempt.label}: ${attempt.verdict}${attempt.code === null ? '' : ` (${String(attempt.code)})`}`).join('; ')
  process.stdout.write(`desktop runtime: win7 boot matrix -> ${summary}\n`)
  return { tracePath, attempts, summary }
}


async function main(): Promise<void> {
  try {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:reset', async () => {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
      rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
      mkdirSync(STORE_ROOT, { recursive: true })
    })
    const release = desktopRelease()
    const patches = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:stage-packages', async () => {
      copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
      cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
      createRuntimeProjectMetadata(BUILD_ROOT, release)
      // The Windows 7 track constrains execa/undici to versions whose engines
      // floor Node 16 satisfies; the Win10 track keeps the reviewed overrides.
      return prepareRuntimePatches(BUILD_ROOT, resolve(APP_ROOT, '..', '..'), undefined,
        desktopRuntimeOverrides(win7Profile().enabled))
    })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:lockfile', () => runPnpm(['install', '--lockfile-only']))
    verifyRuntimePatches(BUILD_ROOT, patches)
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    // pnpm 10 introduced --trust-lockfile for the v9 lockfile's integrity
    // field; the Windows 7 track stages pnpm 8, which rejects the flag outright.
    const trustLockfile = Number.parseInt(release.pnpmVersion, 10) >= 10 ? ['--trust-lockfile'] : []
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:install', () => runPnpm(['install', '--prod', '--frozen-lockfile', ...trustLockfile]))
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: desktopTargetPlatform(targetName).arch }
    const modules = join(BUILD_ROOT, 'node_modules')
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:materialize-modules', async () => {
      cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
        recursive: true, dereference: true,
        filter: source => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
      })
    })
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    if (process.platform === 'darwin' && process.env.DSH_DESKTOP_UNSIGNED !== '1') {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:dsh-native', () => signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, join(BUILD_PATHS.root, 'signature-cache')))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:primary-native', () => signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, join(BUILD_PATHS.root, 'signature-cache')))
    }
    // Windows 7 / Node 16 cannot parse a JSON import attribute, and providers
    // ship one data module per model with the attribute attached. Rewrite before
    // the manifests record the tree, so the shipped bytes stay verified.
    if (win7Profile().enabled) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:win7-json-attributes', async () => {
        const outcome = stripJsonImportAttributesInTree(join(DSH_OUTPUT_ROOT, 'node_modules'), line => process.stdout.write(`${line}\n`))
        process.stdout.write(`desktop runtime: json import attributes removed in ${String(outcome.files)} files\n`)
      })
    }
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:primary-smoke', async () => smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime')))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:write-descriptor', async () => writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target))
    const verifiedDescriptor = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-before-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    if (!process.argv.includes('--defer-runtime-smoke')) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:smoke', () => smokePreparedRuntime(DSH_OUTPUT_ROOT, NODE, RUNTIME_ROOT, verifiedDescriptor))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-after-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    }
  } catch (error) {
    // A Windows 7 diagnostic run replays the failed boot's entry imports here,
    // while the produced runtime still exists, and keeps the tree afterwards:
    // the probe needs the same tree and the same Node 16 the Host used.
    const tracePath = process.env.DSH_WIN7_TRACE_FILE
    if (tracePath === undefined) {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    } else {
      try {
        const result = await probeEntryImports({
          electron: NODE,
          dshRoot: DSH_OUTPUT_ROOT,
          compat: join(RUNTIME_ROOT, WIN7_COMPAT_DIRECTORY),
          tracePath,
          log: (line) => { process.stdout.write(`${line}\n`) },
        })
        // The Host launches with a flag the probe does not; replaying the first
        // entries with it says whether that flag is what kills the boot.
        const withInternals = await probeEntryImports({
          electron: NODE,
          dshRoot: DSH_OUTPUT_ROOT,
          compat: join(RUNTIME_ROOT, WIN7_COMPAT_DIRECTORY),
          tracePath,
          extraArgs: ['--expose-internals'],
          limit: 3,
          log: (line) => { process.stdout.write(`${line}\n`) },
        })
        // The shell wraps the Host with an IPC channel and a synthetic profile, so
        // the boot is repeated here with the same channel and one input changed at
        // a time: the whole tree, one row, two rows, and the tree minus the row the
        // failed trace names last. That names the row whose mount aborts without a
        // debugger and without relying on the trace surviving the abort.
        const matrix = await bootMatrix()
        writeFileSync(join(dirname(tracePath), 'win7-boot-matrix.json'), `${JSON.stringify(matrix, undefined, 2)}\n`)
        writeFileSync(join(dirname(tracePath), 'win7-probe.json'), `${JSON.stringify({
          ...result,
          exposeInternals: withInternals,
          bootMatrix: matrix,
        }, undefined, 2)}\n`)
        process.stdout.write(`desktop runtime: win7 entry probe -> ${result.summary}\n`)
      } catch (probeError) {
        process.stdout.write(`desktop runtime: win7 entry probe failed: ${String(probeError)}\n`)
      }
    }
    throw error
  } finally {
    let cleaned = false
    const cleanup = (): void => {
      try { rmSync(BUILD_ROOT, { recursive: true, force: true }) }
      finally { rmSync(PNPM_BUILD_STATE, { recursive: true, force: true }) }
      cleaned = true
    }
    try { await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:cleanup', async () => cleanup()) }
    finally { if (!cleaned) cleanup() }
  }
}

await main()
