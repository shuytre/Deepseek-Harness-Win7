/**
 * Launch the automated user probe against the packaged Windows 7 payload.
 *
 * The probe runs as the Electron main process so it can observe the renderer
 * events a product does not persist. This launcher prepares the private
 * directories the probe expects, starts Electron with the packaged
 * application, and guarantees that the whole process tree is gone when the
 * probe finishes or overruns its deadline.
 *
 * A Windows child process is not killed by terminating its parent, so the
 * deadline path kills the tree explicitly; otherwise the Host process would
 * survive the run and hold the build directory open.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')

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
 * Locate the Electron binary the Windows 7 track installs.
 * @returns The executable path, or undefined when it is absent.
 */
function findElectron() {
  const candidates = [
    join(BUILD_PATHS_ROOT, 'electron', 'electron.exe'),
    join(BUILD_PATHS_ROOT, 'electron', 'dist', 'electron.exe'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const packaged = findPackagedApplication()
const electron = findElectron()
if (packaged === undefined || electron === undefined) {
  writeFileSync(join(REPOSITORY_ROOT, '.desktop-build', 'win7-build', 'probe.log'),
    `the packaged application or the Electron runtime is missing\npackaged=${packaged ?? 'none'}\nelectron=${electron ?? 'none'}\n`)
  process.exit(2)
}

const root = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build', 'probe')
mkdirSync(root, { recursive: true })
// The probe loads the product entry point through `app.setAppPath`, so the
// packaged application is presented as a plain directory.
const application = join(root, 'app')
if (!existsSync(application)) cpSync(packaged, application, { recursive: true })

const timeoutMs = Number(process.env.DSH_WIN7_PROBE_TIMEOUT_MS ?? 300_000)
const child = spawn(electron, [join(HERE, 'user-probe.mjs')], {
  cwd: REPOSITORY_ROOT,
  env: {
    ...process.env,
    DSH_WIN7_PROBE_ROOT: root,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    // The probe observes a packaged application; it must not pick up the
    // development runtime of the checkout.
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(application, 'resources', 'runtime', 'primary-runtime'),
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

const timer = setTimeout(() => {
  writeFileSync(join(root, 'probe.log'), `the probe exceeded its ${String(timeoutMs)}ms deadline\n`)
  killTree(child.pid)
}, timeoutMs)

const code = await new Promise(resolvePromise => {
  child.on('error', error => {
    chunks.push(Buffer.from(String(error)))
    resolvePromise(1)
  })
  child.on('close', exit => resolvePromise(exit ?? 1))
})
clearTimeout(timer)
writeFileSync(join(root, 'probe.log'), Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))

const reportPath = join(root, 'probe.json')
if (!existsSync(reportPath)) {
  process.stdout.write(`[win7] probe: no report was produced (exit ${String(code)})\n`)
  process.exit(code === 0 ? 1 : code)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const summary = [
  `exit=${String(report.exitCode)}`,
  `console-errors=${String(report.consoleErrors?.length ?? 0)}`,
  `window-errors=${String(report.windowErrors?.length ?? 0)}`,
  `render-gone=${String(report.renderGone?.length ?? 0)}`,
  `load-failures=${String(report.loadFailures?.length ?? 0)}`,
  `unresponsive=${String(report.unresponsive?.length ?? 0)}`,
  `document-ready=${String(report.documentReady)}`,
].join(' ')
process.stdout.write(`[win7] probe: ${summary}\n`)

const failures = []
for (const error of report.consoleErrors ?? []) failures.push(`console error: ${error}`)
for (const error of report.windowErrors ?? []) failures.push(`window error: ${error}`)
for (const error of report.renderGone ?? []) failures.push(`renderer exited: ${JSON.stringify(error)}`)
for (const error of report.loadFailures ?? []) failures.push(`load failure: ${JSON.stringify(error)}`)
for (const error of report.unresponsive ?? []) failures.push('the renderer became unresponsive')
for (const error of report.uncaught ?? []) failures.push(`uncaught: ${error}`)
for (const error of report.unhandledRejection ?? []) failures.push(`unhandled rejection: ${error}`)
if (report.probeError !== undefined) failures.push(`probe error: ${String(report.probeError)}`)
if (report.documentReady !== true) failures.push('the document never became interactive')

for (const failure of failures.slice(0, 40)) process.stdout.write(`[win7] probe failure: ${failure}\n`)
if (failures.length > 0) {
  process.stdout.write(`[win7] probe: ${String(failures.length)} finding(s)\n`)
  process.exit(1)
}
process.stdout.write('[win7] probe: no findings\n')
process.exit(0)
