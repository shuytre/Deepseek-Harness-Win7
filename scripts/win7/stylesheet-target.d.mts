/** Windows 7 stylesheet target and token source for the client build. */

import type { ThemeTokens } from './expand-modern-colors.mjs'

/** Chromium version Electron 22 ships. */
export declare const WIN7_CHROME_TARGET: number

/** lightningcss target descriptor for Chromium 108. */
export declare function win7LightningTargets(): { chrome: number }

/** Theme stylesheet directory the token resolver reads. */
export declare const THEME_STYLE_DIRECTORY: string

/** Load `:root` (light) and dark-theme custom properties once per build. */
export declare function win7ThemeTokens(): ThemeTokens

/** Whether the current build targets the Windows 7 track. */
export declare function win7BuildEnabled(env?: NodeJS.ProcessEnv): boolean
