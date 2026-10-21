/** Stage explicitly selected Desktop patches without modifying the source workspace. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import yaml from 'js-yaml'
import { valid } from 'semver'
import { DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES, DESKTOP_RUNTIME_PATCHES, type DesktopRuntimePatch } from './runtime-patch-policy.ts'

/** Expected patch bytes and package version for one independent installation. */
export interface PreparedRuntimePatch {
  spec: string
  name: string
  version: string
  path: string
  hash: string
}

/** Selected bytes and dependencies excluded from the Desktop runtime. */
export interface PreparedRuntimePatches {
  patches: PreparedRuntimePatch[]
  workspaceOnly: string[]
}

function patchIdentity(spec: string): { name: string; version: string } {
  const separator = spec.lastIndexOf('@')
  const name = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (separator <= 0 || valid(version) !== version) throw new Error(`desktop patches: expected an exact package version: ${spec}`)
  return { name, version }
}

function patchHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Stage selected patches and explicit overrides before Desktop resolves its temporary lockfile.
 * Every root patch must be classified; shared bytes must match the root lockfile's pnpm 11 hash.
 * @param projectRoot Disposable project containing pnpm-workspace.yaml, outside the repository root itself.
 * @param repositoryRoot Source repository; its files remain read-only.
 * @param policy Desktop patch decisions, including optional runtime-only files relative to the repository.
 * @param overrides Explicit Desktop dependency constraints; patch versions never generate overrides.
 * @returns Expected patch identities and hashes for lockfile and staged-file verification.
 */
