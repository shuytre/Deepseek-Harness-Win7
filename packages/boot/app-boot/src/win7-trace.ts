/**
 * Ordered boot trace for surfaces whose runtime aborts natively.
 *
 * A native abort (Windows `STATUS_BREAKPOINT`) ends the process without a
 * JavaScript stack, and a shell that captures the child's stderr keeps only its
 * tail — and keeps it in a different buffer than stdout, so the interleaving of
 * stage lines with loader lines is lost. Writing every stage to one append-only
 * file, synchronously, preserves the exact order and survives the abort.
 *
 * Inert unless `DSH_WIN7_TRACE_FILE` names a path: the ordinary track pays one
 * environment lookup per stage and nothing else.
 * @module @deepseek-ai/dsh/win7-trace
 */

import { openSync, writeSync } from 'node:fs'

/** Cached sink; `2` means stderr, which is what an unset trace path falls back to. */
let sink: number | undefined

/** The compatibility preload's writer, when it installed one before this module loaded. */
type SharedTrace = (stage: string) => void

/** Single-file writer shared with the CommonJS preload, so both keep one order and one fd. */
function sharedTrace(): SharedTrace | undefined {
  return (globalThis as { __DSH_WIN7_TRACE__?: SharedTrace }).__DSH_WIN7_TRACE__
}

/** Open the trace file on first use, falling back to stderr when it cannot be opened. */
function traceSink(): number {
  if (sink !== undefined) return sink
  const path = process.env.DSH_WIN7_TRACE_FILE
  if (path === undefined || path === '') {
    sink = 2
    return sink
  }
  try {
    sink = openSync(path, 'a')
  } catch {
    sink = 2
  }
  return sink
}

/**
 * Record one boot stage.
 *
 * Written synchronously so the line reaches the file before an abort can drop a
 * queued write; failures are ignored because a lost trace is never fatal.
 * @param stage - Human-readable stage, including any data that names it.
 */
export function traceWin7Stage(stage: string): void {
  const shared = sharedTrace()
  if (shared !== undefined) {
    shared(stage)
    return
  }
  try {
    writeSync(traceSink(), `${new Date().toISOString()} ${stage}\n`)
  } catch {
    // A closed sink during teardown must not turn a trace into a failure.
  }
}
