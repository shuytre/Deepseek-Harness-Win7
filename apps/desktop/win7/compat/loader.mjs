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
import { dirname, isAbsolute, join, relative } from 'node:path'
import { existsSync, openSync, readFileSync, writeSync } from 'node:fs'
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

/** Report that the loader is live: a launch that omits `--experimental-loader` traces nothing here. */
trace(`loader registered (cwd=${process.cwd()})`)

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
    if (fallback === undefined) {
      // Same text as the failure the caller will see, plus the directory the
      // profile walk-up would have used when the Host's cwd is not a profile.
      trace(`resolve miss: ${specifier} ${error?.code ?? ''}`.trimEnd())
      throw error
    }
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
 *
 * `require.resolve` applies the `require` condition, so an ESM-only plugin that
 * declares just `import` in its `exports` map throws there even though the Loader
 * - itself ESM - could import it. Fall back to walking `node_modules` and picking
 * the entry the way an ESM importer would, which is what makes third-party
 * plugins installable on Node 16.
 * @param {string} specifier - Bare package specifier.
 * @returns Module URL, or undefined when the profile cannot resolve it either.
 */
function resolveFromProfile(specifier) {
  try {
    profileRequire ??= createRequire(join(process.cwd(), 'package.json'))
    const resolved = profileRequire.resolve(specifier)
    // The fallback exists for the plugins the user installed into this profile,
    // and for the packages beside the application, which the profile is not an
    // ancestor of. Node's CommonJS resolution also reaches the npm global
    // folder, where the user's own installation of the same product lives;
    // serving that copy made the Host run another release of itself, with
    // client bundles this build never produced. Nothing else may answer.
    if (isForeignInstallation(resolved)) {
      trace(`resolve refused outside the profile: ${specifier} -> ${resolved}`)
      return undefined
    }
    return pathToFileURL(resolved).href
  } catch {
    const entry = findPackageEntry(specifier)
    return entry === undefined ? undefined : pathToFileURL(entry).href
  }
}

/**
 * Whether a path lies inside a directory.
 * @param {string} root - Directory that must contain the path.
 * @param {string} candidate - Absolute path to test.
 * @returns Whether the candidate is inside the root.
 */
function isInside(root, candidate) {
  const relation = relative(root, candidate)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

/**
 * Whether a resolution lands in another installation of the product.
 *
 * Node's CommonJS resolution reaches the npm global folder on Windows, which is
 * where the user's own `dsh` command line installation lives. Serving that copy
 * made the Host run another release of itself: its client bundles were built
 * for that release, their dependencies stayed external, and the browser's
 * module table had no entry for them. The shims and the application's own tree
 * stay allowed — only a foreign installation is refused.
 * @param {string} resolved - Absolute path the fallback produced.
 * @returns Whether the path belongs to another installation.
 */
function isForeignInstallation(resolved) {
  const appData = process.env.APPDATA
  const foreign = []
  if (appData !== undefined && appData !== '') foreign.push(join(appData, 'npm', 'node_modules'))
  for (const entry of (process.env.NODE_PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    foreign.push(entry)
  }
  foreign.push(join(dirname(process.execPath), 'node_modules'))
  return foreign.some(root => isInside(root, resolved))
}

/**
 * Locate a package directory under a `node_modules` above the working directory.
 * @param {string} specifier - Bare specifier, optionally with a subpath.
 * @returns Absolute path to the package's entry file, or undefined.
 */
function findPackageEntry(specifier) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(name.length).replace(/^\//u, '')
  let directory = process.cwd()
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      return entryOf(candidate, subpath)
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Pick the file a package's `exports`/`main` points at, for the "." subpath.
 * @param {string} directory - Package directory.
 * @param {string} subpath - Requested subpath without a leading slash, may be empty.
 * @returns Absolute entry path, or undefined when the manifest names nothing usable.
 */
function entryOf(directory, subpath) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (subpath !== '') return join(directory, subpath)
  const exported = manifest.exports
  const candidate = typeof exported === 'string'
    ? exported
    : exported?.['.'] === undefined
      ? undefined
      : typeof exported['.'] === 'string'
        ? exported['.']
        : exported['.'].import ?? exported['.'].node ?? exported['.'].default
  const chosen = candidate ?? manifest.module ?? manifest.main ?? 'index.js'
  return join(directory, chosen)
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
