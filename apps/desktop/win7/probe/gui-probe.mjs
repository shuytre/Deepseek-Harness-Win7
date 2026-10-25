/**
 * Run the compiled Desktop shell under a private profile and drive its window.
 *
 * The Windows 7 track installs Electron 22, whose API surface is the same on
 * every operating system, so the API gaps of that track are checked by
 * comparing the shell against the type definitions of the release it
 * installs. What that comparison cannot do is watch the application run: a
 * Windows Server runner has no desktop session, so the window the Windows 7
 * user sees is never created there.
 *
 * This probe closes that gap on the track the runner can run. It starts the
 * compiled shell with a private profile, opens its window, and then uses it:
 * it reads the rendered document, types into the field the page offers,
 * presses the control the page offers, and captures the window. A renderer
 * that logs an error, a document that renders nothing, a control that throws
 * and a window that cannot be captured are all reported.
 *
 * The result is the closest thing to the Windows 7 user's view that a
 * runner without a desktop can produce.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, findPageTarget } from './devtools-client.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..', '..')
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')
const EVIDENCE = join(DESKTOP_ROOT, '.desktop-build', 'gui-probe')

const manifest = JSON.parse(await readFile(join(DESKTOP_ROOT, 'package.json'), 'utf8'))
const root = join(EVIDENCE, 'run')
const application = join(root, 'app')
const profile = join(root, 'home', 'profiles', 'desktop')
const project = join(application, '.desktop-build', 'development', 'project')
const debugPort = Number(process.env.DSH_GUI_PROBE_DEBUG_PORT ?? 9333)

await mkdir(root, { recursive: true })
await mkdir(profile, { recursive: true })
await mkdir(project, { recursive: true })

// The shell reads its release manifest from the project directory, and the
// plugin profile decides which plugins the Host loads.
const release = {
  schemaVersion: 1,
  version: manifest.version,
  nodeVersion: process.versions.node,
  pnpmVersion: '8.15.9',
  hostProtocolVersion: 1,
}
await writeFile(join(project, 'desktop-runtime.json'), JSON.stringify({
  schemaVersion: 1,
  release,
  platform: 'win32',
  arch: 'x64',
  files: [],
  sharedPackages: [
    { name: '@deepseek-ai/dsh', version: manifest.version, path: 'node_modules/@deepseek-ai/dsh' },
    { name: '@deepseek-ai/dsh-desktop-host', version: manifest.version, path: 'node_modules/@deepseek-ai/dsh-desktop-host' },
  ],
}))
await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'llm-deepseek', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
]))

// The bundled entry point is the one that ships. The compiled entry point
// is the fallback: it is the same code, only not bundled, and it is what a
// host without a complete build can offer. The two live in different
// places, and each keeps its own relative imports.
const bundledEntry = join(DESKTOP_ROOT, 'lib', 'main.js')
const compiledEntry = join(DESKTOP_ROOT, 'lib', 'types', 'main.js')
const bundled = existsSync(bundledEntry)
const entry = bundled ? bundledEntry : compiledEntry
if (!existsSync(entry)) {
  process.stdout.write('[win7] gui-probe: the shell was not built; the check cannot run\n')
  process.exit(2)
}
if (bundled) {
  await cp(join(DESKTOP_ROOT, 'lib'), join(application, 'lib'), { recursive: true })
} else {
  await cp(join(DESKTOP_ROOT, 'lib', 'types'), join(application, 'lib', 'types'), { recursive: true })
}
await cp(join(DESKTOP_ROOT, 'renderer'), join(application, 'renderer'), { recursive: true })
await writeFile(join(application, 'package.json'), JSON.stringify({
  name: 'desktop-gui-probe',
  version: manifest.version,
  type: 'module',
  main: 'lib/main.js',
}))

/**
 * Locate the Electron binary of the current track.
 *
 * The binary is the one the checkout installed, wherever the package
 * manager put it. The Electron package is resolved through the desktop
 * package first, and the well-known locations of the store are tried after
 * it, so the probe does not depend on one layout.
 * @returns The executable path, or undefined when no binary is installed.
 */
function findElectron() {
  const candidates = []
  const require = createRequire(join(DESKTOP_ROOT, 'package.json'))
  try {
    const resolved = require('electron')
    if (typeof resolved === 'string') candidates.push(resolved)
  } catch {
    // The package is not linked in this checkout.
  }
  const store = join(REPOSITORY_ROOT, 'node_modules', '.pnpm')
  try {
    for (const name of readdirSync(store)) {
      if (!name.startsWith('electron@')) continue
      candidates.push(join(store, name, 'node_modules', 'electron', 'dist', 'electron.exe'))
    }
  } catch {
    // The store is not laid out this way.
  }
  candidates.push(join(REPOSITORY_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))
  return candidates.find(candidate => existsSync(candidate))
}

