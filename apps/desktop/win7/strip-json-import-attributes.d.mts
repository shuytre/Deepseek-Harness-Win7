/** Types for the Windows 7 JSON import-attribute rewrite. */

/** Outcome of rewriting one source text. */
export interface StripOutcome {
  readonly source: string
  readonly removed: number
}

/** Outcome of rewriting a whole packaged tree. */
export interface StripTreeOutcome {
  readonly files: number
  readonly removed: number
}

/**
 * Drop `with { type: 'json' }` clauses from a module source.
 * @param source - Module source.
 * @returns Source without the attribute clause, and the count removed.
 */
export function stripJsonImportAttributes(source: string): StripOutcome

/**
 * Rewrite every module under a directory that carries a JSON import attribute.
 * @param root - Directory to walk, typically the packaged `node_modules`.
 * @param log - Line logger.
 * @returns Counts of rewritten files and removed clauses.
 */
export function stripJsonImportAttributesInTree(root: string, log?: (line: string) => void): StripTreeOutcome
