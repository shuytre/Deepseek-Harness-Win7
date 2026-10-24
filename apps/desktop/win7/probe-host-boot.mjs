#!/usr/bin/env node
/**
 * Boot the packaged Host once and report how it ended.
 *
 * The Host aborts natively (`STATUS_BREAKPOINT`) with no JavaScript stack, so the
 * only reliable witness is the ordered boot trace written synchronously by the
 * compatibility preload plus the `profile-boot: booted` stage. One boot per
 * attempt lets a caller vary a single input — the executable, the mounted entry
 * count, or the entries it skips — and turn a silent native death into a verdict.
 *
 * The child is given an IPC channel on stdio 3, exactly like the Desktop shell
 * gives it: without one, `process.send` is missing and the Host exits with code 1
 * before it ever reaches the config tree.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Bytes of child output kept for the verdict tail. */
const MAX_OUTPUT = 200_000

/**
 * Default time one boot may take before the probe calls it hung.
 *
 * A boot that dies does so in about a second; a boot that succeeds reports
 * readiness over IPC within seconds and is killed immediately after.
 */
const DEFAULT_TIMEOUT_MS = 90_000

/**
 * Remove a trace file so a verdict cannot read the previous boot's `booted` line.
 * @param path - Trace file the child will append to.
 */
function resetTrace(path) {
  if (path === undefined) return
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    // A locked trace only costs a stale line; the probe still reports the exit.
  }
}

/**
 * Read the newest Node fatal-error report, which survives an abort.
 * @param directory - Directory the child writes `report.*.json` into.
 * @returns One-line summary, or undefined when the runtime wrote none.
 */
function fatalReport(directory) {
  try {
    const newest = readdirSync(directory)
      .filter(name => name.startsWith('report.') && name.endsWith('.json'))
      .map(name => ({ name, time: statSync(join(directory, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time)[0]
    if (newest === undefined) return undefined
    const report = JSON.parse(readFileSync(join(directory, newest.name), 'utf8'))
    const parts = []
    const message = report?.javascriptStack?.message
    if (typeof message === 'string') parts.push(`message: ${message}`)
    const stack = report?.javascriptStack?.stack
    if (Array.isArray(stack)) parts.push(`javascript: ${stack.slice(0, 6).join(' | ')}`)
    const native = report?.nativeStack
    if (Array.isArray(native)) parts.push(`native: ${native.slice(0, 8).map(frame => frame?.symbol ?? '?').join(' | ')}`)
    return parts.length === 0 ? `report: ${newest.name}` : parts.join('\n')
  } catch {
    return undefined
  }
}

/**
 * Start one Host process and wait for a verdict.
 * @param options - Executable, arguments, environment, working directory and trace path.
 * @returns Verdict record: whether the tree mounted, the exit code, and the witness tails.
 */
export function probeHostAttempt({
  executable, args, environment, projectDir, tracePath, reportDirectory, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {},
}) {
  resetTrace(tracePath)
  const started = Date.now()
  return new Promise((resolvePromise) => {
    let settled = false
    let output = ''
    let readyUrl
    let child
    const collect = (chunk) => {
      output += chunk
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT / 2)
    }
    const traceText = () => {
      if (tracePath === undefined) return ''
      try {
        return readFileSync(tracePath, 'utf8')
      } catch {
        return ''
      }
    }
    const finish = (outcome, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const trace = traceText()
      const booted = outcome === 'ready' || trace.includes('profile-boot: booted')
      const traceTail = trace.trim().split('\n').slice(-4).join(' | ').slice(0, 800)
      const report = booted || reportDirectory === undefined ? undefined : fatalReport(reportDirectory)
      const record = {
        verdict: booted ? 'booted' : 'died',
        outcome,
        code: code ?? null,
        ms: Date.now() - started,
        readyUrl,
        traceTail,
        outputTail: output.trim().split('\n').slice(-8).join(' | ').slice(0, 1200),
        fatal: report,
      }
      log(`[win7] boot ${executable}: ${record.verdict} (${outcome}) after ${String(record.ms)} ms${code === null ? '' : ` code ${String(code)}`}`)
      if (traceTail !== '') log(`[win7] trace tail: ${traceTail}`)
      resolvePromise(record)
      try {
        child?.kill()
      } catch {
        // The process is already gone in the ordinary case.
      }
    }
    try {
      child = spawn(executable, args, {
        cwd: projectDir,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ verdict: 'died', outcome: 'spawn-failed', code: null, ms: 0, detail: String(error) })
      return
    }
    const timer = setTimeout(() => { finish('timeout', null) }, timeoutMs)
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('message', (message) => {
      if (typeof message === 'object' && message !== null && message.type === 'ready') {
        readyUrl = typeof message.url === 'string' ? message.url : ''
        finish('ready', 0)
      }
    })
    child.on('error', (error) => {
      output += `\nspawn error: ${String(error)}`
      finish('spawn-failed', null)
    })
    child.on('close', (code) => { finish('exited', code) })
  })
}
