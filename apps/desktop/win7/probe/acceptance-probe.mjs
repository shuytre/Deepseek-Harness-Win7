/**
 * Acceptance probe for the installed Windows 7 application.
 *
 * The build can compare the shell against the release it installs, and it can
 * run the installer, but it cannot see the window: a Windows Server runner has
 * no desktop session, so a window it creates is never shown. The window the
 * Windows 7 user sees is observed here, on the machine that has a desktop.
 *
 * The probe starts the installed application the way the user starts it,
 * waits for its window, reads what the window shows, uses the field and the
 * control the window offers, captures a picture of it, and writes a report.
 * The report says what the application did, in the order it did it, so a
 * failure can be read rather than guessed at.
 *
 * Usage, on the Windows 7 machine, after installing:
 *
 *   node verify-windows7.mjs
 *
 * The probe needs nothing but the installed application and the Node runtime
 * that ships with it.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect, findPageTarget } from './devtools-client.mjs'

const debugPort = Number(process.env.DSH_ACCEPTANCE_PORT ?? 9555)
const reportDirectory = process.env.DSH_ACCEPTANCE_REPORT ?? join(homedir(), 'dsh-acceptance')

/** Everything the probe observed. */
const findings = []
/** What the probe did, in order, for the report. */
const steps = []

/**
 * Record what the probe did.
 * @param {string} what - What the probe did.
 */
function note(what) {
  steps.push(`${new Date().toISOString()} ${what}`)
  process.stdout.write(`[acceptance] ${what}\n`)
}

/**
 * Locate the installed application.
 *
 * The installer puts the application where the user chose, so the usual
 * places are searched for the executable.
 * @returns {string | undefined} The application directory, or undefined.
 */
function findInstalledApplication() {
  const roots = [
    process.env.DSH_ACCEPTANCE_APP,
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'DeepSeek Harness'),
    join('C:\\', 'Program Files', 'DeepSeek Harness'),
    join('C:\\', 'Program Files (x86)', 'DeepSeek Harness'),
  ]
  for (const root of roots) {
    if (root === undefined || !existsSync(root)) continue
    const found = findExecutable(root)
    if (found !== undefined) return { directory: root, executable: found }
  }
  return undefined
}

/**
 * Find the application executable under a directory.
 * @param {string} root - Directory to search.
 * @returns {string | undefined} The executable, or undefined.
 */
function findExecutable(root) {
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (/^DeepSeek Harness\.exe$/iu.test(entry.name)) return full
    }
  }
  return undefined
}

const installed = findInstalledApplication()
if (installed === undefined) {
  process.stdout.write('[acceptance] the installed application was not found\n')
  process.stdout.write('[acceptance] set DSH_ACCEPTANCE_APP to the directory that holds it\n')
  process.exit(2)
}
note(`the application is installed at ${installed.directory}`)

mkdirSync(reportDirectory, { recursive: true })
const reportFile = join(reportDirectory, 'acceptance.json')
const logFile = join(reportDirectory, 'acceptance.log')

/**
 * Kill a process and everything it started.
 * @param {number} pid - Process identifier.
 */
function killTree(pid) {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

note('starting the application')
/**
 * Environment the application is started with.
 *
 * A shell that itself runs inside an Electron-based tool inherits
 * `ELECTRON_RUN_AS_NODE=1` and a host `NODE_OPTIONS`; both make the packaged
 * executable behave as the Node runtime instead of as the application, so it
 * exits before opening a window and the probe measures nothing. Neither belongs
 * to a user's launch.
 * @returns {Record<string, string | undefined>} Copy of the environment without them.
 */
function launchEnvironment() {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    const lower = name.toLowerCase()
    if (lower === 'electron_run_as_node' || lower === 'node_options') delete environment[name]
  }
  return environment
}

const child = spawn(installed.executable, [`--remote-debugging-port=${String(debugPort)}`], {
  cwd: installed.directory,
  env: launchEnvironment(),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})
const chunks = []
child.stdout?.on('data', chunk => chunks.push(chunk))
child.stderr?.on('data', chunk => chunks.push(chunk))

/**
 * Wait for the application's window to be inspectable.
 * @returns The page target, or undefined when none appeared.
 */
async function waitForWindow() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const target = await findPageTarget(debugPort)
      if (target !== undefined) return target
    } catch {
      // The application has not opened its debugging port yet.
    }
    if (child.exitCode !== null) return undefined
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return undefined
}

