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
import { openSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const shimDirectory = join(here, 'shims')

/** Trace sink: the shared trace file when the compatibility runtime names one, else stderr. */
let sink

/** Resolve the sink once; this module runs on the loader thread, which has its own copy. */
function traceSink() {
  if (sink !== undefined) return sink
  const path = process.env.DSH_WIN7_TRACE_FILE
  try {
    sink = path === undefined || path === '' ? 2 : openSync(path, 'a')
  } catch {
    sink = 2
  }
  return sink
}

/**
 * Record one loader event, synchronously, so an abort cannot drop it.
 * @param {string} stage - Event text.
 */
function trace(stage) {
  try {
    const line = `${new Date().toISOString()} ${stage}\n`
    const target = traceSink()
    writeSync(target, line)
    // Mirrored to stderr: a shell keeps that pipe's tail, so the last modules
    // stay visible even when the trace file is lost. `DSH_WIN7_TRACE_MIRROR=0`
    // leaves stderr to the product's own diagnostics.
    if (target !== 2 && process.env.DSH_WIN7_TRACE_MIRROR !== '0') writeSync(2, line)
  } catch {
    // stderr may already be closed during teardown.
  }
}

/** Built-in specifiers replaced by a Windows 7 shim. */
const REDIRECTED = new Map([
  ['node:sqlite', pathToFileURL(join(shimDirectory, 'node-sqlite.mjs')).href],
  ['node:sea', pathToFileURL(join(shimDirectory, 'node-sea.mjs')).href],
])

/**
 * Redirect a missing built-in module to its shim, and let a bare specifier fall
 * back to the profile's own `node_modules`.
 *
 * Node 16 cannot load `node-addon-require-builtin`, so the runtime's
 * profile-scoped resolver interception installs nothing here. Without this
 * fallback, a plugin the user installed into the profile — the only packages
 * that live outside the dsh installation — cannot be imported at all: the
 * Loader asks for it by bare name from inside the installation, and Node's own
 * walk-up never reaches the profile.
 * @param {string} specifier - Requested module specifier.
 * @param {object} context - Node loader context.
 * @param {Function} nextResolve - Downstream resolver.
 * @returns {Promise<object>} Resolved module record.
 */
export async function resolve(specifier, context, nextResolve) {
  const replacement = REDIRECTED.get(specifier)
  if (replacement !== undefined) return { url: replacement, shortCircuit: true }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const fallback = isBareSpecifier(specifier) ? resolveFromProfile(specifier) : undefined
    if (fallback === undefined) throw error
    trace(`resolve profile: ${specifier} -> ${fallback}`)
    return { url: fallback, shortCircuit: true }
  }
}

/** Specifiers Node resolves itself by scheme, path or subpath import. */
function isBareSpecifier(specifier) {
  return !/^[./#]/u.test(specifier) && !specifier.includes(':')
}

/** Resolution anchored at the profile the Host was started in; the Host's cwd. */
let profileRequire

/**
 * Resolve a specifier the way Node would from the profile's package.json.
 * @param {string} specifier - Bare package specifier.
 * @returns Module URL, or undefined when the profile cannot resolve it either.
 */
function resolveFromProfile(specifier) {
  try {
    profileRequire ??= createRequire(join(process.cwd(), 'package.json'))
    return pathToFileURL(profileRequire.resolve(specifier)).href
  } catch {
    return undefined
  }
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
  trace(`loader: ${url}`)
  const loaded = await nextLoad(url, context)
  trace(`loaded: ${url}`)
  return loaded
}
