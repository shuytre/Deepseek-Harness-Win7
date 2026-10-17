import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { transform } from 'lightningcss'
import { expandModernColors, readThemeTokens } from './expand-modern-colors.mjs'

/**
 * The Windows 7 track rewrites modern color functions before lightningcss runs,
 * so a regression here breaks the whole client build on Chromium 108. The sharp
 * edges: lightningcss deletes a preceding same-property fallback (for color
 * properties and custom properties alike), keyframe selectors cannot carry the
 * dark-theme prefix, and one file may define the same custom property for both
 * themes.
 */
const themeStyleDirectory = resolve(import.meta.dirname, '../../packages/client/ui-theme/src/styles/')
const tokens = readThemeTokens(themeStyleDirectory)
const win7Targets = { chrome: 108 << 16 }

/** Expand one stylesheet and compile it the way the client build does. */
function compileWin7(css: string, cssModule: boolean) {
  const expanded = expandModernColors(css, { tokens, file: 'spec.module.css', cssModule })
  const result = transform({
    filename: 'spec.module.css',
    code: Buffer.from(expanded.css, 'utf8'),
    minify: true,
    ...(cssModule ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
    targets: win7Targets,
  })
  return { expanded, code: result.code.toString() }
}

const labelMix = 'color-mix(in srgb, var(--dsw-alias-label-secondary) 60%, var(--dsw-alias-label-tertiary))'

describe('win7 expandModernColors', () => {
  it('replaces the authored value with the literal Chromium 108 needs', () => {
    const { expanded, code } = compileWin7(`.card { color: ${labelMix}; }`, true)
    // No fallback pair: lightningcss would fold it away and leave color-mix() alone.
    expect(expanded.css).not.toContain('color-mix(')
    expect(expanded.css).toMatch(/\.card\{color: #[0-9a-f]{6};?\}/)
    expect(expanded.unresolved).toEqual([])
    // The compiled output carries the literal through.
    expect(code).toMatch(/color:\s*#[0-9a-f]{3,8}/)
    expect(code).not.toContain('color-mix(')
  })

  it('keeps the dark value reachable through the theme override', () => {
    const { expanded } = compileWin7(`.card { color: ${labelMix}; }`, true)
    expect(expanded.css).toContain(':global(body[data-ds-dark-theme]) .card{')
    // The override holds the dark literal, not the light one.
    const override = /:global\(body\[data-ds-dark-theme\]\) \.card\{color: (#[0-9a-f]{6});?\}/u.exec(expanded.css)
    expect(override).not.toBeNull()
    const base = /\.card\{color: (#[0-9a-f]{6});?\}/u.exec(expanded.css)
    expect(override?.[1]).not.toBe(base?.[1])
  })

  it('emits the plain dark-theme scope outside CSS modules', () => {
    const { expanded } = compileWin7(`.card { color: ${labelMix}; }`, false)
    expect(expanded.css).toContain('body[data-ds-dark-theme] .card{')
    expect(expanded.css).not.toContain(':global(')
  })

  it('expands a dark-scoped rule with the dark tokens and adds no override', () => {
    const { expanded } = compileWin7(
      `body[data-ds-dark-theme] { --tip: color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%); }`,
      true,
    )
    expect(expanded.css).not.toContain('color-mix(')
    // The theme's own dark tooltip background (bluishish-750) mixes with white,
    // so the literal is lighter than either operand - never the light bluishish-850.
    expect(expanded.css).toMatch(/--tip: (?:#|rgba?\()/u)
    // No self-prefixed dead rule is appended.
    expect(expanded.css).not.toContain('body[data-ds-dark-theme] body[data-ds-dark-theme]')
  })

  it('keeps light and dark definitions of one custom property apart', () => {
    const { expanded } = compileWin7(
      [
        'body { --a: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent); --b: color-mix(in srgb, var(--a), white 10%); }',
        'body[data-ds-dark-theme] { --a: color-mix(in srgb, var(--dsw-static-blue-300) 40%, transparent); --b: color-mix(in srgb, var(--a), white 10%); }',
      ].join('\n'),
      false,
    )
    const lightA = /--a:\s*(rgba?\([^)]*\));\s*--b/u.exec(expanded.css)
    const darkA = /body\[data-ds-dark-theme\]\s*\{--a:\s*(rgba?\([^)]*\));\s*--b/u.exec(expanded.css)
    expect(lightA).not.toBeNull()
    expect(darkA).not.toBeNull()
    expect(lightA?.[1]).not.toBe(darkA?.[1])
    // The chained --b resolves through each scope's own --a, so the two differ too.
    const lightB = /--b:\s*(rgba?\([^)]*\));/u.exec(expanded.css.slice(0, expanded.css.indexOf('body[data-ds-dark-theme]')))
    const darkB = /body\[data-ds-dark-theme\]\s*\{--a:\s*rgba?\([^)]*\);\s*--b:\s*(rgba?\([^)]*\));/u.exec(expanded.css)
    expect(lightB?.[1]).not.toBe(darkB?.[1])
  })

  it('never prefixes a keyframe selector with the dark-theme scope', () => {
    const { expanded, code } = compileWin7(
      [
        '@keyframes ring {',
        '  0%,',
        '  55% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent); }',
        '  to { box-shadow: 0 0 0 0 transparent; }',
        '}',
        '.card[data-plugin-highlight] { animation: ring 1.2s ease-out; }',
      ].join('\n'),
      true,
    )
    // The keyframe rule keeps its literal in place, inside @keyframes.
    expect(expanded.css).toMatch(/@keyframes ring\s*\{\s*0%,\s*55%\{box-shadow: 0 0 0 2px rgba\(/)
    expect(expanded.css).not.toContain('color-mix(')
    // Every dark-theme override targets a style selector, never a keyframe selector.
    for (const line of expanded.css.split('\n')) {
      if (line.includes('data-ds-dark-theme')) {
        expect(line).not.toMatch(/data-ds-dark-theme\]\)\s*(?:\d+%|from|to)/)
        expect(line).not.toMatch(/\d+%\{/)
      }
    }
    expect(code).not.toContain('color-mix(')
  })

  it('emits no override for selectors the theme prefix cannot contain', () => {
    const { expanded } = compileWin7(`:root { --tint: ${labelMix}; }`, true)
    // `body[data-ds-dark-theme] :root` can never match; the source file owns its
    // dark value (a media query or its own dark block), as on the Win10 track.
    expect(expanded.css).not.toContain('data-ds-dark-theme')
    expect(expanded.css).toContain('--tint: #')
  })

  it('reports values it cannot resolve instead of dropping them', () => {
    const { expanded } = compileWin7('.card { color: color-mix(in srgb, var(--not-a-token) 60%, transparent); }', true)
    expect(expanded.unresolved).toHaveLength(1)
    expect(expanded.unresolved[0]).toMatchObject({ property: 'color' })
    // The authored declaration survives verbatim for the ordinary track.
    expect(expanded.css).toContain('color: color-mix(in srgb, var(--not-a-token) 60%, transparent)')
  })

  it('resolves light-dark() to each theme literal', () => {
    const { expanded } = compileWin7('.card { color: light-dark(var(--dsw-alias-label-secondary), var(--dsw-alias-label-secondary)); }', true)
    expect(expanded.css).not.toContain('light-dark(')
    expect(expanded.css).toMatch(/\.card\{color: #[0-9a-f]{6};?\}/)
    expect(expanded.unresolved).toEqual([])
  })

  it('leaves a stylesheet without modern color functions untouched', () => {
    const css = '.card { color: red; /* keeps its comment */ }'
    const { expanded } = compileWin7(css, true)
    expect(expanded.css).toBe(css)
    expect(expanded.unresolved).toEqual([])
  })

  it('expands nested rules inside at-rule wrappers', () => {
    const { expanded } = compileWin7('@media (width >= 600px) { .card { color: color-mix(in srgb, var(--dsw-alias-label-secondary) 60%, transparent); } }', true)
    expect(expanded.css).toContain('@media (width >= 600px)')
    expect(expanded.css).not.toContain('color-mix(')
    expect(expanded.unresolved).toEqual([])
  })

  it('compiles the plugin manager page, the stylesheet that surfaced the keyframe case', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css'),
      'utf8',
    )
    const { expanded } = compileWin7(source, true)
    expect(expanded.unresolved).toEqual([])
    expect(expanded.css).toContain('@keyframes dsh-plugin-highlight')
    for (const line of expanded.css.split('\n')) {
      if (line.includes('data-ds-dark-theme')) expect(line).not.toMatch(/\d+%\{/)
    }
  })
})
