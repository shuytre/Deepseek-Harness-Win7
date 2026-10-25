#!/usr/bin/env node
/**
 * One-command Windows 7 SP1 x64 build.
 *
 * Runs the ordinary Desktop packaging pipeline with the Windows 7 profile
 * switched on, then scans the packaged payload for imports Windows 7 cannot
 * satisfy and publishes the installer into `dist/`.
 *
 * Steps are independent: a failing step is recorded and the run continues, so
 * one broken stage does not hide the state of the others. The process exits
 * non-zero when any required step failed.
 *
 * Usage:
 *   node apps/desktop/win7/build-win7.mjs [--skip-install] [--signed] [--skip-scan]
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { knownWin7Blocker, scanDirectory } from './check/scan-pe-imports.mjs'
import { probeEntryImports } from './probe-imports.mjs'
import { win7Profile } from './profile.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
// The step logs live at the repository root so the diagnostics commit sees them,
// but the packaging pipeline keeps its target tree beside the application it
// builds: `apps/desktop/.desktop-build/targets/<target>`.
const RUN_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const DIST_DIRECTORY = join(REPOSITORY_ROOT, 'dist')

const argumentsSet = new Set(process.argv.slice(2))
const skipInstall = argumentsSet.has('--skip-install')
const signed = argumentsSet.has('--signed')
const skipScan = argumentsSet.has('--skip-scan')
// Hosts that block spawning the Node executable from lifecycle scripts (the
// esbuild postinstall fails with EBUSY) install without scripts; native
// packages then need an explicit rebuild before packaging.
const ignoreScripts = argumentsSet.has('--ignore-scripts')

/** Packaging environment shared by every step. */
const PACKAGING_ENVIRONMENT = {
  ...process.env,
  DSH_TARGET_WIN7: '1',
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: signed ? '0' : '1',
  // The compatibility runtime writes its ordered boot trace here: inside the step
  // directory the diagnostics commit already collects, instead of inside the
  // runtime tree the packaging steps rebuild.
  DSH_WIN7_TRACE_FILE: join(RUN_DIRECTORY, 'win7-trace.log'),
  // Experiment: 'none' keeps only the polyfills a module needs to load.
  DSH_WIN7_POLYFILLS: process.env.DSH_WIN7_POLYFILLS ?? 'all',
  // The Host's experimental ESM loader is what redirects node:sqlite / node:sea
  // and, on Node 16, the only bridge from the installation to a plugin installed
  // in the profile. It was switched off while the tree abort was being bisected;
  // the abort turned out to be Electron's embedded Node, so it is on by default
  // again and '0' now only exists to run the matrix control without it.
  DSH_WIN7_ESM_LOADER: process.env.DSH_WIN7_ESM_LOADER ?? '1',
  // The Windows 7 track ships no update feed, so the policy origin stays unset.
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: process.env.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN ?? 'https://example.invalid',
}

/** Result of one pipeline step. */
const stepResults = []

/** Resolve the package manager entry point. */
function packageManagerCommand(args) {
  // A JS entry keeps the pinned pnpm usable when the host has no standalone
  // pnpm binary; PNPM_CJS points at node_modules/pnpm/bin/pnpm.cjs.
  const entry = process.env.PNPM_CJS
  if (entry !== undefined && existsSync(entry)) return [process.execPath, entry, ...args]
  return [process.env.PNPM_EXECUTABLE ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), ...args]
}

/**
 * Run one step, streaming into a log file.
 * @param name - Step name used in the report.
 * @param command - Executable and arguments.
 * @param options - Required flag and extra environment.
 * @returns Whether the step succeeded.
 */
async function runStep(name, command, options = {}) {
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  const log = join(RUN_DIRECTORY, `${name}.log`)
  process.stdout.write(`\n[win7] ${name}: ${command.join(' ')}\n`)
  const started = Date.now()
  const code = await new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: REPOSITORY_ROOT,
      env: { ...PACKAGING_ENVIRONMENT, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const chunks = []
    const collect = (chunk) => { chunks.push(chunk); process.stdout.write(chunk) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => { chunks.push(Buffer.from(String(error))); resolvePromise(1) })
    child.on('close', (exit) => {
      writeFileSync(log, Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
      resolvePromise(exit ?? 1)
    })
  })
  const result = { name, command: command.join(' '), code, seconds: Math.round((Date.now() - started) / 1000), log }
  stepResults.push(result)
  if (code !== 0 && options.required !== false) result.required = true
  return code === 0
}

