/**
 * Electron API compatibility for the Windows 7 track (Electron 22).
 *
 * Electron 22 ships Chromium 108 / Node 16.17.1 and therefore lacks APIs the
 * Win10 track uses: `WebContentsView` (30), `webUtils` (29), `net.fetch` (25),
 * `session.closeAllConnections` (25), `protocol.handle` (25). Each entry point
 * below prefers the modern API when it exists and falls back to the Electron 22
 * equivalent, so a single source tree serves both tracks.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { BrowserWindow, Session, WebContents } from 'electron'

/**
 * Numeric console level that means "error" in the positional console signature.
 *
 * Chromium reports console levels as 0 (verbose), 1 (info), 2 (warning) and
 * 3 (error).
 */
export const CONSOLE_ERROR_LEVEL = 3

/**
 * Resolve the installed compatibility runtime directory.
 * @param resourcesDirectory - `process.resourcesPath` of the running application.
 * @returns Absolute directory, or undefined when the track is not installed.
 */
export function win7CompatDirectory(resourcesDirectory: string): string | undefined {
  const candidates = [
    process.env.DSH_WIN7_COMPAT_DIR,
    join(resourcesDirectory, 'runtime', 'win7-compat'),
    // Development launches run from the repository, not from a packaged resources directory.
    join(process.cwd(), '.desktop-build', 'targets', 'win-x64', 'runtime', 'win7-compat'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find(candidate => existsSync(join(candidate, 'polyfills.cjs')))
}

/**
 * Install global polyfills in the Electron main process.
 *
 * The polyfill file is loaded through `require` rather than imported so the
 * same bytes serve the main process, the Host child and the CLI launcher.
 * @param resourcesDirectory - `process.resourcesPath` of the running application.
 * @returns Whether a polyfill file was found and executed.
 */
export function loadWin7MainProcessPolyfills(resourcesDirectory: string): boolean {
  const directory = win7CompatDirectory(resourcesDirectory)
  if (directory === undefined) return false
  createRequire(import.meta.url)(join(directory, 'polyfills.cjs'))
  return true
}

/** Lazily require the Electron module without a static import cycle. */
function getElectronModule(): unknown {
  return createRequire(import.meta.url)('electron')
}

/** Minimal response surface `connectDesktopWelcome` consumes. */
export interface CompatResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  readonly body: { cancel(): Promise<void> }
}

/** Fetch-shaped transport bound to one Electron session. */
export type CompatFetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Build a fetch-shaped transport for the given session.
 *
 * Electron 25+ answers with `net.fetch`. Electron 22 has no `net.fetch` and no
 * `session.fetch`, so the request goes through `net.request` with an explicit
 * cookie jar: the loopback Host authenticates with `Set-Cookie`, and the jar
 * replays those cookies for `credentials: 'include'`.
 * @param browserSession - Session that owns the cookie jar.
 * @returns Fetch-compatible function.
 */
export function createCompatFetch(browserSession: Session): CompatFetch {
  const netModule = getElectronModule() as {
    net: { fetch?: (input: string, init?: RequestInit) => Promise<Response>, request(options: unknown): CompatRequest }
  }
  if (typeof netModule.net.fetch === 'function') {
    return (input, init) => netModule.net.fetch!(input, init)
  }
  const jar = new Map<string, string>()
  return async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name] = value
    if (init?.credentials === 'include') {
      const stored = await browserSession.cookies.get({ url: url.origin })
      for (const cookie of stored) jar.set(cookie.name, cookie.value)
      if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const request = netModule.net.request({ method, url: url.href, redirect: 'manual' })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    const signal = init?.signal
    return await new Promise<Response>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      const abort = (): void => { request.abort(); rejectPromise(new Error(`desktop net fetch: aborted ${url.href}`)) }
      if (signal?.aborted === true) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      request.on('response', (response) => {
        const status = response.statusCode
        const responseHeaders = response.headers
        const setCookie = responseHeaders['set-cookie']
        for (const entry of Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]) {
          const [pair] = entry.split(';')
          const separator = pair?.indexOf('=') ?? -1
          if (pair !== undefined && separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
        }
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.on('end', () => {
          signal?.removeEventListener('abort', abort)
          const body = Buffer.concat(chunks)
          resolvePromise(compatResponse({
            status,
            statusText: String(response.statusMessage ?? ''),
            url: url.href,
            headers: (name: string) => {
              const value = responseHeaders[name.toLowerCase()]
              return Array.isArray(value) ? (value[0] ?? null) : value ?? null
            },
            body,
          }) as unknown as Response)
        })
      })
      request.on('error', (error: Error) => { rejectPromise(error) })
      if (init?.body !== undefined && typeof init.body === 'string') request.write(init.body)
      request.end()
    })
  }
}

