/**
 * Verify that the Desktop shell only uses Electron APIs the Windows 7 track
 * ships.
 *
 * The Windows 7 track installs Electron 22.3.27. An API introduced in a later
 * release is `undefined` there, so the call site throws during startup or
 * silently disables the feature it was written for. A CI runner on Windows
 * Server cannot observe this: the API is present, the Windows 7 user is the
 * one who sees the crash.
 *
 * The check compares the Electron members the shell uses against the type
 * definitions of the Electron release the track installs, and reports every
 * member that release does not declare. The definitions are fetched from the
 * pinned npm package rather than read from the checkout, because a checkout
 * with a newer Electron installed would otherwise report APIs as available
 * that the Windows 7 user does not have.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { WIN7_ELECTRON_VERSION } from './electron-api-floor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = join(HERE, '..', '..', '..', '..')
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')
const SOURCE_ROOTS = [join(DESKTOP_ROOT, 'src'), join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'src')]
const CACHE_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'electron-types')
const CACHED_DEFINITIONS = join(CACHE_DIRECTORY, `electron-v${WIN7_ELECTRON_VERSION}`, 'electron.d.ts')

/**
 * Resolve the type definitions of the Electron release the track installs.
 *
 * The cached copy is preferred. Otherwise the pinned npm package is fetched:
 * it carries `electron.d.ts` next to its entry point.
 * @returns Absolute path of the definitions.
 */
async function resolveTypes() {
  const explicit = process.env.DSH_WIN7_ELECTRON_TYPES
  if (explicit !== undefined && explicit.length > 0 && existsSync(explicit)) return explicit
  if (existsSync(CACHED_DEFINITIONS)) return CACHED_DEFINITIONS
  const url = `https://registry.npmjs.org/electron/-/electron-${WIN7_ELECTRON_VERSION}.tgz`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the Electron ${WIN7_ELECTRON_VERSION} package could not be fetched: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const definition = extractFromTarGz(archive, 'package/electron.d.ts')
  if (definition === undefined) throw new Error('the Electron package does not carry electron.d.ts')
  await mkdir(dirname(CACHED_DEFINITIONS), { recursive: true })
  await writeFile(CACHED_DEFINITIONS, definition)
  return CACHED_DEFINITIONS
}

/**
 * Read one file out of a gzipped tar archive.
 *
 * The archive is read in memory rather than through the `tar` command, which
 * on Windows interprets a drive letter in the target path as a remote host.
 * @param {Buffer} archive - Gzipped tar bytes.
 * @param {string} entry - Path of the wanted entry inside the archive.
 * @returns The entry contents, or undefined when it is absent.
 */
function extractFromTarGz(archive, entry) {
  const tar = gunzipSync(archive)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // A zero block marks the end of the archive.
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (name === entry) return body
    // Entries are padded to a 512-byte boundary.
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return undefined
}

/**
 * List the TypeScript sources under a directory.
 * @param {string} root - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function collectTypeScriptFiles(root) {
  const { readdir } = await import('node:fs/promises')
  const files = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) files.push(full)
    }
  }
  await walk(root)
  return files
}

/**
 * Collect the Electron members named by `import ... from 'electron'` statements.
 * @param {string} source - TypeScript source text.
 * @param {string} file - Source file path.
 * @returns {Array<{ member: string, file: string, namespace?: string }>} Imported members.
 */
function collectElectronImports(source, file) {
  const found = []
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'electron'/gu
  let match
  while ((match = pattern.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const member = raw.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()
      if (member.length === 0) continue
      found.push({ member, file })
    }
  }
  const namespacePattern = /import\s+\*\s+as\s+(\w+)\s+from\s+'electron'/gu
  while ((match = namespacePattern.exec(source)) !== null) {
    found.push({ member: '*', file, namespace: match[1] })
  }
  return found
}

/**
 * Collect the Electron members the source reaches through a namespace import.
 * @param {string} source - TypeScript source text.
 * @param {string} alias - Namespace alias.
 * @returns {string[]} Member names.
 */
function collectNamespaceMembers(source, alias) {
  const pattern = new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'gu')
  const members = new Set()
  let match
  while ((match = pattern.exec(source)) !== null) members.add(match[1])
  return [...members]
}

/**
 * Report whether a match sits inside a comment.
 *
 * A comment documents an API without calling it, so a mention of a missing
 * API in prose is not a violation.
 * @param {string} source - Source text.
 * @param {number} index - Match offset.
 * @returns Whether the match is commented out.
 */
