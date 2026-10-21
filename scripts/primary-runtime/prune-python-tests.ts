/** Remove upstream Python test suites from the staged primary runtime. */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Papa from 'papaparse'

/** Distributions whose upstream test suites are pruned from the staged runtime. */
const PRUNED_DISTRIBUTIONS = ['numpy', 'pandas'] as const

/** Version map one target stages; the Windows 7 track locks older releases. */
export type PrunedDistributionVersions = Readonly<Record<typeof PRUNED_DISTRIBUTIONS[number], string>>

function removeTestDirectories(root: string, directory: string): string[] {
  const removed: string[] = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = `${directory}/${entry.name}`
    if (entry.name === 'tests') {
      rmSync(join(root, path), { recursive: true })
      removed.push(path)
    } else {
      removed.push(...removeTestDirectories(root, path))
    }
  }
  return removed
}

/**
 * Prune NumPy/pandas tests and their RECORD rows, preserving testing helpers and native extensions.
 * @param sitePackages - Staged site-packages directory containing the locked wheels.
 * @param versions - Distribution versions the staged target locked; the Windows 7 track
 *   stages older releases than the default one, so the caller must pass its own map.
 * @throws If a locked distribution's RECORD is missing or malformed.
 */
export function prunePrimaryRuntimePythonTests(sitePackages: string, versions: PrunedDistributionVersions): void {
  for (const name of PRUNED_DISTRIBUTIONS) {
    const record = join(sitePackages, `${name}-${versions[name]}.dist-info`, 'RECORD')
    const { data, errors } = Papa.parse<string[]>(readFileSync(record, 'utf8'), { delimiter: ',', skipEmptyLines: true })
    if (errors.length > 0 || data.length === 0
      || !data.every((row): row is [string, string, string] => row.length === 3 && Boolean(row[0]))) {
      throw new Error(`primary runtime: invalid wheel RECORD: ${record}`)
    }
    const removed = removeTestDirectories(sitePackages, name)
    if (removed.length === 0) continue
    const retained = data.filter(([path]) => !removed.some(directory => path.startsWith(`${directory}/`)))
    writeFileSync(record, `${Papa.unparse(retained, { newline: '\n' })}\n`)
  }
}
