/**
 * Verify that the packaged Windows 7 application can start.
 *
 * Electron 22 cannot load an ES module as the main entry point; that support
 * arrived in Electron 28. A package that declares `"type": "module"` and
 * names an ES module as its entry point makes the application fail to start
 * with a loader error and no window, and no Windows Server runner observes
 * it, because the runner runs a newer Electron that loads it happily.
 *
 * This check reads the packaged manifest and the entry point it names, and
 * reports whether the runtime can load it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ELECTRON_ESM_MAIN_MIN_VERSION, WIN7_ELECTRON_VERSION } from './electron-api-floor.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..', '..')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')

/**
 * Locate the packaged application directory of the Windows 7 build.
 * @returns The application root, or undefined when the build produced none.
 */
function findPackagedApplication() {
  const candidates = [
    join(BUILD_PATHS_ROOT, 'unsigned-artifacts', 'win-unpacked'),
    join(BUILD_PATHS_ROOT, 'artifacts', 'win-unpacked'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const packaged = findPackagedApplication()
if (packaged === undefined) {
  process.stdout.write(`[win7] entry-point: skipped, no packaged application under ${BUILD_PATHS_ROOT}\n`)
  process.exit(0)
}

const resources = join(packaged, 'resources')
const manifestPath = join(resources, 'app.asar')
if (!existsSync(manifestPath)) {
  process.stdout.write(`[win7] entry-point: skipped, the packaged application has no app.asar\n`)
  process.exit(0)
}

// The manifest is read out of the archive; the archive is read as a file and
// its manifest is at a known place inside it.
/**
 * Read the packaged manifest out of the application archive.
 * @param {string} archive - Path of the archive.
 * @returns The parsed manifest, or undefined when it cannot be read.
 */
function readManifest(archive) {
  const bytes = readFileSync(archive)
  // The asar format stores a header of a fixed layout, a JSON directory
  // tree and the file contents. The manifest is the first file in the tree,
  // so the header size is enough to find the JSON and the first content
  // offset.
  const headerSize = bytes.readUInt32LE(12)
  const header = JSON.parse(bytes.subarray(16, 16 + headerSize).toString('utf8'))
  const entry = header.files['package.json']
  if (entry === undefined) return undefined
  const contentStart = 16 + Math.ceil(headerSize / 4) * 4
  const content = bytes.subarray(contentStart + Number(entry.offset), contentStart + Number(entry.offset) + Number(entry.size))
  return JSON.parse(content.toString('utf8'))
}

let manifest
try {
  manifest = readManifest(manifestPath)
} catch (error) {
  process.stdout.write(`[win7] entry-point: the packaged manifest could not be read - ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}

if (manifest === undefined) {
  process.stdout.write('[win7] entry-point: the packaged application carries no manifest\n')
  process.exit(2)
}

const findings = []
const main = typeof manifest.main === 'string' ? manifest.main : undefined
if (main === undefined) {
  findings.push('the packaged manifest names no entry point')
} else if (manifest.type === 'module' && !main.endsWith('.cjs')) {
  // A package that declares itself an ES module can only be entered through
  // an ES module, and Electron 22 cannot do that.
  findings.push(`the entry point '${main}' is an ES module, which Electron ${WIN7_ELECTRON_VERSION} cannot load`
    + ` (ES module entry points arrived in Electron ${String(ELECTRON_ESM_MAIN_MIN_VERSION)})`)
}

if (main !== undefined) {
  // The entry point has to be in the archive, under the name the manifest
  // gives.
  const entry = main.replace(/^\.\//u, '')
  const bytes = readFileSync(manifestPath)
  const headerSize = bytes.readUInt32LE(12)
  const header = JSON.parse(bytes.subarray(16, 16 + headerSize).toString('utf8'))
  const file = header.files['lib']?.files?.[entry.split('/').pop()]
  if (file === undefined) {
    findings.push(`the packaged application does not carry its entry point '${main}'`)
  }
}

if (findings.length > 0) {
  process.stdout.write(`[win7] entry-point: ${String(findings.length)} problem(s) with the packaged entry point\n`)
  for (const finding of findings) process.stdout.write(`  ${finding}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`[win7] entry-point: the packaged application enters through '${String(main)}', which Electron ${WIN7_ELECTRON_VERSION} can load\n`)
}
