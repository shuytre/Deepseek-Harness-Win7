/**
 * Chrome DevTools Protocol client for the Windows 7 probe.
 *
 * The probe drives the packaged application the way a user drives it. The
 * application is started with a debugging port, and this client speaks the
 * DevTools protocol to the page it opened: the probe can read the rendered
 * document, click a control, type into a field and take a picture of the
 * window.
 *
 * This is what turns the probe from a start-up check into a use of the
 * application. The Windows 7 track installs Electron 22, whose Chromium 108
 * speaks the same protocol, so the same client works on both tracks.
 */

/**
 * A pending call, resolved when its response arrives.
 * @typedef {{ resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }} PendingCall
 */

/**
 * Connect to a DevTools protocol endpoint.
 * @param {string} webSocketDebuggerUrl - Endpoint of the page target.
 * @returns The connected client.
 */
export async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  const events = []

  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => rejectPromise(new Error('the DevTools endpoint refused the connection')), { once: true })
  })

  socket.addEventListener('message', (message) => {
    let payload
    try {
      payload = JSON.parse(String(message.data))
    } catch {
      return
    }
    if (payload.id !== undefined) {
      const call = pending.get(payload.id)
      if (call === undefined) return
      pending.delete(payload.id)
      if (payload.error !== undefined) call.reject(new Error(payload.error.message))
      else call.resolve(payload.result ?? {})
      return
    }
    events.push(payload)
  })

  /**
   * Send one protocol command.
   * @param {string} method - Command name.
   * @param {Record<string, unknown>} parameters - Command parameters.
   * @returns The command result.
   */
  const send = (method, parameters = {}) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
    socket.send(JSON.stringify({ id, method, params: parameters }))
  })

  return {
    send,
    events,
    /**
     * Evaluate an expression in the page and return its value.
     * @param {string} expression - JavaScript expression.
     * @returns The evaluated value.
     */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails !== undefined) {
        const details = result.exceptionDetails
        const text = details.exception?.description ?? details.text ?? 'the evaluation failed'
        throw new Error(String(text))
      }
      return result.result?.value
    },
    /**
     * Capture the page as a PNG image.
     * @returns The image bytes.
     */
    async screenshot() {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(String(result.data ?? ''), 'base64')
    },
    close() {
      socket.close()
    },
  }
}

/**
 * Find the page target of a running application.
 * @param {number} port - Debugging port of the application.
 * @returns The page target, or undefined when the application opened none.
 */
export async function findPageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
  const targets = await response.json()
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl !== undefined)
  // The application window is the page whose URL carries the application
  // scheme; the other pages are the DevTools and the background ones.
  return pages.find(target => String(target.url).startsWith('dsh-app://')) ?? pages[0]
}
