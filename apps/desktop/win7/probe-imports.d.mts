/** Types for the Windows 7 per-entry import probe. */

/** One entry import replayed in its own process. */
export interface ProbeRecord {
  readonly specifier: string
  readonly code: number | null
  readonly verdict: 'ok' | 'absent' | 'timeout' | 'import-error' | 'process-died' | 'spawn-failed'
  readonly detail?: string
}

/** Complete probe outcome for the entries a failed boot named. */
export interface ProbeOutcome {
  readonly specifiers: readonly ProbeRecord[]
  readonly summary: string
  readonly probeCount: number
  readonly deadCount: number
}

/**
 * Collect the entry specifiers a boot trace named, in first-seen order.
 * @param tracePath - Boot trace written by the compatibility runtime.
 * @returns Entry specifiers, excluding Cordis builtins.
 */
export function tracedSpecifiers(tracePath: string): string[]

/**
 * Import every traced entry once, one child process per entry.
 * @param options - Runtime paths, the trace, and a line logger.
 * @returns Per-entry verdicts and a one-line summary.
 */
export function probeEntryImports(options: {
  electron: string
  dshRoot: string
  compat: string
  tracePath: string
  log: (line: string) => void
  /** Extra Node flags for every probe process. */
  extraArgs?: readonly string[]
  /** Probe only the first N entries. */
  limit?: number
}): Promise<ProbeOutcome>
