/**
 * Windows 7 SP1 x64 compatibility polyfills.
 *
 * Loaded before any product module in three places:
 *   1. Electron main process — `loadWin7MainProcessPolyfills()` in api-compat.ts
 *   2. Desktop Host / CLI child — `--require <runtime>/win7-compat/polyfills.cjs`
 *   3. Renderer boot script — `rendererBootPolyfillSource()` in boot-polyfill.ts
 *
 * Plain CommonJS on purpose: Node 16 can `--require` it before ESM evaluation,
 * and the same file is copied verbatim into the packaged runtime.
 *
 * Every polyfill is guarded by a feature check, so the Win10 track — where the
 * native implementation exists — is unaffected when this file loads.
 */
'use strict'

/** Install `Promise.withResolvers` (Node 22 / Chrome 119). */
function installPromiseWithResolvers() {
  if (typeof Promise.withResolvers === 'function') return
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers() {
      let resolve
      let reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
  })
}

/** Install `AbortSignal.timeout` (Node 17.3) and `AbortSignal.any` (Node 20.3). */
function installAbortSignalHelpers() {
  const Signal = globalThis.AbortSignal
  if (typeof Signal !== 'function') return
  if (typeof Signal.timeout !== 'function') {
    Object.defineProperty(Signal, 'timeout', {
      configurable: true,
      writable: true,
      value: function timeout(milliseconds) {
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(createAbortReason(milliseconds))
        }, milliseconds)
        if (typeof timer.unref === 'function') timer.unref()
        controller.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
        return controller.signal
      },
    })
  }
  if (typeof Signal.any !== 'function') {
    Object.defineProperty(Signal, 'any', {
      configurable: true,
      writable: true,
      value: function any(signals) {
        const controller = new AbortController()
        const list = Array.from(signals)
        if (list.some(signal => signal.aborted)) {
          controller.abort(list.find(signal => signal.aborted).reason)
          return controller.signal
        }
        for (const signal of list) {
          signal.addEventListener('abort', () => { controller.abort(signal.reason) }, { once: true })
        }
        return controller.signal
      },
    })
  }
}

/** Build a DOMException-like abort reason without requiring `DOMException`. */
function createAbortReason(milliseconds) {
  const error = new Error(`The operation was aborted due to timeout after ${milliseconds}ms`)
  error.name = 'TimeoutError'
  return error
}

/** Install `structuredClone` (Node 17) over `v8` serialization. */
function installStructuredClone() {
  if (typeof globalThis.structuredClone === 'function') return
  let serialize
  try {
    const v8 = require('node:v8')
    serialize = [v8.serialize, v8.deserialize]
  } catch {
    return
  }
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    writable: true,
    value: function structuredClone(value) {
      return serialize[1](serialize[0](value))
    },
  })
}

/** Install `URL.canParse` (Node 19.9). */
function installUrlCanParse() {
  if (typeof URL.canParse === 'function') return
  Object.defineProperty(URL, 'canParse', {
    configurable: true,
    writable: true,
    value: function canParse(input, base) {
      try {
        // eslint-disable-next-line no-new
        new URL(input, base)
        return true
      } catch {
        return false
      }
    },
  })
}

/** Install `os.availableParallelism` (Node 18.14). */
function installAvailableParallelism() {
  const os = require('node:os')
  if (typeof os.availableParallelism === 'function') return
  Object.defineProperty(os, 'availableParallelism', {
    configurable: true,
    writable: true,
    value: function availableParallelism() {
      try {
        const values = os.cpus()
        return values.length > 0 ? values.length : 1
      } catch {
        return 1
      }
    },
  })
}

/** Install the copy-free array change methods (Node 20 / Chrome 110). */
function installArrayChangeMethods() {
  const methods = {
    with: function withCopy(index, value) {
      const length = this.length
      const normalized = index < 0 ? length + index : index
      if (normalized < 0 || normalized >= length) throw new RangeError('Invalid index')
      const copy = Array.prototype.slice.call(this)
      copy[normalized] = value
      return copy
    },
    toSorted: function toSorted(compare) { return Array.prototype.slice.call(this).sort(compare) },
    toReversed: function toReversed() { return Array.prototype.slice.call(this).reverse() },
    toSpliced: function toSpliced(start, deleteCount) {
      const copy = Array.prototype.slice.call(this)
      const rest = Array.prototype.slice.call(arguments, 2)
      if (arguments.length === 1) return copy.splice(start)
      if (arguments.length === 2) return copy.splice(start, deleteCount)
      return copy.splice(start, deleteCount, ...rest)
    },
    findLast: function findLast(predicate, thisArg) {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index], index, this)) return this[index]
      }
      return undefined
    },
    findLastIndex: function findLastIndex(predicate, thisArg) {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index], index, this)) return index
      }
      return -1
    },
  }
  for (const [name, implementation] of Object.entries(methods)) {
    if (typeof Array.prototype[name] === 'function') continue
    Object.defineProperty(Array.prototype, name, { configurable: true, writable: true, value: implementation })
  }
}

