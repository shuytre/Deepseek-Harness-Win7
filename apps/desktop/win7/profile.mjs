/** The Windows 7 SP1 x64 compatibility profile of the Desktop shell. */

/** Environment switch selecting the Windows 7 track for every Desktop build step. */
export const WIN7_PROFILE_ENV = 'DSH_TARGET_WIN7'

/** Electron release carrying Chromium 108 and Node 16.17.1 - the last with Windows 7 support. */
export const WIN7_ELECTRON_VERSION = '22.3.27'

/** Standalone Node shipped inside primary-runtime; last 16.x line. */
export const WIN7_NODE_VERSION = '16.20.2'

/** CPython release with official Windows 7 SP1 support. */
export const WIN7_PYTHON_VERSION = '3.8.10'

/** Directory name of the compatibility runtime copied beside primary-runtime. */
export const WIN7_COMPAT_DIRECTORY = 'win7-compat'

/** Suffix appended to Windows 7 artifacts so a shared feed can never mix the tracks. */
export const WIN7_ARTIFACT_SUFFIX = '-win7'

/**
 * Resolve the Windows 7 profile from a packaging environment.
 * @param env - Packaging environment.
 * @returns Resolved profile; `enabled` is false for the ordinary track.
 */
export function win7Profile(env = process.env) {
  const raw = env[WIN7_PROFILE_ENV]
  if (raw !== undefined && raw !== '0' && raw !== '1') {
    throw new Error(`${WIN7_PROFILE_ENV} must be 0 or 1`)
  }
  return {
    enabled: raw === '1',
    electronVersion: WIN7_ELECTRON_VERSION,
    nodeVersion: WIN7_NODE_VERSION,
    pythonVersion: WIN7_PYTHON_VERSION,
    buildHostNodeMajor: 22,
  }
}