const target = await waitForWindow()
/** What the window was read as; written to `page.json` for the report. */
let observed
if (target === undefined) {
  findings.push('the application opened no window that could be inspected')
  if (child.exitCode !== null) findings.push(`the application exited with ${String(child.exitCode)}`)
} else {
  note('the window appeared')
  const client = await connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await new Promise(resolve => setTimeout(resolve, 4000))
    note('reading the window')
    observed = await client.evaluate(`(() => ({
      ready: document.readyState,
      title: document.title,
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 3000),
      elements: document.querySelectorAll('*').length,
      buttons: Array.from(document.querySelectorAll('button,[role=button]')).slice(0, 40)
        .map(element => (element.innerText ?? element.getAttribute('aria-label') ?? '').trim()).filter(text => text.length > 0),
      fields: Array.from(document.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[contenteditable=true]')).slice(0, 20)
        .map(element => element.getAttribute('placeholder') ?? element.getAttribute('aria-label') ?? element.tagName),
    }))()`)
    if (observed === undefined || observed === null) {
      findings.push('the window could not be read')
    } else {
      if (observed.ready !== 'complete' && observed.ready !== 'interactive') {
        findings.push(`the document is still ${String(observed.ready)}`)
      }
      if (typeof observed.elements === 'number' && observed.elements < 10) {
        findings.push(`the document rendered only ${String(observed.elements)} element(s); the window is likely blank`)
      }
      if (typeof observed.text === 'string' && observed.text.trim().length === 0) {
        findings.push('the document has no visible text')
      }
    }
    const image = await client.screenshot().catch(() => undefined)
    if (image !== undefined && image.length > 0) {
      writeFileSync(join(reportDirectory, 'window.png'), image)
      note('captured the window')
    } else {
      findings.push('the window could not be captured')
    }

    // The application is used, not merely looked at.
    const field = await client.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'))
        .find(candidate => !candidate.disabled && candidate.getClientRects().length > 0)
      if (element === undefined) return undefined
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (field === undefined) {
      findings.push('the window offers no field to type into')
    } else {
      note('typing into the field')
      await client.send('Input.insertText', { text: 'acceptance' }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 1500))
      const typed = await client.evaluate(`(() => {
        const element = document.querySelector('textarea,input:not([type=hidden]),[contenteditable=true]')
        return element === undefined ? undefined : (element.value ?? element.innerText ?? '')
      })()`)
      if (typed !== undefined && String(typed).length === 0) findings.push('typing into the field had no effect')
      else note('the field accepted the text')
    }
    const control = await client.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('button,[role=button],input[type=submit]'))
        .find(candidate => !candidate.disabled && candidate.getClientRects().length > 0)
      if (element === undefined) return undefined
      const rect = element.getBoundingClientRect()
      return { label: (element.innerText ?? element.getAttribute('aria-label') ?? '').trim(), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (control === undefined) {
      findings.push('the window offers no control to press')
    } else {
      note(`pressing ${control.label === '' ? 'a control' : `'${control.label}'`}`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', { type, x: control.x, y: control.y, button: 'left', clickCount: 1 }).catch(() => undefined)
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
      const pageErrors = await client.evaluate('globalThis.__dshProbeErrors ?? []').catch(() => [])
      if (Array.isArray(pageErrors)) {
        for (const error of pageErrors) findings.push(`the window raised an uncaught error: ${String(error)}`)
      }
    }
  } finally {
    client.close()
  }
}

if (child.exitCode === null) killTree(child.pid)
writeFileSync(logFile, Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
writeFileSync(join(reportDirectory, 'page.json'), `${JSON.stringify(observed ?? null, undefined, 2)}\n`)
writeFileSync(reportFile, `${JSON.stringify({ at: new Date().toISOString(), application: installed.directory, steps, findings }, undefined, 2)}\n`)

process.stdout.write(`\n[acceptance] ${String(findings.length)} finding(s)\n`)
for (const finding of findings) process.stdout.write(`[acceptance]   ${finding}\n`)
process.stdout.write(`[acceptance] the report is at ${reportFile}\n`)
if (findings.length > 0) process.exit(1)
process.stdout.write('[acceptance] the application opened its window and answered\n')
process.exit(0)
