/**
 * Check the native code the Windows 7 track ships for APIs Windows 7 lacks.
 *
 * A binary that imports an API Windows 7 does not have does not load: the
 * process fails with a loader error and no message, which is exactly the
 * kind of fault a Windows Server runner cannot reproduce. The two faults
 * this check exists to prevent are both in code the project owns, so the
 * check reads the project's own sources rather than a global API table.
 *
 * Two failure shapes are covered:
 *
 *   * a symbol that Windows 7 SP1 does not export;
 *   * a symbol that exists but whose newer attribute or flag the code passes
 *     is rejected on Windows 7, which surfaces as an unsupported request
 *     rather than as a load failure.
 *
 * The check reports every use, whether it is compiled in or not, because a
 * use behind a version guard is still a use that has to be right.
 */

import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIN7_ABSENT_CONSTANTS, WIN7_ABSENT_C_RUNTIME, WIN7_ABSENT_SYMBOLS, WIN7_ABSENT_DLL_PATTERNS } from './win7-native-rules.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SOURCE_DIRECTORIES = [
  join(REPOSITORY_ROOT, 'apps', 'desktop', 'installer'),
  join(REPOSITORY_ROOT, 'native'),
]

/**
 * List the native sources under a directory.
 * @param {string} root - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function collectNativeFiles(root) {
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
      if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu.test(entry.name)) files.push(full)
    }
  }
  await walk(root)
  return files
}

/**
 * Report whether a match sits inside a comment.
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
 * Find every use of a symbol in a source file.
 *
 * A use inside a comment is reported separately: a comment that names an API
 * the platform does not have is where a future edit reintroduces the call,
 * so it is worth pointing at even though it does not fail the build today.
 * @param {string} source - Source text.
 * @param {RegExp} pattern - Symbol pattern.
 * @returns {Array<{ name: string, line: number, commented: boolean }>} Uses.
 */
function findUses(source, pattern) {
  const uses = []
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index ?? 0).split('\n').length
    uses.push({ name: match[0], line, commented: isCommented(source, match.index ?? 0) })
  }
  return uses
}

const findings = []
const mentions = []
let scannedFiles = 0
for (const directory of SOURCE_DIRECTORIES) {
  for (const file of await collectNativeFiles(directory)) {
    scannedFiles += 1
    const source = await readFile(file, 'utf8')
    const shown = relative(REPOSITORY_ROOT, file).replaceAll('\\', '/')
    const rules = [
      { table: WIN7_ABSENT_SYMBOLS, label: 'symbol' },
      { table: WIN7_ABSENT_C_RUNTIME, label: 'runtime' },
    ]
    for (const rule of rules) {
      for (const [name, floor] of rule.table) {
        // A word boundary keeps `SetThreadDescription` from matching
        // `SetThreadDescriptionFoo`.
        const pattern = new RegExp(`\\b${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'gu')
        for (const use of findUses(source, pattern)) {
          const finding = { file: shown, line: use.line, kind: rule.label, name: use.name, floor }
          if (use.commented) mentions.push(finding)
          else findings.push(finding)
        }
      }
    }
    for (const [name, floor] of WIN7_ABSENT_CONSTANTS) {
      const pattern = new RegExp(`\\b${name}\\b`, 'gu')
      for (const use of findUses(source, pattern)) {
        const finding = { file: shown, line: use.line, kind: 'constant', name: use.name, floor }
        if (use.commented) mentions.push(finding)
        else findings.push(finding)
      }
    }
    for (const rule of WIN7_ABSENT_DLL_PATTERNS) {
      for (const match of source.matchAll(rule.pattern)) {
        findings.push({ file: shown, line: source.slice(0, match.index ?? 0).split('\n').length, kind: 'library', name: match[0], floor: rule.floor })
      }
    }
  }
}

if (scannedFiles === 0) {
  // A check that inspected nothing proves nothing. A wrong repository root
  // would silently turn this gate green, so the empty result is a failure.
  process.stdout.write('[win7] native-api: no native source was inspected; the check cannot run\n')
  process.exitCode = 2
} else if (findings.length > 0) {
  process.stdout.write(`[win7] native-api: ${String(findings.length)} use(s) of APIs Windows 7 SP1 does not have\n`)
  for (const finding of findings) {
    process.stdout.write(`  ${finding.file}:${String(finding.line)}: ${finding.name} needs Windows ${String(finding.floor)}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(`[win7] native-api: ${String(scannedFiles)} native source file(s) inspected, no Windows 8+ API use\n`)
}

if (mentions.length > 0) {
  process.stdout.write(`[win7] native-api: ${String(mentions.length)} comment(s) name an API Windows 7 SP1 does not have\n`)
  for (const mention of mentions) {
    process.stdout.write(`  ${mention.file}:${String(mention.line)}: ${mention.name} needs Windows ${String(mention.floor)}\n`)
  }
}
