/** Build-time expansion of `color-mix()` and `light-dark()` for Chromium 108. */

/** Parsed custom properties for one theme. */
export interface ThemeTokens {
  readonly light: ReadonlyMap<string, string>
  readonly dark: ReadonlyMap<string, string>
}

/** One property whose modern color function could not be resolved. */
export interface UnresolvedColor {
  readonly file: string
  readonly property: string
  readonly value: string
}

/**
 * Collect `--token: value` declarations for `:root` (light) and the dark theme.
 * @param themeStyleDirectory - Directory holding the theme stylesheets.
 * @returns Token maps for both themes.
 */
export declare function readThemeTokens(themeStyleDirectory: string): ThemeTokens

/**
 * Expand modern color functions in one stylesheet.
 * @param input - Stylesheet source, selector names still local.
 * @param options - Token maps, file name for reporting, and CSS-modules flag.
 * @returns Rewritten CSS plus every value that stayed verbatim.
 */
export declare function expandModernColors(
  input: string,
  options: { readonly tokens: ThemeTokens, readonly file: string, readonly cssModule: boolean },
): { css: string, unresolved: readonly UnresolvedColor[] }