/** Electron `net.request` client shape used by the fallback. */
interface CompatRequest {
  setHeader(name: string, value: string): void
  on(event: 'response', listener: (response: CompatIncoming) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  write(chunk: string): void
  end(): void
  abort(): void
}

/** Electron `IncomingMessage` shape used by the fallback. */
interface CompatIncoming {
  readonly statusCode: number
  readonly statusMessage: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
}

/**
 * Materialize the response surface `connectDesktopWelcome` consumes.
 * @param input - Captured status, headers and body.
 * @returns Response-shaped object.
 */
function compatResponse(input: {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly headers: (name: string) => string | null
  readonly body: Buffer
}): CompatResponse {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    statusText: input.statusText,
    url: input.url,
    headers: { get: input.headers },
    text: () => Promise.resolve(input.body.toString('utf8')),
    json: () => Promise.resolve(JSON.parse(input.body.toString('utf8')) as unknown),
    arrayBuffer: () => Promise.resolve(new Uint8Array(input.body).buffer as ArrayBuffer),
    body: { cancel: () => Promise.resolve() },
  }
}

/**
 * Close every live connection on a session.
 * @param browserSession - Session whose connections are dropped.
 */
export async function closeAllConnectionsCompat(browserSession: Session): Promise<void> {
  const candidate = browserSession as Session & { closeAllConnections?: () => Promise<void> }
  if (typeof candidate.closeAllConnections === 'function') {
    await candidate.closeAllConnections()
    return
  }
  // Electron 22 has no connection teardown; clearing the cache detaches pooled
  // sockets the same way the Win10 track relies on.
  await browserSession.clearCache()
}

/**
 * Apply palette colors to the Windows native caption.
 * @param window - Window whose caption is recolored.
 * @param colors - Accepted CSS colors.
 * @returns Whether the runtime applied the colors.
 */
export function applyTitleBarOverlayCompat(
  window: BrowserWindow,
  colors: { readonly color: string, readonly symbolColor: string },
): boolean {
  const candidate = window as BrowserWindow & { setTitleBarOverlay?: (options: { color: string, symbolColor: string }) => void }
  if (typeof candidate.setTitleBarOverlay !== 'function') return false
  candidate.setTitleBarOverlay(colors)
  return true
}

/**
 * Close one web contents across Electron generations.
 * @param contents - Contents being torn down.
 */
export function closeWebContentsCompat(contents: WebContents): void {
  const candidate = contents as unknown as {
    close?: (options?: { waitForBeforeUnload?: boolean }) => void
    destroy?: () => void
  }
  try {
    candidate.close?.({ waitForBeforeUnload: false })
  } catch {
    candidate.destroy?.()
  }
}

/** Handler shape the Desktop shell registers for its application scheme. */
export type ProtocolHandler = (request: Request) => Response | Promise<Response>

/**
 * Record why a protocol request could not be answered.
 *
 * The polyfill preload installs `globalThis.__DSH_WIN7_TRACE__` on this track;
 * on the ordinary track nothing is installed and stderr carries the line.
 * @param detail - One-line description of the failure.
 */
function recordProtocolFailure(detail: string): void {
  const trace = (globalThis as { __DSH_WIN7_TRACE__?: (stage: string) => void }).__DSH_WIN7_TRACE__
  if (typeof trace === 'function') trace(`protocol failure: ${detail}`)
  console.error(`[desktop protocol] ${detail}`)
}

/** Electron 22 `ProtocolRequest` shape. */
interface CompatProtocolRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly uploadData?: Array<{ data: Buffer }> | undefined
}

