/** Validate the assembled application, including native Office conversion outside ASAR. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const executable = windows ? join(application, 'DeepSeek Harness.exe') : join(application, 'MacOS', 'DeepSeek Harness')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
// The Windows 7 track ships the runtime as plain files (`resources/dsh`) because
// its real `node.exe` cannot read inside `app.asar`; smoke the tree the
// application itself launches.
const packedDsh = join(resources, 'app.asar', 'dsh')
const dshCandidates = [join(resources, 'dsh'), join(resources, 'app.asar.unpacked', 'dsh')]
const dsh = dshCandidates.find(directory => existsSync(join(directory, 'package.json'))) ?? packedDsh
// The Host CLI is the first thing every packaged smoke starts; when it is absent,
// name what the shipped tree actually holds so the failure is diagnosable.
const hostCli = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
if (!existsSync(hostCli)) {
  const hostPackage = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  process.stderr.write(`desktop package: missing ${hostCli}\n`)
  for (const directory of [join(dsh, 'node_modules', '@deepseek-ai'), hostPackage, join(hostPackage, 'lib')]) {
    process.stderr.write(`desktop package: ${directory} -> ${existsSync(directory) ? JSON.stringify(readdirSync(directory).slice(0, 40)) : 'absent'}\n`)
  }
  throw new Error('desktop package: the shipped runtime omits the Host CLI')
}
await smokePreparedRuntime(dsh, executable, join(resources, 'runtime'), descriptor)
