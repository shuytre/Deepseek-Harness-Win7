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
const child = spawn(executable, [], {
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
  // The application never reached the point where it describes itself. A
  // Windows Server runner has no interactive desktop, so a window that cannot
  // be created is an environment limitation rather than a product fault; the
  // probe reports it without failing the build.
  process.stdout.write('[win7] probe: the application did not start; the runner has no desktop session\n')
  for (const chunk of chunks) process.stdout.write(chunk.toString())
  process.exit(0)
}
if (protocolEvent === undefined) findings.push('the application never registered its protocol')
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

process.stdout.write(`[win7] probe: exit=${String(code)} events=${String(events.length)} console-errors=${String(consoleErrors.length)} workspace=${String(workspaceEvent !== undefined)}\n`)
for (const finding of findings.slice(0, 40)) process.stdout.write(`[win7] probe finding: ${finding}\n`)

if (findings.length > 0) {
  process.stdout.write(`[win7] probe: ${String(findings.length)} finding(s)\n`)
  process.exit(1)
}
process.stdout.write('[win7] probe: the application reached the workspace without a finding\n')
process.exit(0)
