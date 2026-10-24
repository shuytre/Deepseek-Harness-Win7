#!/usr/bin/env node
/**
 * Give the LibreOffice kit's scratch-directory removal a retry budget.
 *
 * The kit deletes its temporary tree with `rm(dir, { recursive: true, force: true })`.
 * Node defaults `maxRetries` to zero, so the very first `EPERM` or `EBUSY` ends the
 * deletion — and on Windows the `soffice` process outlives the helper that started
 * it and keeps `profile/Documents` open for a moment after the PDF is written. The
 * kit reports that as `AggregateError: LibreOffice conversion cleanup failed.` and
 * the caller loses a conversion that actually succeeded.
 *
 * `maxRetries`/`retryDelay` exist for exactly this Windows case; adding them to the
 * packaged tree fixes both the provider and the `cli.js` entry the Office skill runs,
 * neither of which accepts an option of its own for it.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Only the kit's own sources are rewritten. */
const KIT_DIRECTORY = 'libreoffice-kit'

/** Retry budget appended to each cleanup call. */
const RETRY_OPTIONS = 'maxRetries: 20, retryDelay: 100'

/** Matches `rm(identifier, { ... })` with a flat option object. */
const CLEANUP_CALL = /\brm\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*),\s*\{([^{}]*?)\}\)/gu

/**
 * Append retry options to every recursive force removal in a source text.
 * @param source - Module source.
 * @returns Source with retry options, and how many calls changed.
 */
export function addCleanupRetries(source) {
  let patched = 0
  const rewritten = source.replace(CLEANUP_CALL, (match, target, options) => {
    if (!/\brecursive\s*:\s*true/u.test(options) || !/\bforce\s*:\s*true/u.test(options)) return match
    if (/\bmaxRetries\b/u.test(options)) return match
    patched += 1
    const body = options.replace(/[\s,]+$/u, '')
    return `rm(${target}, {${body}, ${RETRY_OPTIONS} })`
  })
  return { source: rewritten, patched }
}

/**
 * Rewrite the LibreOffice kit inside a packaged `node_modules` tree.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and calls.
 */
export function addLibreOfficeCleanupRetriesInTree(root, log = () => {}) {
  let files = 0
  let patched = 0
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
        if (entry.name !== '.bin') pending.push(full)
        continue
      }
      if (!full.includes(KIT_DIRECTORY) || !entry.name.endsWith('.js')) continue
      let size
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size > 8 * 1024 * 1024) continue
      let raw
      try {
        raw = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (!raw.includes('recursive: true')) continue
      const result = addCleanupRetries(raw)
      if (result.patched === 0) continue
      writeFileSync(full, result.source)
      files += 1
      patched += result.patched
      log(`[win7] cleanup retries: ${String(result.patched)} in ${full}`)
    }
  }
  return { files, patched }
}
