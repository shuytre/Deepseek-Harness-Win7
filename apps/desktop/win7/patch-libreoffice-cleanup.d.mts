/** Types for the Windows 7 LibreOffice cleanup-retry rewrite. */

/** Outcome of rewriting one source text. */
export interface CleanupPatchOutcome {
  readonly source: string
  readonly patched: number
}

/** Outcome of rewriting a whole packaged tree. */
export interface CleanupPatchTreeOutcome {
  readonly files: number
  readonly patched: number
}

/**
 * Append retry options to every recursive force removal in a module source.
 * @param source - Module source.
 * @returns Source with retry options, and the count of patched calls.
 */
export function addCleanupRetries(source: string): CleanupPatchOutcome

/**
 * Rewrite the LibreOffice kit inside a packaged `node_modules` tree.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and calls.
 */
export function addLibreOfficeCleanupRetriesInTree(root: string, log?: (line: string) => void): CleanupPatchTreeOutcome
