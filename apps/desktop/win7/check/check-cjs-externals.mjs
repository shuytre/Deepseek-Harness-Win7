#!/usr/bin/env node
/**
 * Gate: a CommonJS bundle the Windows 7 track ships may not `require` an ES module.
 *
 * Electron 22 embeds Node 16, whose CommonJS loader refuses an ES module with
 * `ERR_REQUIRE_ESM` and aborts the main process before `app.whenReady` — the
 * window never opens, and a Windows Server runner only sees a process that
 * never described itself. The bundle that caused it was a `require()` of a
 * workspace dependency declared `"type": "module"`, which the packaged-imports
 * policy allows because electron-builder does ship the package; what it does
 * not ship is a loader that can load it.
 *
 * The check reads the built bundles, resolves every bare `require()` the way
 * the packaged application would, and inspects the owning package manifest. It
 * needs no desktop, no Electron and no Windows 7, so it holds on any runner.
 *
 * Exit codes: 0 no violation, 1 violation, 2 nothing to check (a path or build
 * problem, never a pass).
 *
 * Usage:
 *   node apps/desktop/win7/check/check-cjs-externals.mjs [--root <dir>]
 */

import { createRequire, isBuiltin } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root: this file lives at `apps/desktop/win7/check/`. */
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
/** Bundles the shell ships; electron-builder copies this directory verbatim. */
const DEFAULT_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', 'lib')

/**
 * Specifiers a CommonJS bundle may require without the package being loadable
 * by the CommonJS loader: Electron injects itself, and Node builtins are Node's.
 */
const ALWAYS_LOADABLE = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer'])

/**
 * Read the resource root from the command line.
 * @returns Absolute directory holding the built bundles.
 */
function resolveRoot() {
  const index = process.argv.indexOf('--root')
  if (index === -1) return DEFAULT_ROOT
  const value = process.argv[index + 1]
  if (value === undefined || value.length === 0) {
    process.stderr.write('[win7] cjs-externals: --root needs a directory\n')
    process.exit(2)
  }
  return resolve(value)
}

/**
 * Every CommonJS bundle under a directory, recursively.
 * @param directory - Directory to walk.
 * @returns Absolute bundle paths.
 */
function findBundles(directory) {
  const found = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        // Bundled assets and the renderer document are not module graphs.
        if (entry.name === 'node_modules' || entry.name === 'welcome') continue
        stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.cjs')) found.push(full)
    }
  }
  return found.sort()
}

/**
 * Bare `require()` specifiers a bundle source names.
 * @param source - Bundle text.
 * @returns Specifiers in source order, each once.
 */
function bareRequires(source) {
  const seen = new Set()
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-zA-Z]:/u.test(specifier)) continue
    if (isBuiltin(specifier) || specifier.startsWith('node:')) continue
    if (ALWAYS_LOADABLE.has(specifier)) continue
    seen.add(specifier)
  }
  return [...seen]
}

/**
 * Package directory that owns a resolved module file.
 * @param file - Absolute path of the resolved entry.
 * @returns The nearest ancestor holding a package.json, or undefined.
 */
function packageDirectory(file) {
  let current = statSync(file).isDirectory() ? file : dirname(file)
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Classify one bare `require()` against the package it resolves to.
 * @param specifier - Bare specifier as written in the bundle.
 * @param from - Bundle the require appears in.
 * @returns `esm` when CommonJS cannot load the target, `unresolved` when it does
 *   not resolve from the workspace (the packaged-imports gate owns that class,
 *   and some runtime-only specifiers are guarded by a `try` in the bundle), or
 *   `loadable`.
 */
function classify(specifier, from) {
  let resolved
  try {
    resolved = createRequire(from).resolve(specifier)
  } catch (error) {
    return { verdict: 'unresolved', reason: `${error instanceof Error ? error.code ?? error.message : String(error)}` }
  }
  if (resolved.endsWith('.mjs') || resolved.endsWith('.mts')) return { verdict: 'esm', reason: `resolves to the ES module ${resolved}` }
  const directory = packageDirectory(resolved)
  if (directory === undefined) return { verdict: 'loadable' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return { verdict: 'loadable' }
  }
  if (manifest.type === 'module') return { verdict: 'esm', reason: `the package ${String(manifest.name)} declares "type": "module"` }
  return { verdict: 'loadable' }
}

const root = resolveRoot()
if (!existsSync(root)) {
  process.stderr.write(`[win7] cjs-externals: no bundle directory at ${root}\n`)
  process.exit(2)
}
const bundles = findBundles(root)
if (bundles.length === 0) {
  // A path that matches nothing passes every assertion written against it, which
  // is the failure mode this project has hit before; refuse instead of passing.
  process.stderr.write(`[win7] cjs-externals: ${root} holds no .cjs bundle, so nothing was checked\n`)
  process.exit(2)
}

let requires = 0
const violations = []
const unresolved = []
for (const bundle of bundles) {
  for (const specifier of bareRequires(readFileSync(bundle, 'utf8'))) {
    requires += 1
    const classification = classify(specifier, bundle)
    if (classification.verdict === 'esm') violations.push({ bundle, specifier, reason: classification.reason })
    else if (classification.verdict === 'unresolved') unresolved.push({ bundle, specifier, reason: classification.reason })
  }
}

for (const entry of unresolved) {
  // Reported, never fatal: a specifier the packaged application does not carry
  // is the bundled-imports gate's finding, and a guarded require of a
  // runtime-only addon is normal on this track.
  process.stdout.write(`[win7] cjs-externals: note: ${entry.bundle} requires ${entry.specifier}, not resolvable from the workspace (${entry.reason})\n`)
}
for (const violation of violations) {
  process.stderr.write(`[win7] cjs-externals: ${violation.bundle} requires ${violation.specifier}: ${violation.reason}\n`)
}
if (violations.length > 0) {
  process.stderr.write(
    `[win7] cjs-externals: ${String(violations.length)} ES module require(s) in ${String(bundles.length)} bundle(s). `
    + 'Add the package to the bundle\'s alwaysBundle list so rolldown inlines it into the CommonJS output.\n',
  )
  process.exit(1)
}
process.stdout.write(
  `[win7] cjs-externals: ${String(bundles.length)} bundles, ${String(requires)} external require(s), `
  + `${String(unresolved.length)} not resolvable from the workspace, no ES module require\n`,
)
process.exit(0)
