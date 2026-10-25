/**
 * Verify that the installer completes on a machine without a desktop.
 *
 * The installer is a native program that extracts an archive, moves a
 * directory into place and registers the application. Every one of those
 * steps is a place where Windows 7 can refuse, and the refusal is what the
 * reported `Windows error 50` was: the extraction never started.
 *
 * The installer supports a silent install, so the whole of it can be run
 * without a desktop and its result can be judged. A silent install that
 * leaves the application directory in place, with the executable and the
 * runtime it needs, is an installation that works.
 *
 * The installation is made into a private directory, so the check does not
 * touch the machine it runs on.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..', '..')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const RUN_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build')
const INSTALL_DIRECTORY = join(RUN_DIRECTORY, 'install-check')

/**
 * Locate the produced installer.
 * @returns The installer path, or undefined when the build produced none.
 */
function findInstaller() {
  const candidates = [
    join(BUILD_PATHS_ROOT, 'unsigned-artifacts'),
    join(BUILD_PATHS_ROOT, 'artifacts'),
    join(REPOSITORY_ROOT, 'dist'),
  ]
  for (const directory of candidates) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (/win7.*setup.*\.exe$/iu.test(name)) return join(directory, name)
    }
  }
  return undefined
}

const installer = findInstaller()
if (installer === undefined) {
  mkdirSync(RUN_DIRECTORY, { recursive: true })
  writeFileSync(join(RUN_DIRECTORY, 'install-check.log'), 'no installer was produced\n')
  process.exit(2)
}

mkdirSync(INSTALL_DIRECTORY, { recursive: true })
const logFile = join(INSTALL_DIRECTORY, 'install.log')

const child = spawn(installer, ['/S', `/D=${INSTALL_DIRECTORY}`], {
  cwd: INSTALL_DIRECTORY,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
const chunks = []
child.stdout?.on('data', chunk => chunks.push(chunk))
child.stderr?.on('data', chunk => chunks.push(chunk))

/**
 * Report whether this host has a desktop session.
 *
 * The installer is a native program that shows a window when it needs
 * something. A host with no session cannot show it, and a silent install
 * there can wait on a prompt nothing answers, so the check reports that it
 * could not run rather than failing the build over an environment that
 * cannot install anything.
 * @returns Whether the host has an interactive session.
 */
function hasDesktopSession() {
  // `SessionName` is `Console` for the desktop and `Service` for a session 0
  // process, which is what a hosted runner is.
  const query = spawn('query.exe', ['session'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let output = ''
  query.stdout?.on('data', chunk => { output += chunk.toString() })
  const code = query.exitCode
  return new Promise(resolvePromise => {
    query.on('error', () => resolvePromise(false))
    query.on('close', () => resolvePromise(false))
    void code
    setTimeout(() => {
      resolvePromise(/console/iu.test(output))
    }, 1500)
  })
}

if (!(await hasDesktopSession())) {
  process.stdout.write('[win7] install-check: skipped, the host has no desktop session\n')
  process.exit(0)
}

const timeoutMs = Number(process.env.DSH_INSTALL_CHECK_TIMEOUT_MS ?? 180_000)
/**
 * Kill a process and everything it started.
 * @param {number} pid - Process identifier.
 */
function killTree(pid) {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

const timer = setTimeout(() => {
  // A silent install that does not finish is a finding, not a reason to hold
  // the build open: the installer is a native program that can wait on a
  // prompt a headless host cannot answer.
  writeFileSync(logFile, Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  process.stdout.write(`[win7] install-check: the installer did not finish within ${String(timeoutMs)}ms\n`)
  killTree(child.pid)
  process.exit(1)
}, timeoutMs)
// The timer is deliberately referenced: a bound that can be dropped when
// nothing else is pending is not a bound. The installer is the only thing
// being waited for, and the wait has to end even if it never finishes.

const code = await new Promise(resolvePromise => {
  child.on('error', error => {
    chunks.push(Buffer.from(String(error)))
    resolvePromise(1)
  })
  child.on('close', exit => resolvePromise(exit ?? 1))
})
clearTimeout(timer)
writeFileSync(logFile, Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))

/**
 * Find the installed application executable.
 * @param {string} root - Installation directory.
 * @returns The executable path, or undefined when none was installed.
 */
function findInstalledApplication(root) {
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

const findings = []
if (code !== 0) findings.push(`the installer exited with ${String(code)}`)
const application = findInstalledApplication(INSTALL_DIRECTORY)
if (application === undefined) {
  findings.push('the installer left no application behind')
} else {
  // The application needs its runtime beside it; an installation that
  // omits it produces an application that cannot start.
  const resources = join(INSTALL_DIRECTORY, 'resources')
  if (!existsSync(resources)) findings.push('the installation has no resources directory')
  else {
    const runtime = join(resources, 'runtime')
    if (!existsSync(runtime)) findings.push('the installation has no runtime directory')
    else if (!existsSync(join(runtime, 'primary-runtime'))) {
      findings.push('the installation has no primary runtime')
    }
  }
  const size = statSync(application).size
  if (size < 1024 * 1024) findings.push(`the installed executable is only ${String(size)} bytes`)
}

process.stdout.write(`[win7] install-check: exit=${String(code)} application=${application === undefined ? 'missing' : 'present'}\n`)
for (const finding of findings) process.stdout.write(`[win7] install-check finding: ${finding}\n`)
if (findings.length > 0) {
  process.stdout.write(`[win7] install-check: ${String(findings.length)} finding(s)\n`)
  process.exit(1)
}
process.stdout.write('[win7] install-check: the installer completed\n')
process.exit(0)
