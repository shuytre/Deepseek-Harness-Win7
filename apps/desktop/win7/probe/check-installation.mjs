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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..', '..')
const BUILD_PATHS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const RUN_DIRECTORY = join(REPOSITORY_ROOT, '.desktop-build', 'win7-build')
/**
 * Where the installer is told to put the application.
 *
 * Deliberately outside the run directory: the diagnostics commit copies that
 * directory into a branch, and a full installation is a gigabyte of it.
 */
const INSTALL_DIRECTORY = join(tmpdir(), 'dsh-win7-install-check')
const CHECK_DIRECTORY = join(RUN_DIRECTORY, 'install-check')

/**
 * Locate the produced installer.
 * @returns The installer path, or undefined when the build produced none.
 */
function findInstaller() {
  // An explicit path lets the check run against a downloaded release on a
  // machine that has no build tree, which is how the installer is verified on
  // the operating system it ships to.
  const configured = process.env.DSH_INSTALL_CHECK_INSTALLER
  if (configured !== undefined && configured.length > 0) return existsSync(configured) ? configured : undefined
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

// A stale tree from an earlier run would satisfy every check below without the
// installer having written anything.
rmSync(INSTALL_DIRECTORY, { recursive: true, force: true })
mkdirSync(CHECK_DIRECTORY, { recursive: true })
const logFile = join(CHECK_DIRECTORY, 'install.log')

/**
 * Report whether this host has a desktop session.
 *
 * Kept for the report only: the silent install below does not need one. Every
 * prompt the installer can reach carries `/SD IDOK`, so the run cannot block on
 * a window nothing answers — and skipping the check on a desktop-less host is
 * how a silent install that exited 2 without writing a file went unnoticed.
 * @returns Whether the host has an interactive session.
 */
function hasDesktopSession() {
  // `SessionName` is `Console` for the desktop and `Service` for a session 0
  // process, which is what a hosted runner is.
  const query = spawn('query.exe', ['session'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let output = ''
  query.stdout?.on('data', chunk => { output += chunk.toString() })
  return new Promise(resolvePromise => {
    query.on('error', () => resolvePromise(false))
    query.on('close', () => resolvePromise(/console/iu.test(output)))
    setTimeout(() => resolvePromise(/console/iu.test(output)), 1500)
  })
}

const desktopSession = await hasDesktopSession()
process.stdout.write(`[win7] install-check: installing into a private directory (interactive session: ${String(desktopSession)})\n`)

const timeoutMs = Number(process.env.DSH_INSTALL_CHECK_TIMEOUT_MS ?? 180_000)
/** Log the installer itself writes when it refuses; `$TEMP` on the target machine. */
const INSTALLER_LOG = join(tmpdir(), 'deepseek-harness-installer.log')

/**
 * Kill a process and everything it started.
 * @param {number} pid - Process identifier.
 */
function killTree(pid) {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/**
 * Run the installer silently into one directory and wait for it.
 *
 * The installer's message boxes are suppressed under `/S`, so its own log is the
 * only record of why it refused; it is returned with the run so the diagnostics
 * commit carries the reason.
 * @param label - Name of this run in the report.
 * @param target - Directory the installer is told to use.
 * @returns The exit code, captured output and the installer's own reason.
 */
async function runInstaller(label, target) {
  rmSync(INSTALLER_LOG, { force: true })
  const child = spawn(installer, ['/S', `/D=${target}`], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks = []
  child.stdout?.on('data', chunk => chunks.push(chunk))
  child.stderr?.on('data', chunk => chunks.push(chunk))
  const exit = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      // A silent install that does not finish is a finding, not a reason to hold
      // the build open: the installer is a native program that can wait on a
      // prompt a headless host cannot answer.
      process.stdout.write(`[win7] install-check: ${label} did not finish within ${String(timeoutMs)}ms\n`)
      killTree(child.pid)
      resolvePromise(1)
    }, timeoutMs)
    child.on('error', error => {
      chunks.push(Buffer.from(String(error)))
      clearTimeout(timer)
      resolvePromise(1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise(code ?? 1)
    })
  })
  const output = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  const reason = existsSync(INSTALLER_LOG) ? readFileSync(INSTALLER_LOG, 'utf8').trim() : ''
  writeFileSync(logFile, `${label}: exit=${String(exit)}\n${output}${reason === '' ? '' : `reason:\n${reason}\n`}`, { flag: 'a' })
  return { exit, output, reason }
}

const first = await runInstaller('first install', INSTALL_DIRECTORY)
// Installing over an existing installation is the upgrade path every later
// release takes, and electron-builder hands it to the installed uninstaller
// before it writes anything. It is checked here because a release that only
// installs on a clean machine strands every user who already has one.
const again = await runInstaller('install over the first', INSTALL_DIRECTORY)

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

const code = again.exit
const findings = []
if (first.exit !== 0) findings.push(`a first install exited with ${String(first.exit)}${first.reason === '' ? '' : `: ${first.reason}`}`)
if (again.exit !== 0) findings.push(`installing over an existing installation exited with ${String(again.exit)}${again.reason === '' ? '' : `: ${again.reason}`}`)
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