export function prepareRuntimePatches(
  projectRoot: string, repositoryRoot: string,
  policy: Readonly<Record<string, DesktopRuntimePatch>> = DESKTOP_RUNTIME_PATCHES,
  overrides: Readonly<Record<string, string>> = DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES,
): PreparedRuntimePatches {
  if (resolve(projectRoot) === resolve(repositoryRoot)) throw new Error('desktop patches: destination must not be the source workspace')
  const source = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    patchedDependencies: Record<string, string>
  }
  const sourceLock = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    patchedDependencies: Record<string, string>
  }
  for (const spec of Object.keys(source.patchedDependencies)) {
    if (!Object.hasOwn(policy, spec)) throw new Error(`desktop patches: classify the workspace patch ${spec}`)
  }
  const selected: Array<PreparedRuntimePatch & { bytes: Buffer }> = []
  for (const [spec, rule] of Object.entries(policy)) {
    const identity = patchIdentity(spec)
    if (rule.scope !== 'runtime-only' && !Object.hasOwn(source.patchedDependencies, spec)) {
      throw new Error(`desktop patches: stale workspace patch decision ${spec}`)
    }
    if (rule.scope === 'workspace-only') continue
    const sourcePath = rule.scope === 'shared' ? source.patchedDependencies[spec]! : rule.path
    const localPath = relative(resolve(repositoryRoot), resolve(repositoryRoot, sourcePath))
    if (isAbsolute(sourcePath) || localPath.startsWith('..') || isAbsolute(localPath)) {
      throw new Error(`desktop patches: patch must be inside the repository: ${sourcePath}`)
    }
    const bytes = readFileSync(join(repositoryRoot, sourcePath))
    const hash = patchHash(bytes)
    if (rule.scope === 'shared' && sourceLock.patchedDependencies[spec] !== hash) {
      throw new Error(`desktop patches: shared patch hash differs from the root lockfile: ${spec}`)
    }
    selected.push({ spec, ...identity, path: `patches/desktop-${selected.length}.patch`, hash, bytes })
  }
  const targetPath = join(projectRoot, 'pnpm-workspace.yaml')
  const target = yaml.load(readFileSync(targetPath, 'utf8')) as Record<string, unknown> & { overrides?: Record<string, string> }
  for (const [name, version] of Object.entries(overrides)) {
    if (target.overrides?.[name] !== undefined && target.overrides[name] !== version) {
      throw new Error(`desktop patches: conflicting dependency override for ${name}`)
    }
  }
  // pnpm 10.16+ reads overrides and patched dependencies from pnpm-workspace.yaml;
  // pnpm 8 - which the Windows 7 track stages - reads them from the project
  // manifest's `pnpm` field only. The workspace file already carries the core
  // package set's local-tarball overrides, so the manifest must mirror those too,
  // or first-party packages resolve from the registry.
  const manifestPath = join(projectRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & { pnpm?: Record<string, unknown> }
  const manifestPnpm = manifest.pnpm ?? {}
  const manifestOverrides = (manifestPnpm.overrides ?? {}) as Record<string, string>
  const manifestPatched = (manifestPnpm.patchedDependencies ?? {}) as Record<string, string>
  const mergedOverrides = { ...target.overrides, ...overrides }
  for (const [name, version] of Object.entries(mergedOverrides)) {
    if (manifestOverrides[name] !== undefined && manifestOverrides[name] !== version) {
      throw new Error(`desktop patches: conflicting dependency override for ${name}`)
    }
  }
  const selectedPatches = Object.fromEntries(selected.map(entry => [entry.spec, entry.path]))
  for (const [spec, path] of Object.entries(selectedPatches)) {
    if (manifestPatched[spec] !== undefined && manifestPatched[spec] !== path) {
      throw new Error(`desktop patches: conflicting patched dependency for ${spec}`)
    }
  }
  mkdirSync(join(projectRoot, 'patches'), { recursive: true })
  for (const entry of selected) writeFileSync(join(projectRoot, entry.path), entry.bytes)
  writeFileSync(targetPath, yaml.dump({ ...target, overrides: mergedOverrides,
    patchedDependencies: { ...(target.patchedDependencies as Record<string, string> | undefined), ...selectedPatches },
    allowUnusedPatches: false }))
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest,
    pnpm: { ...manifestPnpm, overrides: { ...manifestOverrides, ...mergedOverrides }, patchedDependencies: { ...manifestPatched, ...selectedPatches } },
  }, undefined, 2)}\n`)
  return { patches: selected.map(({ bytes: _bytes, ...entry }) => entry),
    workspaceOnly: Object.entries(policy).filter(([, rule]) => rule.scope === 'workspace-only').map(([spec]) => patchIdentity(spec).name) }
}

/**
 * Normalize one lockfile package key. pnpm 8 writes lockfile v6 keys with a
 * leading slash (`/@scope/name@1.0.0`); pnpm 11's v9 keys carry none.
 * @param spec - Raw lockfile package key.
 * @returns Key without the version-6 leading slash.
 */
function lockPackageKey(spec: string): string {
  return spec.startsWith('/') ? spec.slice(1) : spec
}

/**
 * Read the version out of a lockfile package key, dropping pnpm's parenthesised
 * suffixes: `(patch_hash=...)` and peer-dependency groups both trail the version.
 * @param key - Normalized lockfile package key.
 * @param name - Package name the key starts with.
 * @returns Version text, or undefined when the key does not start with `name@`.
 */
function lockPackageVersion(key: string, name: string): string | undefined {
  if (!key.startsWith(`${name}@`)) return undefined
  const rest = key.slice(name.length + 1)
  const parenthesis = rest.indexOf('(')
  return parenthesis < 0 ? rest : rest.slice(0, parenthesis)
}

/** One lockfile's record of a patched dependency, across lockfile generations. */
type LockPatchRecord =
  | { readonly format: 'sha256', readonly hash: string }
  | { readonly format: 'pnpm', readonly hash: string, readonly path: string }

/**
 * Read patched-dependency records from either lockfile generation.
 *
 * pnpm 11 (v9) maps `spec` to the patch file's sha256; pnpm 8 (v6) nests
 * `{ hash, path }`, where the hash is pnpm's own digest rather than a sha256 -
 * the staged bytes are re-hashed separately for that generation.
 * @param lock - Parsed lockfile.
 * @returns Records keyed by patch spec.
 */
function lockPatchedDependencies(lock: { patchedDependencies?: Record<string, unknown> }): Map<string, LockPatchRecord> {
  const records = new Map<string, LockPatchRecord>()
  for (const [spec, value] of Object.entries(lock.patchedDependencies ?? {})) {
    if (typeof value === 'string') {
      records.set(spec, { format: 'sha256', hash: value })
      continue
    }
    if (value === null || typeof value !== 'object') continue
    const entry = value as { hash?: unknown, path?: unknown }
    if (typeof entry.hash === 'string' && typeof entry.path === 'string') {
      records.set(spec, { format: 'pnpm', hash: entry.hash, path: entry.path })
    }
  }
  return records
}

/**
 * Reject changed patch bytes, lock hashes or resolved versions before the frozen production install.
 * @param projectRoot Independent Desktop installation containing its resolved lockfile.
 * @param plan Expected identities and exclusions returned by patch preparation.
 */
export function verifyRuntimePatches(projectRoot: string, plan: PreparedRuntimePatches): void {
  const lock = yaml.load(readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    patchedDependencies?: Record<string, unknown>
    packages?: Record<string, { version?: string }>
  }
  const patched = lockPatchedDependencies(lock)
  for (const patch of plan.patches) {
    if (!Object.keys(lock.packages ?? {}).some(spec => lockPackageKey(spec).startsWith(`${patch.name}@`))) {
      throw new Error(`desktop patches: selected patch has no runtime dependency: ${patch.spec}`)
    }
    if (patchHash(readFileSync(join(projectRoot, patch.path))) !== patch.hash) {
      throw new Error(`desktop patches: staged patch bytes changed: ${patch.spec}`)
    }
    const record = patched.get(patch.spec)
    if (record === undefined) throw new Error(`desktop patches: lockfile omits the patch: ${patch.spec}`)
    if (record.format === 'sha256') {
      if (record.hash !== patch.hash) throw new Error(`desktop patches: lockfile patch hash mismatch: ${patch.spec}`)
    } else if (record.path !== patch.path || record.hash === '') {
      // pnpm's own digest cannot be recomputed here; the staged bytes above carry the sha256 identity.
      throw new Error(`desktop patches: lockfile patch record mismatch: ${patch.spec}`)
    }
  }
  for (const [spec, entry] of Object.entries(lock.packages ?? {})) {
    const key = lockPackageKey(spec)
    if (plan.workspaceOnly.some(name => key.startsWith(`${name}@`))) {
      throw new Error(`desktop patches: workspace-only dependency entered the runtime: ${spec}; review its patch scope`)
    }
    const candidates = plan.patches.filter(patch => key.startsWith(`${patch.name}@`))
    if (candidates.length === 0) continue
    if (!candidates.some(patch => (entry.version ?? lockPackageVersion(key, patch.name)) === patch.version)) {
      throw new Error(`desktop patches: ${spec} has no matching patch; review its version and Desktop patch policy`)
    }
  }
}
