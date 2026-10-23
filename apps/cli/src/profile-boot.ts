/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  readProfilePatches,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  reportSkippedBundles,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  traceWin7Stage,
  type ProfileContext,
  type Profile,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. Shipped profile names are reserved, and the target directory is
 * claimed exclusively so existing or concurrent state is never reused.
 * @param name - the new profile name.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, or the target directory exists.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      throw new Error(
        `${NAME}: profile ${JSON.stringify(name)} already exists at ${manifestPath}; `
        + 'omit --from-default-profile to use it',
      )
    }
    throw new Error(
      `${NAME}: profile directory ${dir} already exists; choose an unused profile name`,
    )
  }
  try {
    initProfile(dir, template.bundles)
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${NAME}: profile initialization failed and ${dir} could not be removed`,
      )
    }
    throw error
  }
}
/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns the loaded profile.
 * @throws when explicit initialization names an unknown template or an existing profile.
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  reportSkippedBundles(NAME, profile)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers, in application order. */
interface ComposedProfile {
  profile: Profile
  /** Immutable runtime resolution computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Command-line overlay contents, frozen for this invocation. */
  overlays: PatchOptions[]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template for a missing named profile.
 * @param resolvedProfile - application-owned profile and installation.
 * @returns the profile and its patch layers.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  const resolution = await createRuntimeResolution(resolutionOptions)
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  return { profile, resolution, overlays }
}

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
  /** Profile already loaded from the application's own directory. */
  profile: Profile
  /** Absolute package.json path of the application's dsh installation. */
  installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Loaded application profile; bypasses named profile initialization when supplied. */
  resolvedProfile?: ResolvedProfileRuntime | undefined
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package runtime, scoped to plugin package operations. */
  packageManager?: ProfileContext['packageManager']
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 * @throws after disposing startup resources; cleanup failures retain the original error.
 */
/**
 * Write a boot-stage trace synchronously.
 *
 * The desktop Host runs with stderr as a Windows pipe, where stream writes are
 * buffered; a native abort would drop the last buffered stage. The Windows 7
 * compatibility runtime additionally names a single trace file, which keeps the
 * stage order intact instead of leaving stages in a second, separately tailed
 * buffer.
 * @param stage - human-readable boot phase.
 */
function traceBootStage(stage: string): void {
  traceWin7Stage(`profile-boot: ${stage}`)
}

/** A loader tree's module-import and entry-update entry points. */
interface TreeImports {
  import(name: string, getOuterStack?: () => string[]): unknown
  update?(entries: unknown, ...rest: unknown[]): unknown
}

/**
 * Walk to the prototype that owns `import`.
 *
 * The Loader and the include's own tree share `EntryTree.prototype`, so patching
 * it once covers every entry import in the tree.
 * @param loader - The mounted Loader service.
 * @returns The owning prototype, or undefined when the shape is unexpected.
 */
function entryTreePrototype(loader: object): TreeImports | undefined {
  let proto: object | null = Object.getPrototypeOf(loader) as object | null
  while (proto !== null && proto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'import')
    if (descriptor !== undefined && typeof descriptor.value === 'function') return proto as TreeImports
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return undefined
}

/**
 * Trace every loader entry import, run them one at a time, and honour an entry
 * limit.
 *
 * The tree imports plugin modules through a dynamic `import()`, which is the
 * last phase between the mounted plugin packages and the first product module.
 * Every row is started in the same tick, so those imports run concurrently; on
 * the Windows 7 track that concurrency aborts the process natively with no
 * JavaScript stack, and serializing them keeps exactly one Node module load in
 * flight. `DSH_WIN7_MAX_ENTRIES` truncates the tree so a bisect can name the row
 * whose activation kills the process.
 * @param hostCtx - Root context the Loader is mounted on.
 */
function traceEntryImports(hostCtx: Context): void {
  const loader = hostCtx.get('loader')
  if (loader === undefined) {
    traceBootStage('prepare: no loader to trace')
    return
  }
  const owner = entryTreePrototype(loader)
  if (owner === undefined) {
    traceBootStage('prepare: entry tree import not found')
    return
  }
  const limit = entryLimit()
  const originalUpdate = owner.update
  if (typeof originalUpdate === 'function') {
    owner.update = function limitedUpdate(this: unknown, entries: unknown, ...rest: unknown[]): unknown {
      const selected = limit === undefined || !Array.isArray(entries) ? entries : entries.slice(0, limit)
      traceBootStage(`tree.update: ${Array.isArray(selected) ? String(selected.length) : 'n/a'} entries`)
      const result = (originalUpdate as (...args: unknown[]) => unknown).call(this, selected, ...rest)
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
        return (result as Promise<unknown>).then((value) => { traceBootStage('tree.update returned'); return value })
      }
      traceBootStage('tree.update returned')
      return result
    }
  }
  const original = owner.import
  let queue: Promise<unknown> = Promise.resolve()
  owner.import = function tracedImport(this: unknown, name: string, getOuterStack?: () => string[]): unknown {
    traceBootStage(`tree.import: ${name}`)
    const run = (): unknown => {
      traceBootStage(`tree.import run: ${name}`)
      return original.call(this, name, getOuterStack)
    }
    const result = queue.then(run, run)
    queue = result.then(() => undefined, () => undefined)
    if (typeof (result as PromiseLike<unknown> | undefined)?.then !== 'function') {
      traceBootStage(`tree.import sync: ${name}`)
      return result
    }
    return (result as Promise<unknown>).then(
      (value) => { traceBootStage(`tree.imported: ${name}`); return value },
      (error: unknown) => {
        traceBootStage(`tree.import failed: ${name}: ${String(error)}`)
        throw error
      },
    )
  }
  traceBootStage('prepare: entry imports traced')
}

/**
 * Entry count the tree is truncated to, when a bisect names one.
 * @returns the limit, or undefined to mount every entry.
 */
function entryLimit(): number | undefined {
  const raw = process.env.DSH_WIN7_MAX_ENTRIES
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  traceBootStage('entered')
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )
  traceBootStage('proxy installed')

  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const failures: unknown[] = []
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()
  try {
    const composed = await composeProfile(
      options.profile, options.patchFiles, options.fromDefaultProfile, options.resolvedProfile,
    )
    traceBootStage('profile composed')
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    // Signals own teardown throughout the startup window, not only after boot()
    // settles: an inserted provider can publish before sibling rows finish mounting.
    // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
    // surface — the launcher does not know whether the app considered its work
    // complete; SIGINT is a user interrupt and reports 130.
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })

    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      startedBundles: composed.profile.layers.map(layer => layer.packageName),
      cwd: process.cwd(), home: resolveDshHome(),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    traceBootStage('booting')
    const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => {
      traceBootStage('prepare: entered')
      app.current = hostCtx
      hostCtx.provide('profileContext', profileContext)
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable launch snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      traceBootStage('prepare: services provided')
      await hostCtx.plugin(PluginPackages, {
        resolution: composed.resolution,
      })
      traceBootStage('plugin-packages mounted')
      // The config tree mounts after this callback through the loader's internal
      // import; log each specifier so a native abort names the failing row.
      const loaderInternal = (hostCtx as unknown as {
        loader?: { internal?: { import?: (specifier: string, base?: string, attributes?: unknown) => unknown } }
      }).loader?.internal
      traceBootStage(`prepare: loader internal ${loaderInternal === undefined ? 'absent' : 'present'}`)
      if (loaderInternal !== undefined && typeof loaderInternal.import === 'function') {
        const originalImport = loaderInternal.import.bind(loaderInternal)
        loaderInternal.import = (specifier: string, base?: string, attributes?: unknown) => {
          traceBootStage(`import ${specifier}`)
          return originalImport(specifier, base, attributes)
        }
        traceBootStage('prepare: import traced')
      }
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      traceEntryImports(hostCtx)
      traceBootStage('prepare: provideCmdline enter')
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
        ready: appReady.service,
      })
      traceBootStage('prepare: provideCmdline returned')
      traceBootStage('prepare: returned')
    })
    app.current = ctx
    traceBootStage('booted')
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx, shutdown }
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
