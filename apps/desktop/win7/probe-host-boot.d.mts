/** Types for the packaged Host boot probe. */

/** How the packaged Host ended when started over plain pipes. */
export interface HostBootProbe {
  readonly verdict: 'alive' | 'died' | 'spawn-failed'
  readonly code?: number | null
  readonly detail: string
}

/**
 * Boot the packaged Host directly and report how it ended.
 * @param options - Runtime paths and the Node 16 executable.
 * @returns Probe record with the exit code and the last output lines.
 */
export function probeHostBoot(options: {
  node: string
  dshRoot: string
  compat: string
  primaryRuntime: string
  log?: (line: string) => void
}): Promise<HostBootProbe>
