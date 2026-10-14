/** The Windows 7 SP1 x64 compatibility profile of the Desktop shell. */

export declare const WIN7_PROFILE_ENV: 'DSH_TARGET_WIN7'
export declare const WIN7_ELECTRON_VERSION: string
export declare const WIN7_NODE_VERSION: string
export declare const WIN7_PYTHON_VERSION: string
export declare const WIN7_COMPAT_DIRECTORY: string
export declare const WIN7_ARTIFACT_SUFFIX: string

/** Whether the current environment builds the Windows 7 track. */
export interface Win7Profile {
  readonly enabled: boolean
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly pythonVersion: string
  /** Build host Node major required by the toolchain, independent of the target runtime. */
  readonly buildHostNodeMajor: number
}

/**
 * Resolve the Windows 7 profile from a packaging environment.
 * @param env - Packaging environment.
 * @returns Resolved profile; `enabled` is false for the ordinary track.
 */
export declare function win7Profile(env?: NodeJS.ProcessEnv): Win7Profile
