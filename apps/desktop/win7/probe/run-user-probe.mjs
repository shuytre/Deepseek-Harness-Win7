/**
 * Launch the automated user probe against the packaged Windows 7 payload.
 *
 * The probe starts the packaged application exactly as a user would, and
 * reads the session report the application writes for itself. Starting the
 * real executable is what makes the observation faithful: the packaged entry
 * point, the packaged runtime and the packaged protocol registration are all
 * the ones that ship.
 *
 * The Windows 7 track installs Electron 22.3.27, whose API surface is the
 * same on every operating system, so an API the Windows 7 runtime lacks is
 * missing here too. The failures this probe reports are therefore the
 * failures a Windows 7 user sees.
 *
 * A Windows child process is not killed by terminating its parent, so the
 * deadline path kills the tree explicitly; otherwise the Host process would
 * survive the run and hold the build directory open.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, findPageTarget } from './devtools-client.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// The probe lives in `apps/desktop/win7/probe`, so the repository root is
// four levels up.
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..', '..')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const RUN_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build')
const PROBE_DIRECTORY = join(RUN_DIRECTORY, 'probe')

/**
 * Locate the packaged application directory of the Windows 7 build.
 * @returns The application root, or undefined when the build produced none.
 */
function findPackagedApplication() {
  const candidates = [
    join(BUILD_PATHS_ROOT, 'unsigned-artifacts', 'win-unpacked'),
    join(BUILD_PATHS_ROOT, 'artifacts', 'win-unpacked'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'resources', 'app.asar')))
}

/**
 * Locate the packaged application executable.
 * @param {string} root - Packaged application root.
 * @returns The executable path, or undefined when it is absent.
 */
