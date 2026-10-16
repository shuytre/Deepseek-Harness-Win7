/**
 * Copy the Windows 7 compatibility runtime beside `primary-runtime`.
 *
 * The files land in `resources/runtime/win7-compat/`, outside ASAR, because a
 * Node loader and a `--require` preload must exist as real files on disk before
 * the Host process starts. Keeping them out of `app.asar.unpacked/dsh` also
 * keeps them clear of the signed runtime file policy.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
/** Directory name of the compatibility runtime; kept in sync with win7/profile.mjs. */
const WIN7_PROFILE_ENV = 'DSH_TARGET_WIN7'
const WIN7_COMPAT_DIRECTORY = 'win7-compat'

const COMPAT_SOURCE = resolve(import.meta.dirname, '..', '..', 'win7', 'compat')

/** A file the Host process must be able to require or load. */
export interface Win7CompatInstallation {
  readonly directory: string
  readonly polyfills: string
  readonly loader: string
}

/**
 * Install the compatibility runtime for one Desktop resources directory.
 * @param runtimeDirectory - Desktop runtime directory that receives `win7-compat/`.
 * @param env - Packaging environment selecting the track.
 * @returns Installed paths, or undefined on the ordinary track.
 */
export function installWin7CompatRuntime(
  runtimeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Win7CompatInstallation | undefined {
  // The track switch is read directly here: this module also runs from build
  // scripts, where importing the profile module would put a .mjs reference
  // inside the compiled declaration output.
  if (env[WIN7_PROFILE_ENV] !== '1') return undefined
  if (!existsSync(COMPAT_SOURCE)) throw new Error(`win7 compat: source directory is missing at ${COMPAT_SOURCE}`)
  const directory = join(runtimeDirectory, WIN7_COMPAT_DIRECTORY)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  cpSync(COMPAT_SOURCE, directory, { recursive: true })
  const installation = {
    directory,
    polyfills: join(directory, 'polyfills.cjs'),
    loader: join(directory, 'loader.mjs'),
  }
  writeFileSync(join(directory, 'installation.json'), `${JSON.stringify({
    schemaVersion: 1,
    polyfills: 'polyfills.cjs',
    loader: 'loader.mjs',
    shims: ['shims/node-sqlite.mjs', 'shims/node-sea.mjs'],
  }, undefined, 2)}\n`)
  return installation
}

/**
 * Resolve the installed compatibility runtime for a running application.
 * @param resourcesDirectory - `process.resourcesPath` of the running application.
 * @returns Absolute paths, or undefined when the track is not installed.
 */
export function resolveInstalledWin7Compat(resourcesDirectory: string): Win7CompatInstallation | undefined {
  const directory = join(resourcesDirectory, 'runtime', WIN7_COMPAT_DIRECTORY)
  if (!existsSync(join(directory, 'polyfills.cjs'))) return undefined
  return {
    directory,
    polyfills: join(directory, 'polyfills.cjs'),
    loader: join(directory, 'loader.mjs'),
  }
}
