/**
 * Report the unused imports of the project's own TypeScript sources.
 *
 * The build treats an unused import as an error, and the check runs with
 * `noUnusedLocals`, so an import that is added but not used fails the whole
 * build. A developer without a complete installation cannot run the
 * compiler, so this check answers the same question by reading the source:
 * it names the imported bindings and reports the ones that appear nowhere
 * else in the file.
 *
 * The check is deliberately simple: it counts the occurrences of the
 * imported name outside the import statement itself. A name used only in a
 * type position still counts, because that is a use.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = process.argv[2] ?? fileURLToPath(new URL('../../../..', import.meta.url))
const SOURCE_ROOTS = [
  join(REPOSITORY_ROOT, 'apps', 'desktop', 'src'),
  join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'src'),
]

/**
 * List the TypeScript sources under a directory.
 * @param {string} root - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function collectSources(root) {
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
 * Collect the names an import statement binds.
 * @param {string} statement - Import statement.
 * @returns The bound names.
 */
function importedNames(statement) {
  const names = []
  const braces = /\{([^}]*)\}/u.exec(statement)
  if (braces !== null) {
    for (const raw of braces[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name.length > 0) names.push(name)
    }
  }
  const defaultImport = /^import\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|from)/u.exec(statement)
  if (defaultImport !== null) names.push(defaultImport[1])
  const namespaceImport = /\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(statement)
  if (namespaceImport !== null) names.push(namespaceImport[1])
  return names
}

const findings = []
let scanned = 0
for (const root of SOURCE_ROOTS) {
  for (const file of await collectSources(root)) {
    scanned += 1
    const source = await readFile(file, 'utf8')
    const importPattern = /^import\s+(?:type\s+)?[^;]*?from\s+'[^']+'/gmu
    for (const match of source.matchAll(importPattern)) {
      const statement = match[0]
      const body = source.slice(0, match.index) + source.slice(match.index + statement.length)
      for (const name of importedNames(statement)) {
        const use = new RegExp(`\\b${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')
        if (!use.test(body)) {
          findings.push({ file: relative(REPOSITORY_ROOT, file).replaceAll('\\', '/'), name })
        }
      }
    }
  }
}

if (scanned === 0) {
  // A check that inspected nothing proves nothing.
  process.stdout.write('[unused-imports] no source file was inspected; the check cannot run\n')
  process.exitCode = 2
} else if (findings.length > 0) {
  process.stdout.write(`[unused-imports] ${String(findings.length)} unused import(s)\n`)
  for (const finding of findings) process.stdout.write(`  ${finding.file}: ${finding.name}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`[unused-imports] ${String(scanned)} source file(s) inspected, no unused import\n`)
}
