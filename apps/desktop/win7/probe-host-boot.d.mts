/** Types for the packaged Host boot probe. */

/** Inputs for one boot attempt. */
export interface HostBootAttemptOptions {
  /** Executable to run: the target Electron binary, or another Node 16 build. */
  readonly executable: string
  /** Complete argument list, including the Host entry and its positional arguments. */
  readonly args: readonly string[]
  /** Environment for the child; must carry the compatibility runtime and the trace path. */
  readonly environment: Record<string, string | undefined>
  /** Working directory: the profile directory the Host reads. */
  readonly projectDir: string
  /** Ordered boot trace the child appends to. */
  readonly tracePath?: string | undefined
  /** Directory holding `report.*.json`; read only when the boot did not reach `booted`. */
  readonly reportDirectory?: string | undefined
  /** Upper bound on one boot; a boot that reports readiness is killed immediately. */
  readonly timeoutMs?: number | undefined
  /** Line sink for the build log. */
  readonly log?: ((line: string) => void) | undefined
}

/** What one boot proved. */
export interface HostBootAttempt {
  /** `booted` when the config tree mounted, `died` for every other ending. */
  readonly verdict: 'booted' | 'died'
  /** How the process ended: `ready`, `exited`, `timeout`, or `spawn-failed`. */
  readonly outcome: string
  /** Exit code when the process exited on its own. */
  readonly code: number | null
  /** Wall time of the attempt. */
  readonly ms: number
  /** Web application URL reported over IPC, when the boot reached readiness. */
  readonly readyUrl?: string | undefined
  /** Last trace lines, which name the row whose mount aborted. */
  readonly traceTail?: string | undefined
  /** Last child output lines. */
  readonly outputTail?: string | undefined
  /** Node fatal-error report summary, when the runtime wrote one. */
  readonly fatal?: string | undefined
  /** Spawn failure text. */
  readonly detail?: string | undefined
}

/** Start one Host process and wait for a verdict. */
export function probeHostAttempt(options: HostBootAttemptOptions): Promise<HostBootAttempt>
