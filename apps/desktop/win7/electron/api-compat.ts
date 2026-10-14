/**
 * Electron API compatibility for the Windows 7 track (Electron 22).
 *
 * Electron 22 ships Chromium 108 / Node 16.17.1 and therefore lacks APIs the
 * Win10 track uses: `WebContentsView` (30), `webUtils` (29), `net.fetch` (25),
 * `session.closeAllConnections` (25). Each entry point below prefers the modern
 * API when it exists and falls back to the Electron 22 equivalent, so a single
 * source tree serves both tracks.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, Session, WebContents } from 'electron'

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
    arrayBuffer: () => Promise.resolve(input.body.buffer.slice(input.body.byteOffset, input.body.byteOffset + input.body.byteLength)),
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
  const candidate = contents as WebContents & { close?: (options?: { waitForBeforeUnload?: boolean }) => void }
  try {
    candidate.close?.({ waitForBeforeUnload: false })
  } catch {
    contents.destroy()
  }
}
