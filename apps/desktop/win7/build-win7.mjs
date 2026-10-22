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
import { scanDirectory } from './check/scan-pe-imports.mjs'
import { win7Profile } from './profile.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const RUN_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, '.desktop-build', 'targets', 'win-x64')
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
  const roots = ['win-unpacked', join('win-unpacked', 'resources'), 'win7-unpacked'].map(name => join(BUILD_PATHS_ROOT, name))
  const root = roots.find(candidate => existsSync(candidate))
  if (root === undefined) {
    stepResults.push({ name: 'scan', code: 2, detail: `no packaged application directory under ${BUILD_PATHS_ROOT}` })
    return false
  }
  const { findings, scanned } = await scanDirectory(root)
  const report = {
    root,
    scannedFiles: scanned.length,
    findings,
  }
  writeFileSync(join(RUN_DIRECTORY, 'pe-import-report.json'), `${JSON.stringify(report, undefined, 2)}\n`)
  stepResults.push({
    name: 'scan',
    code: findings.length === 0 ? 0 : 1,
    detail: `${scanned.length} PE files scanned, ${findings.length} Windows 7 violations`,
  })
  for (const finding of findings.slice(0, 40)) {
    process.stdout.write(`[win7] ${finding.kind} ${finding.name} (Windows ${finding.floor}+) in ${relative(REPOSITORY_ROOT, finding.file)}\n`)
  }
  return findings.length === 0
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
  const source = join(BUILD_PATHS_ROOT, 'runtime', 'win7-compat', 'win7-trace.log')
  if (!existsSync(source)) {
    stepResults.push({ name: 'trace', code: 1, detail: 'the compatibility runtime wrote no boot trace' })
    return
  }
  const destination = join(RUN_DIRECTORY, 'win7-trace.log')
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  cpSync(source, destination)
  const lines = readFileSync(destination, 'utf8').split('\n').filter(Boolean)
  stepResults.push({
    name: 'trace',
    code: 0,
    detail: `${String(lines.length)} lines; last: ${lines.slice(-6).join(' | ')}`,
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
  await runStep('build', packageManagerCommand(['run', 'build']))
  await runStep('package', packageManagerCommand(['--dir', 'apps/desktop', 'run', signed ? 'package:win:x64' : 'package:win:x64:unsigned']))
  if (!skipScan) await scanPackagedPayload()
  collectBootTrace()
  const published = publishArtifacts()
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
