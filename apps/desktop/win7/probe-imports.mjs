#!/usr/bin/env node
/**
 * Import each plugin entry the failed boot named, one child process per entry.
 *
 * The Windows 7 Host aborts natively while the config tree mounts, and a native
 * abort leaves no JavaScript stack in the parent's captured stderr. Importing
 * one specifier per child process turns that single invisible crash into a
 * per-entry verdict: a child that aborts names the entry that kills the boot,
 * and children that all succeed mean the abort needs the tree's interaction
 * rather than one module.
 *
 * Each probe runs from the loader package's own directory, so a bare specifier
 * resolves exactly as the Loader resolves it at runtime.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory a bare specifier is resolved from: the Loader's own package. */
const LOADER_PACKAGE = join('node_modules', '@deepseek-ai', 'cordis-plugin-loader')

/** Milliseconds one probe may run before it counts as hung. */
const PROBE_TIMEOUT_MS = 60_000

/**
 * Collect the specifiers the boot trace named, in first-seen order.
 * @param tracePath - Boot trace written by the compatibility runtime.
 * @returns Entry specifiers, excluding Cordis builtins.
 */
export function tracedSpecifiers(tracePath) {
  const seen = new Set()
  const text = readFileSync(tracePath, 'utf8')
  for (const line of text.split('\n')) {
    const match = /tree\.import: (\S+)$/u.exec(line)
    if (match === null) continue
    const specifier = match[1]
    if (specifier.startsWith('cordis:')) continue
    seen.add(specifier)
  }
  return [...seen]
}

/**
 * Import one specifier in its own Node 16 process.
 * @param options - Runtime paths and the specifier to try.
 * @returns The probe verdict.
 */
function probeOne(options) {
  const { electron, dshRoot, compat, specifier, index, extraArgs = [] } = options
  const loaderDirectory = join(dshRoot, LOADER_PACKAGE)
  const probePath = join(loaderDirectory, `win7-probe-${String(index)}.mjs`)
  const source = [
    "import { writeSync } from 'node:fs'",
    `const specifier = ${JSON.stringify(specifier)}`,
    'try {',
    '  const namespace = await import(specifier)',
    "  writeSync(1, `PROBE_OK ${String(Object.keys(namespace).length)}\\n`)",
    '  process.exit(0)',
    '} catch (error) {',
    "  writeSync(2, `PROBE_ERROR ${error && error.stack ? error.stack.split('\\n').slice(0, 3).join(' | ') : error}\\n`)",
    '  process.exit(1)',
    '}',
    '',
  ].join('\n')
  writeFileSync(probePath, source)
  return new Promise((resolvePromise) => {
    const child = spawn(electron, [
      '--require', join(compat, 'polyfills.cjs'),
      '--experimental-json-modules',
      ...extraArgs,
      probePath,
    ], {
      cwd: loaderDirectory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_WIN7_COMPAT_DIR: compat,
        DSH_WIN7_MODULE_ROOTS: dshRoot,
        DSH_WIN7_TRACE_REQUIRE: '',
        DSH_WIN7_TRACE_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ specifier, code: -1, verdict: 'spawn-failed', detail: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try { rmSync(probePath, { force: true }) } catch { /* the next run overwrites it */ }
      if (code === 0 && stdout.includes('PROBE_OK')) {
        resolvePromise({ specifier, code, verdict: 'ok' })
        return
      }
      if (stdout.includes('PROBE_OK')) {
        resolvePromise({ specifier, code, verdict: 'ok', detail: `exit ${String(code)}` })
        return
      }
      const errorLine = stderr.split('\n').find(line => line.startsWith('PROBE_ERROR')) ?? stderr.trim().split('\n').pop() ?? ''
      // The smoke plugin is a synthetic row the packaging smoke mounts from a
      // fixture, so "not installed" is its documented state, not a verdict.
      const absent = specifier.startsWith('desktop-runtime-smoke') && errorLine.includes('ERR_MODULE_NOT_FOUND')
      resolvePromise({
        specifier,
        code,
        verdict: absent ? 'absent' : timedOut ? 'timeout' : code === 0 ? 'import-error' : 'process-died',
        detail: timedOut ? `still running after ${String(PROBE_TIMEOUT_MS)} ms` : errorLine.slice(0, 600),
      })
    })
  })
}

/**
 * Probe every traced entry import.
 * @param options - Build paths and the trace to read.
 * @returns Probe records and a one-line summary.
 */
export async function probeEntryImports({ electron, dshRoot, compat, tracePath, log, extraArgs = [], limit }) {
  // The packaging smoke's Host appends to the same trace, so its two fixture
  // rows reach this list. They are never part of a user's boot and their
  // package is deleted with the smoke's temporary home, so they carry no
  // verdict about the runtime.
  const specifiers = tracedSpecifiers(tracePath)
    .filter(specifier => !/^desktop-(?:runtime|installed)-smoke/u.test(specifier))
    .slice(0, limit)
  const results = []
  for (const [index, specifier] of specifiers.entries()) {
    const result = await probeOne({ electron, dshRoot, compat, specifier, index, extraArgs })
    results.push(result)
    log(`[win7] probe ${String(index + 1)}/${String(specifiers.length)} ${result.verdict} ${specifier}${result.detail === undefined ? '' : ` :: ${result.detail}`}`)
  }
  const died = results.filter(result => result.verdict === 'process-died' || result.verdict === 'import-error')
  const summary = died.length === 0
    ? `${String(results.length)} entries imported, none killed its process`
    : `${String(died.length)} of ${String(results.length)} entries killed their process: ${died.map(result => result.specifier).join(', ')}`
  return { specifiers: results, summary, probeCount: results.length, deadCount: died.length }
}
