/**
 * Windows 7 stylesheet target and token source for the client build.
 *
 * Electron 22 renders the client bundle on Chromium 108, which predates
 * `color-mix()` (111), `light-dark()` (123), `@scope` (118), `field-sizing`
 * (123) and `scrollbar-color` (121). Two levers keep the authored UI intact:
 *   1. lightningcss lowers what it can when given `chrome 108` as the target;
 *   2. `expand-modern-colors.mjs` resolves the rest against the theme tokens
 *      before lightningcss runs.
 */

import { fileURLToPath } from 'node:url'
import { readThemeTokens } from './expand-modern-colors.mjs'

/** Chromium version Electron 22 ships. */
export const WIN7_CHROME_TARGET = 108

/** lightningcss target descriptor for Chromium 108. */
export function win7LightningTargets() {
  return { chrome: WIN7_CHROME_TARGET << 16 }
}

/** Theme stylesheet directory the token resolver reads. */
export const THEME_STYLE_DIRECTORY = fileURLToPath(
  new URL('../../packages/client/ui-theme/src/styles/', import.meta.url),
)

/** Cached token maps; the stylesheets do not change during one build. */
let cachedTokens

/** Load `:root` (light) and dark-theme custom properties once per build. */
export function win7ThemeTokens() {
  cachedTokens ??= readThemeTokens(THEME_STYLE_DIRECTORY)
  return cachedTokens
}

/** Whether the current build targets the Windows 7 track. */
export function win7BuildEnabled(env = process.env) {
  return env.DSH_TARGET_WIN7 === '1'
}