/**
 * Install `fs.globSync` (Node 22) with the subset the Harness uses:
 * `packages/*\/*\/package.json` and `**` relative patterns.
 *
 * Patterns are translated to a regular expression instead of pulling a glob
 * dependency into the packaged runtime.
 */
function installGlobSync() {
  const fs = require('node:fs')
  if (typeof fs.globSync === 'function') return
  const { readdirSync, statSync } = fs
  const { join, resolve, sep, posix } = require('node:path')

  function translate(pattern) {
    let expression = ''
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index]
      if (character === '*') {
        if (pattern[index + 1] === '*') {
          index += 1
          if (pattern[index + 1] === '/') index += 1
          expression += '(?:[^/]*/)*'
        } else {
          expression += '[^/]*'
        }
      } else if (character === '?') expression += '[^/]'
      else expression += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    }
    return new RegExp(`^${expression}$`, 'u')
  }

  function walk(directory, segments, expression, matches) {
    if (segments.length === 0) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    const [head, ...rest] = segments
    const recursive = head === '**'
    const candidates = recursive ? entries : entries.filter(entry => {
      if (head.includes('*') || head.includes('?')) return new RegExp(`^${translateFragment(head)}$`, 'u').test(entry.name)
      return entry.name === head
    })
    for (const entry of candidates) {
      const full = join(directory, entry.name)
      if (recursive) {
        walk(full, segments, expression, matches)
        continue
      }
      if (rest.length === 0 && expression.test(toPosix(full))) matches.push(full)
      else if (rest.length > 0) walk(full, rest, expression, matches)
      else if (entry.isDirectory()) walk(full, segments, expression, matches)
    }
  }

  function translateFragment(fragment) {
    return fragment.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')
  }

  function toPosix(value) {
    return value.split(sep).join(posix.sep)
  }

  Object.defineProperty(fs, 'globSync', {
    configurable: true,
    writable: true,
    value: function globSync(pattern, options) {
      const cwd = resolve((options && options.cwd) || process.cwd())
      const expression = translate(toPosix(pattern))
      const matches = []
      walk(cwd, pattern.split('/').filter(Boolean), expression, matches)
      return matches
    },
  })
}

/**
 * Resolve a package from the roots the shell declares.
 *
 * The compatibility runtime lives under `resources/runtime/win7-compat`, which
 * is not an ancestor of the trees that carry dependencies, so plain `require`
 * cannot find them. `DSH_WIN7_MODULE_ROOTS` names those package roots.
 * @param {string} name - Package name.
 * @returns {unknown} Loaded module.
 */
function resolveFromRoots(name) {
  const declared = process.env.DSH_WIN7_MODULE_ROOTS
  const roots = declared === undefined ? [] : declared.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const { join } = require('node:path')
  const { existsSync } = require('node:fs')
  let lastError
  for (const root of roots) {
    const candidate = join(root, 'node_modules', name)
    if (!existsSync(candidate)) continue
    try {
      return require(candidate)
    } catch (error) {
      lastError = error
    }
  }
  try {
    return require(name)
  } catch (error) {
    throw lastError === undefined ? error : lastError
  }
}

/** Install a global `fetch` stack from undici 5 when the runtime lacks one (Node 16). */
function installFetchStack() {
  if (typeof globalThis.fetch === 'function' && typeof globalThis.Response === 'function') return false
  let undici
  try {
    undici = resolveFromRoots('undici')
  } catch {
    return false
  }
  const targets = ['fetch', 'Headers', 'Request', 'Response', 'FormData']
  for (const name of targets) {
    if (typeof globalThis[name] === 'function') continue
    if (typeof undici[name] !== 'function') continue
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undici[name] })
  }
  return typeof globalThis.fetch === 'function'
}

/** Install a global `WebSocket` from `ws` when the runtime lacks one (Node 16). */
function installWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return false
  try {
    const ws = resolveFromRoots('ws')
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: ws.WebSocket })
    return true
  } catch {
    return false
  }
}

/** Install every guard that applies to the running runtime. */
function installWin7Polyfills() {
  installPromiseWithResolvers()
  installAbortSignalHelpers()
  installStructuredClone()
  installUrlCanParse()
  installAvailableParallelism()
  installArrayChangeMethods()
  installGlobSync()
  const fetchInstalled = installFetchStack()
  const webSocketInstalled = installWebSocket()
  return {
    node: process.versions.node,
    fetch: fetchInstalled,
    webSocket: webSocketInstalled,
  }
}

module.exports = { installWin7Polyfills }
if (typeof globalThis.__DSH_WIN7_POLYFILLS__ !== 'object') {
  globalThis.__DSH_WIN7_POLYFILLS__ = installWin7Polyfills()
}
