/**
 * Node 16 ESM loader for the Windows 7 track.
 *
 * Node 16 has no `node:sqlite` (22.5+) and no `node:sea` (20.12+), and both are
 * imported by shipped Harness packages. Redirecting them here keeps every
 * business module untouched: the packages keep importing the built-in
 * specifier, and only the resolution changes.
 *
 * Registered with `--experimental-loader <path>` (the Node 16 form; the loader
 * is passed as a file because `module.register()` only exists from Node 20.6).
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const shimDirectory = join(here, 'shims')

/** Built-in specifiers replaced by a Windows 7 shim. */
const REDIRECTED = new Map([
  ['node:sqlite', pathToFileURL(join(shimDirectory, 'node-sqlite.mjs')).href],
  ['node:sea', pathToFileURL(join(shimDirectory, 'node-sea.mjs')).href],
])

/**
 * Redirect a missing built-in module to its shim.
 * @param {string} specifier - Requested module specifier.
 * @param {object} context - Node loader context.
 * @param {Function} nextResolve - Downstream resolver.
 * @returns {Promise<object>} Resolved module record.
 */
export async function resolve(specifier, context, nextResolve) {
  const replacement = REDIRECTED.get(specifier)
  if (replacement !== undefined) return { url: replacement, shortCircuit: true }
  return nextResolve(specifier, context)
}

/**
 * Log every module the loader loads, synchronously.
 *
 * A native abort during a module's evaluation leaves no JavaScript stack; the
 * shell caps its captured stderr to the last 64 KiB, so the final logged URLs
 * name the module whose top-level code aborted.
 * @param {string} url - Module URL being loaded.
 * @param {object} context - Node loader context.
 * @param {Function} nextLoad - Downstream loader.
 * @returns {Promise<object>} Loaded module record.
 */
export async function load(url, context, nextLoad) {
  try {
    writeSync(2, `win7-loader: ${url}\n`)
  } catch {
    // stderr may already be closed during teardown.
  }
  return nextLoad(url, context)
}