function isCommented(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1
  if (source.slice(lineStart, index).includes('//')) return true
  const before = source.slice(0, index)
  const lastOpen = before.lastIndexOf('/*')
  if (lastOpen < 0) return false
  return before.lastIndexOf('*/') < lastOpen
}

/**
 * Collect every name the type definitions export to consumers.
 * @param {string} types - Type definition text.
 * @returns {Set<string>} Exported names.
 */
function collectExportedNames(types) {
  const names = new Set()
  const declaration = /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|namespace|const|function|let|var|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gu
  let match
  while ((match = declaration.exec(types)) !== null) names.add(match[1])
  return names
}

/**
 * Collect the members an interface declares.
 * @param {string} types - Type definition text.
 * @param {string} name - Interface name.
 * @returns {Set<string>} Member names.
 */
function collectInterfaceMembers(types, name) {
  const members = new Set()
  const interfacePattern = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'u')
  const found = interfacePattern.exec(types)
  if (found === null) return members
  const memberPattern = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?]?\s*\(/gmu
  let memberMatch
  while ((memberMatch = memberPattern.exec(found[1])) !== null) members.add(memberMatch[1])
  return members
}

/**
 * Check every Electron member the shell uses against the shipped type definitions.
 * @param {string} typesPath - Absolute path of `electron.d.ts`.
 * @returns {Promise<{ members: string[], findings: Array<{ member: string, file: string, reason: string }> }>} Report.
 */
async function checkAgainstTypes(typesPath) {
  const types = await readFile(typesPath, 'utf8')
  const declared = collectExportedNames(types)
  const protocolMembers = collectInterfaceMembers(types, 'Protocol')

  const findings = []
  const members = new Set()
  const seen = new Set()
  for (const root of SOURCE_ROOTS) {
    for (const file of await collectTypeScriptFiles(root)) {
      const source = await readFile(file, 'utf8')
      for (const entry of collectElectronImports(source, file)) {
        if (entry.member === '*') {
          for (const member of collectNamespaceMembers(source, entry.namespace ?? '')) {
            members.add(member)
            if (!declared.has(member)) {
              findings.push({ member, file, reason: `Electron ${WIN7_ELECTRON_VERSION} declares no export named '${member}'` })
            }
          }
          continue
        }
        members.add(entry.member)
        if (declared.has(entry.member)) continue
        if (entry.member === 'protocol') continue
        findings.push({ member: entry.member, file, reason: `Electron ${WIN7_ELECTRON_VERSION} declares no export named '${entry.member}'` })
      }
    }
  }

  for (const root of SOURCE_ROOTS) {
    for (const file of await collectTypeScriptFiles(root)) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(/\bprotocol\.([A-Za-z_][A-Za-z0-9_]*)/gu)) {
        const member = match[1]
        // A file name such as `protocol.ts` is not a namespace access.
        if (member === 'ts' || member === 'js' || member === 'd') continue
        // A mention inside a comment documents an API; it does not call it.
        if (isCommented(source, match.index ?? 0)) continue
        // The compatibility layer probes for the modern API by name; that is
        // how it decides which path to take, not a call to a missing API.
        if (file.includes(`${sep}win7${sep}`)) continue
        const key = `${file}:${member}`
        if (seen.has(key)) continue
        seen.add(key)
        members.add(`protocol.${member}`)
        if (!protocolMembers.has(member)) {
          findings.push({ member: `protocol.${member}`, file, reason: `Electron ${WIN7_ELECTRON_VERSION} has no protocol member '${member}'` })
        }
      }
    }
  }

  return { members: [...members].sort(), findings }
}

try {
  const typesPath = await resolveTypes()
  const report = await checkAgainstTypes(typesPath)
  const relative = (file) => file.replace(`${REPOSITORY_ROOT}/`, '').replaceAll('\\', '/')
  if (report.findings.length > 0) {
    process.stdout.write(`[win7] electron-api: ${report.findings.length} API(s) missing from Electron ${WIN7_ELECTRON_VERSION}\n`)
    for (const finding of report.findings) {
      process.stdout.write(`  ${relative(finding.file)}: ${finding.member} - ${finding.reason}\n`)
    }
    process.exitCode = 1
  } else {
    process.stdout.write(`[win7] electron-api: ${report.members.length} Electron members verified against ${WIN7_ELECTRON_VERSION}\n`)
  }
} catch (error) {
  process.stdout.write(`[win7] electron-api: could not run - ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