/** Scan the packaged payload for Windows 7-incompatible imports. */
async function scanPackagedPayload() {
  // Signed builds land in `artifacts/`, unsigned ones in `unsigned-artifacts/`;
  // both are one level below the target root.
  const roots = ['win-unpacked', join('win-unpacked', 'resources'), 'win7-unpacked',
    join('unsigned-artifacts', 'win-unpacked'), join('artifacts', 'win-unpacked')]
    .map(name => join(BUILD_PATHS_ROOT, name))
  const root = roots.find(candidate => existsSync(candidate))
  if (root === undefined) {
    stepResults.push({ name: 'scan', code: 2, detail: `no packaged application directory under ${BUILD_PATHS_ROOT}` })
    return false
  }
  const { findings, scanned } = await scanDirectory(root)
  // Third-party binaries that only a Windows 10 SDK can produce are documented
  // downgrades, not regressions: report them separately so anything else still
  // fails the build.
  const known = findings.filter(finding => knownWin7Blocker(finding.file) !== undefined)
  const unexpected = findings.filter(finding => knownWin7Blocker(finding.file) === undefined)
  const downgrades = [...new Map(known.map(finding => {
    const blocker = knownWin7Blocker(finding.file)
    return [blocker.feature, blocker.reason]
  })).entries()].map(([feature, reason]) => ({ feature, reason }))
  const report = {
    root,
    scannedFiles: scanned.length,
    findings: unexpected,
    knownDowngrades: downgrades,
    knownFindings: known,
  }
  writeFileSync(join(RUN_DIRECTORY, 'pe-import-report.json'), `${JSON.stringify(report, undefined, 2)}\n`)
  stepResults.push({
    name: 'scan',
    code: unexpected.length === 0 ? 0 : 1,
    detail: `${scanned.length} PE files scanned, ${unexpected.length} unexpected violations, `
      + `${known.length} known third-party imports (${downgrades.map(entry => entry.feature).join(', ')})`,
  })
  for (const finding of unexpected.slice(0, 40)) {
    process.stdout.write(`[win7] violation ${finding.kind} ${finding.name} (Windows ${finding.floor}+) in ${relative(REPOSITORY_ROOT, finding.file)}\n`)
  }
  for (const entry of downgrades) {
    process.stdout.write(`[win7] known downgrade: ${entry.feature} - ${entry.reason}\n`)
  }
  return unexpected.length === 0
}

/** Copy the produced installer into `dist/` under its published name. */
function publishArtifacts() {
  const candidates = [
    join(BUILD_PATHS_ROOT, 'unsigned-artifacts'),
    join(BUILD_PATHS_ROOT, 'artifacts'),
  ].filter(directory => existsSync(directory))
  const published = []
  for (const directory of candidates) {
    for (const name of readdirSync(directory)) {
      if (!/win7/iu.test(name) || !/setup.*\.exe$/iu.test(name)) continue
      const source = join(directory, name)
      if (!statSync(source).isFile()) continue
      mkdirSync(DIST_DIRECTORY, { recursive: true })
      const destination = join(DIST_DIRECTORY, name)
      cpSync(source, destination)
      published.push(destination)
      const blockmap = `${source}.blockmap`
      if (existsSync(blockmap)) cpSync(blockmap, `${destination}.blockmap`)
    }
  }
  stepResults.push({
    name: 'publish',
    code: published.length === 0 ? 1 : 0,
    detail: published.length === 0 ? 'no *win7*setup.exe artifact found' : published.join(', '),
  })
  return published
}

/**
 * Copy the compatibility runtime's boot trace beside the step logs.
 *
 * The trace names the exact stage and module where the packaged Host aborted;
 * it lives inside the runtime tree, which the diagnostics commit does not
 * otherwise collect.
 */
