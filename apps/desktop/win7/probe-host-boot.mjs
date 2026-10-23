#!/usr/bin/env node
/**
 * Boot the packaged Host directly, without the Desktop shell's process wrapper.
 *
 * The shell spawns the Host with an IPC channel on stdio 3 and a synthetic
 * profile; the per-entry import probe shows the same tree imports cleanly with
 * plain pipes. This probe boots the real Host entry over plain pipes and
 * reports whether it stays up, which separates "the boot aborts" from "the
 * boot aborts under this wrapper".
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Find the profile directory the failed smoke left behind.
 *
 * The smoke creates one temp home per boot and never removes it, so its
 * `profiles/desktop` is the exact profile the aborting boot used.
 * @returns Absolute profile directory, or undefined when none survives.
 */
export function newestSmokeProfile() {
  const root = tmpdir()
  let newest
  let newestTime = 0
  for (const name of readdirSync(root)) {
    if (!name.startsWith('dsh-desktop-smoke-')) continue
    const candidate = join(root, name, 'profiles', 'desktop')
    try {
      const time = statSync(candidate).mtimeMs
      if (time > newestTime) {
        newest = candidate
        newestTime = time
      }
    } catch {
      // A boot that never created its profile has nothing to reuse.
    }
  }
  return newest
}

/** Milliseconds the Host must stay alive to count as booted. */
const ALIVE_MS = 25_000

/**
 * Start the packaged Host and report how it ended.
 * @param options - Runtime paths and the Node 16 executable.
 * @returns Probe record with the exit code and the last output lines.
 */
export function probeHostBoot({ node, dshRoot, compat, primaryRuntime, log = () => {} }) {
  const entry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const projectDirectory = newestSmokeProfile() ?? mkdtempSync(join(tmpdir(), 'win7-host-probe-'))
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(node, [
      '--require', join(compat, 'polyfills.cjs'),
      '--experimental-json-modules',
      entry,
      dshRoot,
      projectDirectory,
      primaryRuntime,
    ], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_WIN7_COMPAT_DIR: compat,
        DSH_WIN7_MODULE_ROOTS: dshRoot,
        // Same home the smoke used, so the profile resolves to its own files.
        DSH_HOME: dirname(dirname(projectDirectory)),
        HOME: dirname(dirname(projectDirectory)),
        USERPROFILE: dirname(dirname(projectDirectory)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let alive = false
    const collect = (chunk) => {
      output += chunk
      if (output.length > 200_000) output = output.slice(-100_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      alive = true
      child.kill()
    }, ALIVE_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ verdict: 'spawn-failed', detail: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const verdict = alive ? 'alive' : 'died'
      const detail = output.trim().split('\n').slice(-8).join(' | ').slice(0, 1200)
      log(`[win7] host probe: ${verdict}${code === null ? '' : ` code ${String(code)}`} after ${String(Date.now() - started)} ms`)
      resolvePromise({ verdict, code, detail })
    })
  })
}
