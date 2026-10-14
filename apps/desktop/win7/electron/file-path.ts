/**
 * Filesystem path of a renderer `File`, across Electron generations.
 *
 * `webUtils.getPathForFile` arrived in Electron 29; Electron 22 exposes the
 * non-standard `File.path` augmentation that webUtils replaced. This module is
 * imported by the sandboxed application preload, so it must not use
 * `createRequire` or `import.meta` — the CJS preload bundle has neither.
 */

import * as electron from 'electron'

/** Electron surface the two generations differ on. */
interface ElectronWithWebUtils {
  readonly webUtils?: { getPathForFile?: (file: File) => string }
}

/**
 * Resolve the absolute path of a dropped or selected file.
 * @param file - File object received by the renderer.
 * @returns Absolute path, or an empty string when the runtime exposes neither API.
 */
export function pathForFile(file: File): string {
  const utils = (electron as unknown as ElectronWithWebUtils).webUtils
  if (typeof utils?.getPathForFile === 'function') return utils.getPathForFile(file)
  const legacy = (file as File & { path?: string }).path
  return typeof legacy === 'string' ? legacy : ''
}
