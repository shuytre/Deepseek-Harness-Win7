/**
 * Session diagnostics for the Windows 7 track.
 *
 * The Windows 7 track fails in ways a Windows Server runner cannot observe,
 * so the application has to be able to describe its own state to something
 * that can read it back. The crash report covers the fatal case only, and the
 * renderer console tail reaches disk only when a fatal error follows it.
 *
 * This module writes a session report: what the shell started with, which
 * windows it opened, what the renderer reported, and how the process ended.
 * The report is written when the file is asked for, and it is written on the
 * way out so the last state is always on disk.
 *
 * The file is written where the caller asked for it, and it never contains
 * anything the crash report does not already contain.
 */

import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One reported fact about the session. */
export interface SessionDiagnostic {
  readonly at: string
  readonly kind: string
  readonly detail: string
}

/** The collected state of one session. */
export interface SessionReport {
  readonly events: SessionDiagnostic[]
  readonly rendererConsole: string[]
}

/**
 * Create the session reporter.
 *
 * The reporter is inert when no file was requested, so the ordinary product
 * path pays nothing for it.
 * @param file - Absolute path of the report file, or undefined to stay inert.
 * @returns The reporter.
 */
export function createSessionReporter(file: string | undefined): {
  record(kind: string, detail: string): void
  rendererConsole(): string[]
  flush(): Promise<void>
} {
  const events: SessionDiagnostic[] = []
  const renderer: string[] = []
  let pending = Promise.resolve()

  /**
   * Append one event to the report file.
   * @param event - Event to append.
   */
  const append = (event: SessionDiagnostic): void => {
    events.push(event)
    if (file === undefined) return
    pending = pending
      .then(() => appendFile(file, `${JSON.stringify(event)}\n`, 'utf8'))
      .catch(() => undefined)
  }

  return {
    record(kind: string, detail: string): void {
      append({ at: new Date().toISOString(), kind, detail })
    },
    rendererConsole(): string[] {
      return [...renderer]
    },
    async flush(): Promise<void> {
      if (file === undefined) return
      const content = [
        ...events.map(event => JSON.stringify(event)),
        `--- renderer console (error level) ---`,
        ...renderer,
        '',
      ].join('\n')
      await writeFile(file, content, 'utf8').catch(() => undefined)
      await pending
    },
  }
}

/**
 * Resolve the report file the environment asked for.
 * @returns The absolute path, or undefined when no report was requested.
 */
export function sessionReportFile(): string | undefined {
  const configured = process.env.DSH_DESKTOP_SESSION_REPORT
  return configured === undefined || configured.length === 0 ? undefined : configured
}