function collectBootTrace() {
  const compat = join(BUILD_PATHS_ROOT, 'runtime', 'win7-compat')
  // The runtime writes its fatal-error report beside the compatibility files;
  // that report is the only place a native stack survives the abort.
  if (existsSync(compat)) {
    for (const name of readdirSync(compat)) {
      if (!/^report\..*\.json$/u.test(name) && !name.endsWith('.mdmp')) continue
      mkdirSync(RUN_DIRECTORY, { recursive: true })
      cpSync(join(compat, name), join(RUN_DIRECTORY, name))
    }
  }
  const source = PACKAGING_ENVIRONMENT.DSH_WIN7_TRACE_FILE
  if (!existsSync(source)) {
    const listing = existsSync(compat) ? readdirSync(compat).join(', ') : 'no compat runtime directory'
    stepResults.push({ name: 'trace', code: 1, detail: `no boot trace at ${source}; compat holds: ${listing}` })
    return
  }
  const destination = join(RUN_DIRECTORY, 'win7-trace.log')
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  if (resolve(source) !== resolve(destination)) cpSync(source, destination)
  const lines = readFileSync(destination, 'utf8').split('\n').filter(Boolean)
  stepResults.push({
    name: 'trace',
    code: 0,
    detail: `${String(lines.length)} lines; last: ${lines.slice(-6).join(' | ')}`,
  })
}

/**
 * Import each traced entry in its own process and record which one dies.
 *
 * The Host aborts natively, so the parent sees one exit code and no stack; a
 * per-entry child process converts that into a named verdict.
 */
async function probeEntryImportsFromTrace() {
  const tracePath = PACKAGING_ENVIRONMENT.DSH_WIN7_TRACE_FILE
  const probeFile = join(RUN_DIRECTORY, 'win7-probe.json')
  // The packaging step replays the imports itself, while the runtime exists.
  if (existsSync(probeFile)) {
    const probe = JSON.parse(readFileSync(probeFile, 'utf8'))
    stepResults.push({ name: 'probe', code: probe.deadCount === 0 ? 0 : 1, detail: probe.summary, probes: probe.probeCount })
    return
  }
  if (!existsSync(tracePath)) {
    stepResults.push({ name: 'probe', code: 2, detail: `no boot trace at ${tracePath}` })
    return
  }
  const dshRoot = join(BUILD_PATHS_ROOT, 'dsh')
  const compat = join(BUILD_PATHS_ROOT, 'runtime', 'win7-compat')
  const electron = findElectron()
  const missing = [
    existsSync(dshRoot) ? undefined : `dsh (${dshRoot})`,
    existsSync(electron) ? undefined : `electron (${electron})`,
    existsSync(join(compat, 'polyfills.cjs')) ? undefined : `compat (${compat})`,
  ].filter(entry => entry !== undefined)
  if (missing.length > 0) {
    const listing = existsSync(BUILD_PATHS_ROOT) ? readdirSync(BUILD_PATHS_ROOT).join(', ') : 'no target directory'
    stepResults.push({ name: 'probe', code: 2, detail: `missing ${missing.join(', ')}; target holds ${listing}` })
    return
  }
  const { specifiers, summary, deadCount, probeCount } = await probeEntryImports({
    electron,
    dshRoot,
    compat,
    tracePath,
    log: (line) => { process.stdout.write(`${line}\n`) },
  })
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  writeFileSync(join(RUN_DIRECTORY, 'win7-probe.json'), `${JSON.stringify({ summary, specifiers }, undefined, 2)}\n`)
  stepResults.push({ name: 'probe', code: deadCount === 0 ? 0 : 1, detail: summary, probes: probeCount })
}

/**
 * Locate the packaged Node 16 executable among the downloaded Electron layouts.
 * @returns Absolute path to `electron.exe`, or the conventional path when none matched.
 */