/** Electron 22 `ProtocolResponse` shape. */
interface CompatProtocolResponse {
  statusCode?: number
  headers?: Record<string, string | string[]>
  data?: Buffer | string | Readable
  mimeType?: string
  /** Net error number; a non-zero value fails the request instead of answering it. */
  error?: number
}

/**
 * Register a handler for the application scheme across Electron generations.
 *
 * Electron 25 replaced the `register*Protocol` family with `protocol.handle`,
 * which speaks the Fetch `Request`/`Response` shape. Electron 22 has no
 * `handle` at all: calling it raises `TypeError: protocol.handle is not a
 * function` while the shell is still starting, so the window never opens.
 *
 * The modern path is used when it exists. The Electron 22 path registers a
 * stream protocol and bridges the same handler through it: the request is
 * rebuilt as a Fetch `Request`, and the handler's `Response` is written back
 * as a buffered body with the same status and headers. Buffering rather than
 * streaming is deliberate - the shell serves local documents and forwards Host
 * responses, and Electron 22's protocol API cannot carry a Fetch body stream
 * through Node 16 without consuming it.
 * @param scheme - Scheme to own.
 * @param handler - Handler receiving the request and answering with a response.
 */
export function handleProtocolCompat(scheme: string, handler: ProtocolHandler): void {
  const protocolModule = getElectronModule() as {
    protocol: {
      handle?: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => void
      registerStreamProtocol?: (
        scheme: string,
        handler: (request: CompatProtocolRequest, callback: (response: CompatProtocolResponse) => void) => void
      ) => boolean
    }
  }
  const { protocol } = protocolModule
  if (typeof protocol.handle === 'function') {
    protocol.handle(scheme, handler)
    return
  }
  if (typeof protocol.registerStreamProtocol !== 'function') {
    throw new Error('The Electron runtime provides no protocol registration API')
  }
  protocol.registerStreamProtocol(scheme, (request, callback) => {
    void (async () => {
      try {
        const response = await handler(bridgeProtocolRequest(request))
        callback(await bridgeProtocolResponse(response))
      } catch (error) {
        // Chromium only ever learns the net error number, so the reason has to
        // be written where a diagnostic can read it: the track's trace sink
        // (installed by the polyfills) and stderr.
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        recordProtocolFailure(`${request.url} ${message}`)
        // Electron 22 reports a failed protocol load through the `error`
        // number of the response, which is the net error list value for a
        // failed fetch (-2).
        callback({
          error: -2,
          statusCode: 500,
          headers: { 'content-type': 'text/plain' },
          data: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  })
}

/**
 * Rebuild a Fetch `Request` from an Electron 22 protocol request.
 * @param request - Protocol request.
 * @returns Fetch request carrying the same method, headers and body.
 */
function bridgeProtocolRequest(request: CompatProtocolRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value)
  const method = (request.method ?? 'GET').toUpperCase()
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : Buffer.concat((request.uploadData ?? []).map(entry => entry.data))
  return new Request(request.url, { method, headers, body, duplex: 'half' } as RequestInit)
}

/**
 * Convert a Fetch `Response` into the Electron 22 protocol response shape.
 *
 * The body is forwarded as a stream rather than buffered. The application
 * serves the Host's responses, and the Host answers a chat turn as a stream
 * of events; buffering the whole answer would hold it back until the turn
 * ended, and the window would show nothing while it waited. Electron 22's
 * protocol accepts a Node readable stream for exactly this reason.
 *
 * The bridge from a web stream to a Node one cannot be `Readable.fromWeb`:
 * that arrived in Node 17, and the Windows 7 track runs Node 16.17 inside
 * Electron 22. Calling it there threw `Readable.fromWeb is not a function`,
 * which the protocol registration turns into net error -2 and the window shows
 * as `ERR_FAILED` on an otherwise empty page. The reader bridge below is the
 * Node 16 equivalent; the native conversion is still preferred where it exists.
 *
 * The length is not known in advance, so the response carries no
 * `content-length`, and the length the Host sent is dropped for the same
 * reason.
 * @param response - Response produced by the handler.
 * @returns Protocol response carrying the same status, headers and body.
 */
async function bridgeProtocolResponse(response: Response): Promise<CompatProtocolResponse> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => { headers[name] = value })
  delete headers['content-length']
  if (response.body === null) {
    return { statusCode: response.status, headers, data: Buffer.alloc(0) }
  }
  return { statusCode: response.status, headers, data: toNodeReadable(response.body) }
}

/** Node's own web-stream conversion, present from Node 17. */
interface WebStreamConvertible {
  fromWeb?: (stream: unknown) => Readable
}

/** The part of a web stream reader this bridge uses. */
interface WebStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

/** The part of a web stream this bridge uses. */
interface ReadableWebStream {
  getReader(): WebStreamReader
}

/**
 * Turn a web `ReadableStream` into a Node writable-consumable stream.
 * @param body - Web stream the handler answered with.
 * @returns Node readable stream carrying the same bytes.
 */
function toNodeReadable(body: ReadableStream<Uint8Array>): Readable {
  const native = (Readable as unknown as WebStreamConvertible).fromWeb
  if (typeof native === 'function') return native(body)
  const reader = (body as unknown as ReadableWebStream).getReader()
  return Readable.from((async function* pump(): AsyncGenerator<Buffer> {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) yield Buffer.from(value)
      }
    } finally {
      reader.releaseLock()
    }
  })())
}

