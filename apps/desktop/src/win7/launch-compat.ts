/**
 * Node CLI flags and environment a Windows 7 child process needs.
 *
 * The Host and the CLI launcher both run the dsh entry under Node 16, which
 * lacks `node:sqlite` and `node:sea` and cannot answer `Promise.withResolvers`.
 * The flags are added only when the compatibility runtime exists on disk, so
 * the Win10 track passes identical arguments to today's build.
 */

import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
/** Directory name of the compatibility runtime; kept in sync with win7/profile.mjs. */
const WIN7_COMPAT_DIRECTORY = 'win7-compat'

/** Compatibility runtime location for one primary-runtime path. */
export interface Win7ChildCompat {
  readonly directory: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
}

/**
 * Resolve the compatibility runtime that sits beside `primary-runtime`.
 * @param primaryRuntime - Absolute primary-runtime directory.
 * @returns Installed compatibility runtime, or undefined on the ordinary track.
 */
export function resolveChildWin7Compat(primaryRuntime: string): Win7ChildCompat | undefined {
  const directory = join(dirname(primaryRuntime), WIN7_COMPAT_DIRECTORY)
  if (!existsSync(join(directory, 'polyfills.cjs'))) return undefined
  return {
    directory,
    args: [
      '--require', join(directory, 'polyfills.cjs'),
      '--experimental-loader', pathToFileURL(join(directory, 'loader.mjs')).href,
      // A native abort on Node 16 leaves no JavaScript stack in stderr; the
      // report carries the JavaScript/native stack that names the crash site.
      '--report-on-fatalerror',
      '--report-directory', directory,
    ],
    environment: {
      DSH_WIN7_COMPAT_DIR: directory,
      DSH_WIN7_MODULE_ROOTS: '',
      DSH_WIN7_TRACE_REQUIRE: '1',
      // One ordered trace across the preload, the loader thread and the product
      // modules: the Host's stderr is a separately buffered Windows pipe that a
      // native abort truncates.
      DSH_WIN7_TRACE_FILE: join(directory, 'win7-trace.log'),
    },
  }
}

/**
 * Declare the module roots a shim resolves its drivers from.
 * @param roots - Directories whose `node_modules` may hold a driver.
 * @returns Environment entries for the child process.
 */
export function win7ModuleRootEnvironment(roots: readonly string[]): Record<string, string> {
  return { DSH_WIN7_MODULE_ROOTS: roots.join(delimiter) }
}
