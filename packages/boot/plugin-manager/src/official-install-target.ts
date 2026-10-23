/** Select Official bundle packages from the running installation without importing provider code. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { bundlePatchPaths, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

const requireFromModule = createRequire(import.meta.url)

/**
 * Read `fs.globSync` from the module object rather than through an ESM named
 * import: the function arrived in Node 22, and a named import of a builtin that
 * lacks it fails at link time, before any fallback can run. The Windows 7
 * compatibility runtime installs the same function on the object.
 * @param pattern - Glob pattern relative to `cwd`.
 * @param options - `cwd` to search from.
 * @returns Matching paths.
 */
function globSync(pattern: string, options: { cwd: string }): string[] {
  const module = requireFromModule('node:fs') as typeof import('node:fs') & { globSync?: typeof import('node:fs').globSync }
  /* v8 ignore next -- every supported runtime and the Windows 7 runtime provide globSync */
  if (typeof module.globSync !== 'function') throw new Error('node:fs.globSync is unavailable on this runtime')
  return module.globSync(pattern, options) as string[]
}

interface WorkspaceManifest extends ProfileManifest {
  main?: string
}

function manifestAt(file: string): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

/**
 * Offer a source checkout link or an exact published package version. Source installations are
 * identified by the real CLI manifest and its unpacked workspace dependencies, including Desktop's
 * development symlink. An incomplete checkout is an error, never a registry fallback.
 * @param name - Official catalog package name.
 * @param installAnchor - Running application's DSH package.json, possibly reached through a symlink.
 * @param version - Running DSH version used by its release family.
 * @returns An ordinary package-manager spec and its package version.
 * @throws when a source installation lacks its workspace package, bundle patch, or built runtime.
 */
export function officialBundleInstallTarget(name: string, installAnchor: string, version: string): { spec: string; version: string } {
  const anchor = realpathSync(installAnchor)
  const installation = manifestAt(anchor)
  const source = installation.name === '@deepseek-ai/dsh'
    && Object.values(installation.dependencies ?? {}).some(value => value.startsWith('workspace:'))
  if (!source) return { spec: `${name}@${version}`, version }
  const root = resolve(dirname(anchor), '../..')
  if (anchor !== join(root, 'apps', 'cli', 'package.json')
    || !existsSync(join(root, 'package.json'))
    || manifestAt(join(root, 'package.json')).name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Official bundle ${name}: source DSH installation ${anchor} requires its complete workspace checkout`)
  }
  const matches = globSync('packages/*/*/package.json', { cwd: root })
    .map(file => ({ file: join(root, file), manifest: manifestAt(join(root, file)) }))
    .filter(entry => entry.manifest.name === name)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error(`Official bundle ${name}: expected one workspace package in ${root}, found ${matches.length}; restore the checkout and run pnpm install`)
  }
  const { file, manifest } = selected
  const directory = realpathSync(dirname(file))
  if (manifest.version !== version || manifest.private === true || manifest.dsh?.bundle === undefined) {
    throw new Error(`Official bundle ${name}: ${file} must declare a public bundle at DSH version ${version}`)
  }
  const main = typeof manifest.main === 'string' ? resolve(directory, manifest.main) : undefined
  if (main === undefined || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Official bundle ${name}: built runtime is missing in ${directory}; run pnpm install and pnpm run build in ${root}`)
  }
  for (const patch of bundlePatchPaths(directory, manifest.dsh.bundle)) {
    if (!existsSync(patch) || !statSync(patch).isFile()) {
      throw new Error(`Official bundle ${name}: bundle patch ${patch} is missing; restore the checkout`)
    }
  }
  return { spec: `link:${directory}`, version }
}
