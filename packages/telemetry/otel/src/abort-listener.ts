/**
 * `events.addAbortListener` on every supported runtime.
 *
 * The helper arrived in Node 20.5, and a named import of a builtin that lacks it
 * fails at link time, before any fallback can run — so it is read from the module
 * object instead. The Windows 7 compatibility runtime installs the same function
 * on `node:events`; the local implementation covers a runtime that does not.
 *
 * The native handle is a disposable object, and `Symbol.dispose` is absent on
 * Node 16, so this module always answers with a plain `dispose()` method.
 * @module @deepseek-ai/dsh-otel/abort-listener
 */

import { createRequire } from 'node:module'

/** A removable abort listener handle. */
export interface AbortListenerHandle {
  /** Remove the listener from the signal. */
  dispose(): void
}

/** Native handle shape: a disposable object, with or without a `dispose` method. */
interface NativeHandle {
  dispose?: () => void
  [Symbol.dispose]?: () => void
}

/**
 * Release a native handle whichever dispose form it carries.
 * @param handle - Handle returned by `events.addAbortListener`.
 */
function releaseNative(handle: NativeHandle): void {
  if (typeof handle.dispose === 'function') {
    handle.dispose()
    return
  }
  if (typeof Symbol.dispose === 'symbol') handle[Symbol.dispose]?.()
}

/**
 * Listen for `abort` once and return a handle that removes the listener.
 * @param signal - Signal to observe.
 * @param listener - Invoked when the signal aborts.
 * @returns Handle that detaches the listener.
 */
export function addAbortListener(signal: AbortSignal, listener: () => void): AbortListenerHandle {
  const events = createRequire(import.meta.url)('node:events') as typeof import('node:events') & {
    addAbortListener?: (signal: AbortSignal, listener: () => void) => NativeHandle
  }
  if (typeof events.addAbortListener === 'function') {
    const handle = events.addAbortListener(signal, listener)
    return { dispose: () => { releaseNative(handle) } }
  }
  signal.addEventListener('abort', listener, { once: true })
  return { dispose: () => { signal.removeEventListener('abort', listener) } }
}
