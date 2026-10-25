/**
 * Automated user probe for the Windows 7 track.
 *
 * The Windows 7 track installs Electron 22.3.27, whose API surface is the
 * same on every operating system: an API that release does not have is
 * missing on a Windows Server runner exactly as it is missing on the Windows 7
 * machine. Running the probe against the packaged Windows 7 payload therefore
 * reproduces the failures a Windows 7 user sees, even though the probe itself
 * runs on a newer Windows.
 *
 * The probe is the Electron main process rather than an external observer,
 * because `console-message`, `render-process-gone` and `did-fail-load` are
 * main-process events that cannot be attached to a running application from
 * the outside. It loads the real product entry point, so the code under test
 * is the code that ships.
 *
 * The findings the product does not persist are collected here: renderer
 * console errors are only written to disk when a fatal error follows them, and
 * an unresponsive renderer is not observed at all.
 */

import { mkdir, writeFile, writeFileSync } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = process.env.DSH_WIN7_PROBE_ROOT
if (root === undefined || root.length === 0) {
  console.error('win7 probe: the launcher must allocate DSH_WIN7_PROBE_ROOT')
  app.exit(2)
}

const application = join(root, 'app')
app.setAppPath(application)
app.setPath('userData', join(root, 'userdata'))
app.setPath('logs', join(root, 'logs'))

/** Everything the probe observed. */
const findings = {
  consoleErrors: [],
  consoleWarnings: [],
  renderGone: [],
  loadFailures: [],
  preloadErrors: [],
  unresponsive: [],
  childProcessGone: [],
  uncaught: [],
  unhandledRejection: [],
  windowErrors: [],
  probeError: undefined,
  windowUrl: undefined,
  windowTitle: undefined,
  windowVisible: false,
  documentReady: false,
  documentSummary: undefined,
  screenshots: [],
}

/**
 * Write the probe report.
 * @param {number} code - Process exit code.
 */
function writeReport(code) {
  try {
    writeFileSync(join(root, 'probe.json'), `${JSON.stringify({ ...findings, exitCode: code }, undefined, 2)}\n`)
  } catch {
    // The report is best effort; the exit code still carries the verdict.
  }
}

/**
 * Wait for the application window to appear.
 * @returns The primary window.
 */
async function waitForWindow() {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('dsh-app://'))
    if (window !== undefined) return window
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('win7 probe: no application window appeared within 180s')
}

/**
 * Wait until the renderer reports a rendered document.
 * @param {BrowserWindow} window - Application window.
 */
async function waitForDocument(window) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = await window.webContents.executeJavaScript(`(() => ({
      ready: document.readyState,
      title: document.title,
      text: (document.body?.innerText ?? '').slice(0, 2000),
      elements: document.querySelectorAll('*').length,
    }))()`).catch(() => undefined)
    if (state !== undefined && (state.ready === 'complete' || state.ready === 'interactive')) {
      findings.documentReady = true
      findings.documentSummary = state
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('win7 probe: the document did not reach an interactive state within 120s')
}

/**
 * Capture the window contents.
 * @param {BrowserWindow} window - Application window.
 * @param {string} name - File name for the capture.
 */
async function capture(window, name) {
  try {
    await writeFile(join(root, name), (await window.webContents.capturePage()).toPNG())
    findings.screenshots.push(name)
  } catch (error) {
    findings.consoleErrors.push(`screenshot ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Install the renderer-side error collector.
 *
 * An uncaught exception in the renderer never reaches the main process; the
 * page has to record it itself.
 * @param {BrowserWindow} window - Application window.
 */
function installRendererCollector(window) {
  window.webContents.on('dom-ready', () => {
    void window.webContents.executeJavaScript(`(() => {
      if (globalThis.__dshProbeErrors) return
      globalThis.__dshProbeErrors = []
      globalThis.addEventListener('error', event => {
        globalThis.__dshProbeErrors.push('error: ' + (event.error?.stack ?? event.message))
      })
      globalThis.addEventListener('unhandledrejection', event => {
        globalThis.__dshProbeErrors.push('unhandledrejection: ' + String(event.reason?.stack ?? event.reason))
      })
    })()`).catch(() => undefined)
  })
}

/**
 * Run the probe.
 */
async function probe() {
  await mkdir(root, { recursive: true })
  const entry = pathToFileURL(join(application, 'lib', 'main.js')).href
  await import(entry)
  const window = await waitForWindow()

  // The product owns the error-level console collection; the probe reads the
  // same events so the findings do not depend on the product staying alive.
  window.webContents.on('console-message', (...args) => {
    const [first, second, third, fourth, fifth] = args
    // Electron 22 emits (event, level, message, line, sourceId); later
    // releases emit (event, details).
    if (second !== null && typeof second === 'object') {
      const details = second
      const line = `${String(details.sourceId ?? 'renderer')}:${String(details.lineNumber ?? 0)} ${String(details.message ?? '')}`
      if (details.level === 'error') findings.consoleErrors.push(line)
      else if (details.level === 'warning') findings.consoleWarnings.push(line)
      return
    }
    const level = typeof second === 'number' ? second : 0
    const message = typeof third === 'string' ? third : String(third ?? '')
    const line = `${String(fifth ?? 'renderer')}:${String(fourth ?? 0)} ${message}`
    if (level === 3) findings.consoleErrors.push(line)
    else if (level === 2) findings.consoleWarnings.push(line)
    void first
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    findings.renderGone.push({ reason: details.reason, exitCode: details.exitCode })
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    findings.loadFailures.push({ code, description, url, isMainFrame })
  })
  window.webContents.on('preload-error', (_event, path, error) => {
    findings.preloadErrors.push({ path, error: String(error) })
  })
  window.webContents.on('unresponsive', () => {
    findings.unresponsive.push(Date.now())
  })
  // The product does not observe this at all.
  app.on('child-process-gone', (_event, details) => {
    findings.childProcessGone.push({ name: details.name, reason: details.reason, exitCode: details.exitCode })
  })

  installRendererCollector(window)
  findings.windowUrl = window.webContents.getURL()
  findings.windowTitle = window.webContents.getTitle()
  findings.windowVisible = window.isVisible()

  await waitForDocument(window)
  await capture(window, 'window.png')

  const pageErrors = await window.webContents.executeJavaScript('globalThis.__dshProbeErrors ?? []').catch(() => [])
  if (Array.isArray(pageErrors)) {
    for (const entry of pageErrors) findings.windowErrors.push(String(entry))
  }
}

process.on('uncaughtException', (error) => {
  findings.uncaught.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  writeReport(1)
})
process.on('unhandledRejection', (reason) => {
  findings.unhandledRejection.push(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
})

void probe()
  .then(() => {
    writeReport(0)
    app.exit(0)
  })
  .catch((error) => {
    findings.probeError = error instanceof Error ? (error.stack ?? error.message) : String(error)
    writeReport(1)
    app.exit(1)
  })
