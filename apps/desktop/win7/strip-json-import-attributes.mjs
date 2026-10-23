#!/usr/bin/env node
/**
 * Remove JSON import attributes from a packaged `node_modules` tree.
 *
 * Node 16 cannot parse `import data from './x.json' with { type: 'json' }`: the
 * `with` clause arrived in Node 20.10, so the file fails to parse before any code
 * runs. The packaged runtime starts with `--experimental-json-modules`, which
 * makes a plain JSON import work on Node 16 — but only once the attribute is
 * gone. Providers such as `@earendil-works/pi-ai` ship one data file per model
 * with the attribute attached, so the rewrite is mechanical and tree-wide.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Files larger than this are treated as assets, not module sources. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** Extensions that can carry an import statement. */
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs']

/**
 * Drop the attribute clause from a source text.
 * @param source - Module source.
 * @returns Source without `with { type: 'json' }`, and how many clauses were removed.
 */
export function stripJsonImportAttributes(source) {
  let removed = 0
  const rewritten = source.replace(/\s+with\s*\{\s*type\s*:\s*(['"])json\1\s*\}/gu, () => {
    removed += 1
    return ''
  })
  return { source: rewritten, removed }
}

/**
 * Rewrite every module under `root` that carries a JSON import attribute.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and removed clauses.
 */
export function stripJsonImportAttributesInTree(root, log = () => {}) {
  let files = 0
  let removed = 0
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        // `.bin` holds shims, and no package data lives under it.
        if (entry.name !== '.bin') pending.push(full)
        continue
      }
      if (!SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue
      let size
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size > MAX_SOURCE_BYTES) continue
      let raw
      try {
        raw = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (!raw.includes('with {')) continue
      const result = stripJsonImportAttributes(raw)
      if (result.removed === 0) continue
      writeFileSync(full, result.source)
      files += 1
      removed += result.removed
      log(`[win7] json attributes: ${String(result.removed)} in ${full}`)
    }
  }
  return { files, removed }
}