/**
 * Serve one synthetic request through the same bridge the protocol uses.
 *
 * The protocol's failure path can only report a net error number to Chromium,
 * so a bundle that cannot answer its own document leaves the window blank with
 * nothing to read. This runs the handler and the Electron 22 response bridge in
 * the main process, where a failure can still be named.
 * @param response - Response the application handler produced.
 * @returns Status and body length the protocol would have delivered.
 */
export async function probeProtocolBridge(response: Response): Promise<{ status: number; bytes: number }> {
  const bridged = await bridgeProtocolResponse(response)
  const { data } = bridged
  const status = bridged.statusCode ?? 200
  if (data === undefined) return { status, bytes: 0 }
  if (typeof data === 'string') return { status, bytes: Buffer.byteLength(data) }
  if (Buffer.isBuffer(data)) return { status, bytes: data.length }
  let bytes = 0
  for await (const chunk of data) bytes += Buffer.byteLength(chunk as Buffer)
  return { status, bytes }
}

/**
 * Read a renderer console error across Electron generations.
 *
 * Electron 22 emits the console event positionally as
 * `(event, level, message, line, sourceId)` with a numeric level, where 3 is
 * an error. Later releases emit `(event, details)` with a details object whose
 * `level` is the string `'error'`.
 *
 * A listener written only against the modern shape silently collects nothing
 * on Electron 22: the first argument is the event, whose `level` is
 * `undefined`, and `undefined !== 'error'` is always true. Reading both
 * shapes keeps the error tail populated on both tracks.
 * @param args - Arguments the console event delivered.
 * @returns Formatted error line, or undefined when the message is not an error.
 */
export function readConsoleMessage(args: readonly unknown[]): string | undefined {
  // Modern shape: (event, details).
  const [first, second] = args
  if (isRecord(second) && typeof second.level === 'string') {
    if (second.level !== 'error') return undefined
    const sourceId = typeof second.sourceId === 'string' ? second.sourceId : 'renderer'
    const lineNumber = typeof second.lineNumber === 'number' ? second.lineNumber : 0
    return `${sourceId}:${String(lineNumber)} ${String(second.message ?? '')}`
  }
  // Legacy shape: (event, level, message, line, sourceId).
  if (typeof second === 'number') {
    if (second !== CONSOLE_ERROR_LEVEL) return undefined
    const message = typeof args[2] === 'string' ? args[2] : ''
    const line = typeof args[3] === 'number' ? args[3] : 0
    const sourceId = typeof args[4] === 'string' ? args[4] : 'renderer'
    return `${sourceId}:${String(line)} ${message}`
  }
  void first
  return undefined
}

/**
 * Report whether a value is a plain object.
 * @param value - Value to inspect.
 * @returns Whether the value can carry named properties.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
