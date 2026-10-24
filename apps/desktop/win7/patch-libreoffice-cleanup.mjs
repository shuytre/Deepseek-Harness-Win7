#!/usr/bin/env node
/**
 * Stop the LibreOffice kit from failing a conversion that already succeeded.
 *
 * The kit writes the PDF first, then deletes its scratch tree, and its `finally`
 * block turns any deletion error into
 * `AggregateError: LibreOffice conversion cleanup failed.` — discarding the
 * finished document. On Windows the `soffice` process it starts outlives the
 * helper that spawned it and keeps `profile/Documents` open indefinitely, so that
 * deletion always fails there; `maxRetries` only postpones the error (the retry
 * delay doubles, so a handful of attempts already outlives the conversion
 * deadline).
 *
 * The kit distinguishes the two cases in its own error text: the aggregate is
 * `[failure, ...cleanup]` when the conversion failed and `[...cleanup]` when only
 * the deletion did. Guarding the throw on `failure` keeps every real conversion
 * error and stops reporting a cleanup leak as a failed document. The rewrite runs
 * over the packaged tree so it covers both the provider and the `cli.js` entry the
 * Office skill shells out to.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Only the kit's own sources are rewritten. */
const KIT_DIRECTORY = 'libreoffice-kit'

/** The kit's cleanup throw, exactly as published in 0.1.5. */
const CLEANUP_THROW = 'if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, "LibreOffice conversion cleanup failed.");'

/** Same aggregate, but only when the conversion itself failed. */
const CLEANUP_GUARD = 'if (errors.length && failure !== undefined) throw new AggregateError([failure, ...errors], "LibreOffice conversion cleanup failed.");'

/**
 * Guard the kit's cleanup throw in a source text.
 * @param source - Module source.
 * @returns Source with the guard, and how many sites changed.
 */
export function guardCleanupFailures(source) {
  let sites = 0
  let rewritten = ''
  let rest = source
  while (true) {
    const index = rest.indexOf(CLEANUP_THROW)
    if (index === -1) break
    sites += 1
    rewritten += `${rest.slice(0, index)}${CLEANUP_GUARD}`
    rest = rest.slice(index + CLEANUP_THROW.length)
  }
  return { source: `${rewritten}${rest}`, sites }
}

/**
 * Rewrite the LibreOffice kit inside a packaged `node_modules` tree.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and sites.
 */
export function guardLibreOfficeCleanupInTree(root, log = () => {}) {
  let files = 0
  let sites = 0
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
      if (!raw.includes('LibreOffice conversion cleanup failed')) continue
      const result = guardCleanupFailures(raw)
      if (result.sites === 0) continue
      writeFileSync(full, result.source)
      files += 1
      sites += result.sites
      log(`[win7] cleanup guard: ${String(result.sites)} in ${full}`)
    }
  }
  return { files, sites }
}