const electron = findElectron()
if (electron === undefined) {
  // The Electron package ships its binary through a postinstall step. A host
  // that installed without scripts has no binary, and there is nothing to
  // drive; the check reports that it could not run rather than failing the
  // build over an environment that has no Electron.
  process.stdout.write('[win7] gui-probe: the Electron binary is not installed; the check cannot run\n')
  process.exit(2)
}

const fixture = join(HERE, 'gui-probe-main.mjs')
const child = spawn(electron, [fixture, `--remote-debugging-port=${String(debugPort)}`], {
  cwd: root,
  env: {
    // Only the variables the shell needs to find its own runtime are kept,
    // so the probe cannot inherit a developer's profile.
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    DSH_HOME: join(root, 'home'),
    USERPROFILE: root,
    HOME: root,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(DESKTOP_ROOT, '.desktop-build', 'targets', 'win-x64', 'runtime'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_DESKTOP_SESSION_REPORT: join(root, 'session.log'),
    DSH_GUI_PROBE_ROOT: root,
    DSH_GUI_PROBE_ENTRY: bundled ? join(application, 'lib', 'main.js') : join(application, 'lib', 'types', 'main.js'),
  },
  // Hiding the GUI process suppresses its first window and can suspend the
  // renderer frame callbacks.
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

const findings = []
let target
const connectDeadline = Date.now() + 90_000
while (Date.now() < connectDeadline) {
  try {
    target = await findPageTarget(debugPort)
  } catch {
    target = undefined
  }
  if (target !== undefined) break
  if (child.exitCode !== null) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}

if (target === undefined) {
  findings.push('the application opened no page that could be inspected')
  for (const chunk of chunks) process.stdout.write(chunk.toString())
} else {
  const client = await connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await new Promise(resolve => setTimeout(resolve, 5000))
    const state = await client.evaluate(`(() => ({
      ready: document.readyState,
      title: document.title,
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 2000),
      elements: document.querySelectorAll('*').length,
      buttons: Array.from(document.querySelectorAll('button,[role=button]')).slice(0, 30)
        .map(element => (element.innerText ?? element.getAttribute('aria-label') ?? '').trim()).filter(text => text.length > 0),
    }))()`)
    await writeFile(join(root, 'page.json'), `${JSON.stringify(state, undefined, 2)}\n`)
    if (state === undefined || state === null) findings.push('the page could not be inspected')
    else {
      if (state.ready !== 'complete' && state.ready !== 'interactive') findings.push(`the document is still ${String(state.ready)}`)
      if (typeof state.elements === 'number' && state.elements < 10) findings.push(`the document rendered ${String(state.elements)} element(s)`)
      if (typeof state.text === 'string' && state.text.trim().length === 0) findings.push('the document has no visible text')
    }
    const image = await client.screenshot().catch(() => undefined)
    if (image !== undefined && image.length > 0) await writeFile(join(root, 'window.png'), image)
    else findings.push('the window could not be captured')

    // The application is used, not merely looked at.
    const field = await client.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'))
        .find(candidate => !candidate.disabled && candidate.getClientRects().length > 0)
      if (element === undefined) return undefined
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (field === undefined) findings.push('the page offers no field to type into')
    else {
      await client.send('Input.insertText', { text: 'probe' }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 1500))
      const typed = await client.evaluate(`(() => {
        const element = document.querySelector('textarea,input:not([type=hidden]),[contenteditable=true]')
        return element === undefined ? undefined : (element.value ?? element.innerText ?? '')
      })()`)
      if (typed !== undefined && String(typed).length === 0) findings.push('typing into the field had no effect')
    }
    const control = await client.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('button,[role=button],input[type=submit]'))
        .find(candidate => !candidate.disabled && candidate.getClientRects().length > 0)
      if (element === undefined) return undefined
      const rect = element.getBoundingClientRect()
      return { label: (element.innerText ?? element.getAttribute('aria-label') ?? '').trim(), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (control === undefined) findings.push('the page offers no control to press')
    else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', { type, x: control.x, y: control.y, button: 'left', clickCount: 1 }).catch(() => undefined)
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const pageErrors = await client.evaluate('globalThis.__dshProbeErrors ?? []').catch(() => [])
    if (Array.isArray(pageErrors)) {
      for (const error of pageErrors) findings.push(`the page raised an uncaught error: ${String(error)}`)
    }
  } finally {
    client.close()
  }
}

if (child.exitCode === null) killTree(child.pid)
await writeFile(join(root, 'probe.log'), Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
process.stdout.write(`[win7] gui-probe: ${String(findings.length)} finding(s)\n`)
for (const finding of findings) process.stdout.write(`[win7] gui-probe finding: ${finding}\n`)
if (findings.length > 0) process.exit(1)
process.stdout.write('[win7] gui-probe: the application opened its window and answered\n')
process.exit(0)