function findExecutable(root) {
  const candidates = [
    join(root, 'DeepSeek Harness.exe'),
    join(root, 'deepseek-harness.exe'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const packaged = findPackagedApplication()
if (packaged === undefined) {
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  writeFileSync(join(RUN_DIRECTORY, 'probe.log'), `the packaged application is missing under ${BUILD_PATHS_ROOT}\n`)
  process.exit(2)
}const executable = findExecutable(packaged)
if (executable === undefined) {
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  writeFileSync(join(RUN_DIRECTORY, 'probe.log'), `the packaged application has no executable under ${packaged}\n`)
  process.exit(2)
}

mkdirSync(PROBE_DIRECTORY, { recursive: true })
const reportFile = join(PROBE_DIRECTORY, 'session.log')
const diagnosticFile = join(PROBE_DIRECTORY, 'fatal.log')
if (existsSync(reportFile)) writeFileSync(reportFile, '')

const timeoutMs = Number(process.env.DSH_WIN7_PROBE_TIMEOUT_MS ?? 240_000)
const debugPort = Number(process.env.DSH_WIN7_PROBE_DEBUG_PORT ?? 9222)
const child = spawn(executable, [`--remote-debugging-port=${String(debugPort)}`], {
  cwd: packaged,
  env: {
    ...process.env,
    // The application writes its own session report here.
    DSH_DESKTOP_SESSION_REPORT: reportFile,
    DSH_DESKTOP_DIAGNOSTIC_FILE: diagnosticFile,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    // The probe owns the profile, so the application must not adopt a
    // protocol client or a single-instance lock of the developer's machine.
    DSH_WIN7_TRACE_FILE: join(PROBE_DIRECTORY, 'win7-trace.log'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})

const chunks = []
child.stdout?.on('data', chunk => chunks.push(chunk))
child.stderr?.on('data', chunk => chunks.push(chunk))

/**
 * Kill a process and everything it started.
 * @param {number} pid - Process identifier.
 */
function killTree(pid) {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/**
 * Read the events the application has reported so far.
 * @returns The parsed events.
 */
function readEvents() {
  if (!existsSync(reportFile)) return []
  const events = []
  for (const line of readFileSync(reportFile, 'utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // The tail of the file is the renderer console section in plain text.
    }
  }
  return events
}

let timedOut = false
let settled = false
const deadline = Date.now() + timeoutMs
while (Date.now() < deadline) {
  const events = readEvents()
  // The application reaches the workspace once it has loaded the page and
  // shown the window; that is the point where the renderer has reported
  // whatever it reports.
  if (events.some(event => event.kind === 'workspace')) { settled = true; break }
  if (events.some(event => event.kind === 'fatal')) { settled = true; break }
  if (child.exitCode !== null) { settled = true; break }
  await new Promise(resolve => setTimeout(resolve, 1000))
}

/**
 * Use the application the way a user does.
 *
 * The window is inspected through the DevTools protocol: the rendered
 * document is read, a picture of it is taken, and the controls it offers
 * are listed. A window that opens but renders nothing is a failure the
 * start-up report alone would not show.
 * @returns The findings of the interaction.
 */
async function useApplication() {
  const findings = []
  let target
  const connectDeadline = Date.now() + 60_000
  while (Date.now() < connectDeadline) {
    try {
      target = await findPageTarget(debugPort)
    } catch {
      target = undefined
    }
    if (target !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (target === undefined) {
    findings.push('the application exposed no page to inspect')
    return findings
  }
  const client = await connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    // Let the document settle before it is read.
    await new Promise(resolve => setTimeout(resolve, 3000))
    const state = await client.evaluate(`(() => ({
      ready: document.readyState,
      title: document.title,
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 3000),
      elements: document.querySelectorAll('*').length,
      buttons: Array.from(document.querySelectorAll('button,[role=button],a')).slice(0, 40)
        .map(element => (element.innerText ?? element.getAttribute('aria-label') ?? '').trim()).filter(text => text.length > 0),
      inputs: Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]')).slice(0, 20)
        .map(element => element.getAttribute('placeholder') ?? element.getAttribute('aria-label') ?? element.tagName),
    }))()`)
    writeFileSync(join(PROBE_DIRECTORY, 'page.json'), `${JSON.stringify(state, undefined, 2)}\n`)
    if (state === undefined || state === null) findings.push('the page could not be inspected')
    else {
      if (state.ready !== 'complete' && state.ready !== 'interactive') {
        findings.push(`the document is still ${String(state.ready)}`)
      }
      if (typeof state.elements === 'number' && state.elements < 10) {
        findings.push(`the document rendered ${String(state.elements)} element(s); the window is likely blank`)
      }
      if (typeof state.text === 'string' && state.text.trim().length === 0) {
        findings.push('the document has no visible text')
      }
    }
    const image = await client.screenshot().catch(() => undefined)
    if (image !== undefined && image.length > 0) writeFileSync(join(PROBE_DIRECTORY, 'window.png'), image)
    else findings.push('the window could not be captured')
    // The application is used, not merely looked at. A control is exercised
    // and the page is read again: a control that throws when it is used is a
    // fault the start-up observation cannot show.
    const used = await useControls(client)
    for (const finding of used) findings.push(finding)
  } finally {
    client.close()
  }
  return findings
}

/**
 * Exercise the controls the page offers.
 *
 * The interface is assembled at run time, so the probe looks for the
 * controls by what they are rather than by a fixed name: the first text
 * field that can be filled, and the first control that submits. Each is
 * used, and the page is read again to see whether the use changed anything
 * and whether it produced an error.
 * @param {object} client - Connected DevTools client.
 * @returns {Promise<string[]>} The findings of the interaction.
 */
async function useControls(client) {
  const findings = []
  const before = await client.evaluate('document.querySelectorAll("*").length')
  const input = await client.evaluate(`(() => {
    const field = Array.from(document.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'))
      .find(element => !element.disabled && element.getClientRects().length > 0)
    if (field === undefined) return undefined
    const rect = field.getBoundingClientRect()
    return { tag: field.tagName, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  if (input === undefined) {
    findings.push('the page offers no field to type into')
    return findings
  }
  // Typing into a field is the first thing a user does, and it is the
  // first thing that runs the client code of the page.
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }).catch(() => undefined)
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' }).catch(() => undefined)
  await client.send('Input.insertText', { text: 'probe' }).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 1000))
  const typed = await client.evaluate(`(() => {
    const field = document.querySelector('textarea,input:not([type=hidden]),[contenteditable=true]')
    return field === undefined ? undefined : (field.value ?? field.innerText ?? '')
  })()`)
  if (typed !== undefined && String(typed).length === 0) {
    findings.push('typing into the field had no effect')
  }
  const button = await client.evaluate(`(() => {
    const element = Array.from(document.querySelectorAll('button,[role=button],input[type=submit]'))
      .find(candidate => !candidate.disabled && candidate.getClientRects().length > 0)
    if (element === undefined) return undefined
    const rect = element.getBoundingClientRect()
    return { label: (element.innerText ?? element.getAttribute('aria-label') ?? '').trim(), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  if (button === undefined) {
    findings.push('the page offers no control to press')
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type,
        x: button.x,
        y: button.y,
        button: 'left',
        clickCount: 1,
      }).catch(() => undefined)
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const after = await client.evaluate('document.querySelectorAll("*").length')
  if (before !== undefined && after !== undefined && after < before) {
    findings.push(`the page lost elements after the interaction (${String(before)} to ${String(after)})`)
  }
  const errors = await client.evaluate('globalThis.__dshProbeErrors ?? []').catch(() => [])
  if (Array.isArray(errors) && errors.length > 0) {
    for (const error of errors) findings.push(`the page raised an uncaught error: ${String(error)}`)
  }
  return findings
}

const interactionFindings = settled ? await useApplication() : []

// The application keeps running after it reaches the workspace, so the probe
// ends it once the observation is complete.
if (child.exitCode === null) killTree(child.pid)

const code = await new Promise(resolvePromise => {
  if (child.exitCode !== null) { resolvePromise(child.exitCode); return }
  child.on('close', exit => resolvePromise(exit ?? 1))
})
if (!settled) timedOut = true
writeFileSync(join(PROBE_DIRECTORY, 'probe.log'), Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))

const events = readEvents()
const consoleErrors = events.filter(event => event.kind === 'renderer-console').map(event => String(event.detail))
const fatal = events.find(event => event.kind === 'fatal')
const renderGone = events.filter(event => event.kind === 'render-process-gone')
const loadFailures = events.filter(event => event.kind === 'did-fail-load')
const preloadErrors = events.filter(event => event.kind === 'preload-error')
const protocolEvent = events.find(event => event.kind === 'protocol')
const workspaceEvent = events.find(event => event.kind === 'workspace')
const startedEvent = events.find(event => event.kind === 'start')

const findings = []
if (startedEvent === undefined) {
  // The shell records `start` from its first product module, before it opens a
  // window, registers a protocol, or reaches the backend. Writing one line
  // needs no desktop, so a run with no `start` record never loaded the shell at
  // all: the main bundle threw while being evaluated. That used to be read as
  // "the runner has no desktop session" and passed, which is how an installer
  // whose entry point could not load shipped. It fails here instead.
  const stderr = chunks.map(chunk => chunk.toString()).join('').trim()
  const diagnosticText = existsSync(diagnosticFile) ? readFileSync(diagnosticFile, 'utf8').trim() : ''
  process.stdout.write(`[win7] probe: the application never loaded its shell (exit=${String(child.exitCode)})\n`)
  if (stderr.length > 0) process.stdout.write(`[win7] probe: stderr\n${stderr.slice(-4000)}\n`)
  if (diagnosticText.length > 0) process.stdout.write(`[win7] probe: diagnostic\n${diagnosticText.slice(0, 4000)}\n`)
  writeFileSync(join(PROBE_DIRECTORY, 'probe.log'), Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  process.exit(1)
}
if (protocolEvent === undefined) findings.push('the application never registered its protocol')
// The profile has to resolve the shipped packages: a profile that cannot is a
// profile whose plugins run another release of the product, and the browser
// then gets client bundles this build never produced. The shell counts them
// while preparing the profile, before the Host starts — so the record only
// exists on a launch that got that far, and a launch that did not is already
// reported as a workspace that never mounted.
const profileEvent = events.find(event => event.kind === 'profile')
if (profileEvent !== undefined) {
  const resolvable = Number.parseInt(/(\d+)/u.exec(String(profileEvent.detail))?.[1] ?? '0', 10)
  if (!Number.isSafeInteger(resolvable) || resolvable <= 0) {
    findings.push(`the profile resolves no shipped package: ${String(profileEvent.detail)}`)
  }
}
// The shell answers its own document through the same handler and the same
// Electron 22 response bridge the window uses, from the main process. That is the
// only place a broken bridge can be seen without a desktop: to Chromium it is
// just net error -2 and an empty page.
const selfCheck = events.find(event => event.kind === 'protocol-selfcheck')
if (selfCheck === undefined) {
  findings.push('the application never answered its own document')
} else if (!/^status=200 bytes=[1-9]/u.test(String(selfCheck.detail))) {
  findings.push(`the application could not answer its own document: ${String(selfCheck.detail)}`)
}
if (fatal !== undefined) findings.push(`the application failed to start: ${String(fatal.detail)}`)
if (workspaceEvent === undefined && fatal === undefined) {
  findings.push('the application never reached the workspace')
}
for (const error of consoleErrors) findings.push(`renderer console error: ${error}`)
for (const error of renderGone) findings.push(`the renderer exited: ${String(error.detail)}`)
for (const error of loadFailures) findings.push(`the page failed to load: ${String(error.detail)}`)
for (const error of preloadErrors) findings.push(`the preload failed: ${String(error.detail)}`)
if (existsSync(diagnosticFile)) {
  findings.push(`fatal diagnostic: ${readFileSync(diagnosticFile, 'utf8').slice(0, 2000)}`)
}
if (timedOut) findings.push(`the application did not reach the workspace within ${String(timeoutMs)}ms`)
for (const finding of interactionFindings) findings.push(finding)

/**
 * Whether this runner has a desktop a window can be shown on.
 *
 * A hosted Windows runner executes the job in session 0, whose window station no
 * user is attached to; Windows names that session `Services`. Chromium's renderer
 * needs a window station and dies with an access violation (`-1073741819`) when
 * it has none, and the browser process follows with `0x80000003`. A machine a
 * person is sitting in front of reports `Console`.
 * @returns Whether the session is interactive.
 */
const interactiveDesktop = (process.env.SESSIONNAME ?? '').toLowerCase() === 'console'

/**
 * Whether a finding can only be produced by a session that has a desktop.
 *
 * These are the observations that need a window station: the page, the renderer
 * behind it, and the workspace the page displays. Anything else — a fatal
 * report, a protocol that was never registered, a preload error, a renderer
 * console error — is reported by the shell or the browser process itself and
 * fails on every session.
 * @param finding - One recorded finding.
 * @returns Whether the finding needs a desktop to be observed.
 */
function needsDesktop(finding) {
  return finding.startsWith('the application never reached the workspace')
    || finding.startsWith('the renderer exited: crashed')
    || finding.startsWith('the application exposed no page to inspect')
    || finding.startsWith('the application did not reach the workspace within')
}

process.stdout.write(
  `[win7] probe: exit=${String(code)} events=${String(events.length)} console-errors=${String(consoleErrors.length)} `
  + `workspace=${String(workspaceEvent !== undefined)} shell=${String(startedEvent !== undefined)} `
  + `session=${process.env.SESSIONNAME ?? 'unknown'}\n`,
)
for (const finding of findings.slice(0, 40)) process.stdout.write(`[win7] probe finding: ${finding}\n`)

const observable = findings.filter(finding => !needsDesktop(finding))
if (findings.length > 0 && observable.length === 0 && !interactiveDesktop) {
  // The shell loaded, and every finding is one only a desktop can produce: the
  // renderer cannot get a window station in session 0, so a window that cannot
  // exist is not a product fault. Recorded, not failed — the check that runs on
  // a desktop is `acceptance-probe.mjs`, on the machine the user installs on.
  process.stdout.write(
    `[win7] probe: ${String(findings.length)} finding(s) are unobservable without a desktop; `
    + 'the shell itself loaded and reported itself\n',
  )
  process.exit(0)
}
if (findings.length > 0) {
  process.stdout.write(`[win7] probe: ${String(findings.length)} finding(s), ${String(observable.length)} of them independent of a desktop\n`)
  process.exit(1)
}
process.stdout.write('[win7] probe: the application reached the workspace without a finding\n')
process.exit(0)
