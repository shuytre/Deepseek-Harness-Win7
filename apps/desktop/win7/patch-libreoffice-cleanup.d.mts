/** Types for the Windows 7 LibreOffice cleanup-guard rewrite. */

/** Outcome of rewriting one source text. */
export interface CleanupGuardOutcome {
  readonly source: string
  readonly sites: number
}

/** Outcome of rewriting a whole packaged tree. */
export interface CleanupGuardTreeOutcome {
  readonly files: number
  readonly sites: number
}

/**
 * Guard the kit's cleanup throw so it only fires when the conversion failed.
 * @param source - Module source.
 * @returns Source with the guard, and the count of patched sites.
 */
export function guardCleanupFailures(source: string): CleanupGuardOutcome

/**
 * Rewrite the LibreOffice kit inside a packaged `node_modules` tree.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and sites.
 */
export function guardLibreOfficeCleanupInTree(root: string, log?: (line: string) => void): CleanupGuardTreeOutcome