function findElectron() {
  const conventional = join(BUILD_PATHS_ROOT, 'electron', 'electron.exe')
  if (existsSync(conventional)) return conventional
  if (!existsSync(BUILD_PATHS_ROOT)) return conventional
  for (const name of readdirSync(BUILD_PATHS_ROOT)) {
    if (!name.toLowerCase().startsWith('electron')) continue
    for (const candidate of [join(BUILD_PATHS_ROOT, name, 'electron.exe'), join(BUILD_PATHS_ROOT, name, 'electron', 'electron.exe')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return conventional
}

/**
 * Surface the boot matrix in the run report.
 *
 * The matrix is written while the runtime still exists; its verdicts name which
 * mount aborts, and the run report is what a blocked failure can read back.
 */
function reportBootMatrix() {
  const path = join(RUN_DIRECTORY, 'win7-boot-matrix.json')
  if (!existsSync(path)) {
    // The matrix is only written by the on-failure probe. A packaging step that
    // completed never needed it, so its absence is the healthy outcome.
    stepResults.push({ name: 'boot-matrix', code: 0, detail: 'not produced: no boot aborted during packaging' })
    return
  }
  const matrix = JSON.parse(readFileSync(path, 'utf8'))
  // The native stack is the only line in the report that can name the frame the
  // breakpoint was raised from, so it travels with the summary instead of waiting
  // for the full diagnostic archive.
  const debuggerNote = typeof matrix.debugStack === 'string' && matrix.debugStack !== ''
    ? ` || debugger: ${matrix.debugStack}`.slice(0, 4000)
    : ''
  stepResults.push({
    name: 'boot-matrix',
    code: 0,
    detail: `${String(matrix.summary)}${debuggerNote}`,
    attempts: Array.isArray(matrix.attempts) ? matrix.attempts.length : 0,
  })
}

async function main() {
  const profile = win7Profile(PACKAGING_ENVIRONMENT)
  process.stdout.write(`[win7] profile: Electron ${profile.electronVersion}, Node ${profile.nodeVersion}, Python ${profile.pythonVersion}\n`)
  if (!skipInstall) {
    // The Windows 7 track adds dependencies the Win10 lockfile does not carry
    // (a Node 16 fetch stack, the SQLite driver), so the lockfile is updated
    // rather than frozen on this branch.
    // `--child-concurrency=1` serializes lifecycle scripts: parallel ones make
    // the esbuild postinstall fail with EBUSY on a host where the Node
    // executable itself is being scanned.
    await runStep('install', packageManagerCommand(['install', '--no-frozen-lockfile', '--child-concurrency=1',
      ...(ignoreScripts ? ['--ignore-scripts'] : [])]))
  }
  // The build treats an unused import as an error. A developer without a
  // complete installation cannot run the compiler, so this check answers the
  // same question by reading the sources. It runs before the build so the
  // reason for a build failure is visible on its own.
  await runStep('unused-imports', ['node', join('apps', 'desktop', 'win7', 'check', 'check-unused-imports.mjs')])
  await runStep('build', packageManagerCommand(['run', 'build']))
  // The Windows 7 API floors are checked before packaging: an API the Windows
  // 7 runtime does not have is `undefined` there, so the call site throws
  // while the shell is still starting. A Windows Server runner has the newer
  // API, so only this comparison can observe the difference.
  await runStep('electron-api', ['node', join('apps', 'desktop', 'win7', 'check', 'check-electron-api.mjs')])
  await runStep('native-api', ['node', join('apps', 'desktop', 'win7', 'check', 'check-native-api.mjs')])
  await runStep('package', packageManagerCommand(['--dir', 'apps/desktop', 'run', signed ? 'package:win:x64' : 'package:win:x64:unsigned']))
  // The packaged application is started and observed: the probe reports the
  // renderer errors, the failed loads and the crashes a Windows 7 user sees.
  await runStep('user-probe', ['node', join('apps', 'desktop', 'win7', 'probe', 'run-user-probe.mjs')])
  if (!skipScan) await scanPackagedPayload()
  collectBootTrace()
  await probeEntryImportsFromTrace()
  reportBootMatrix()
  const published = publishArtifacts()
  // The installer itself is run: a silent install that completes and leaves
  // the application and its runtime in place is an installation that works.
  await runStep('install-check', ['node', join('apps', 'desktop', 'win7', 'probe', 'check-installation.mjs')])
  writeFileSync(join(RUN_DIRECTORY, 'win7-run.json'), `${JSON.stringify({
    schemaVersion: 1,
    profile,
    signed,
    steps: stepResults,
    installed: published.map(path => relative(REPOSITORY_ROOT, path)),
  }, undefined, 2)}\n`)
  process.stdout.write(`\n[win7] steps:\n${stepResults.map(result => `  ${result.code === 0 ? 'ok  ' : 'fail'} ${result.name}${result.detail === undefined ? '' : ` - ${result.detail}`}`).join('\n')}\n`)
  process.stdout.write(`[win7] report: ${relative(REPOSITORY_ROOT, join(RUN_DIRECTORY, 'win7-run.json'))}\n`)
  const failed = stepResults.filter(result => result.code !== 0)
  if (failed.length > 0) process.exitCode = 1
}

await main()
