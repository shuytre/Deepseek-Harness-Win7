/**
 * Build-time expansion of `color-mix()` and `light-dark()` for Chromium 108.
 *
 * The Win10 track renders on Chromium 111+ and gets these functions for free.
 * Chromium 108 drops both declarations, which would erase backgrounds and
 * borders on 25 module stylesheets - so they are resolved here into literal
 * colors instead of editing the component CSS.
 *
 * Rules:
 *   - Only declarations that contain `color-mix(` or `light-dark(` are touched.
 *   - A mix is expanded only when every operand resolves to a literal color
 *     (a token defined in the theme stylesheets, a hex/rgb literal, or
 *     `transparent`). Anything else is left verbatim and reported, so a human
 *     sees the exact declaration that still needs attention.
 *   - The original declaration stays in place, so modern engines keep the
 *     authored value and only Chromium 108 consumes the emitted fallback.
 *   - A dark-theme override is emitted only when the dark value differs, using
 *     the repository's established `:global(body[data-ds-dark-theme])` form.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const NAMED = new Map([
  ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
  ['white', { r: 255, g: 255, b: 255, a: 1 }],
  ['black', { r: 0, g: 0, b: 0, a: 1 }],
])

/**
 * Collect `--token: value` declarations for `:root` (light) and the dark theme.
 * @param {string} themeStyleDirectory - Directory holding the theme stylesheets.
 * @returns {{ light: Map<string, string>, dark: Map<string, string> }} Token maps for both themes.
 */
export function readThemeTokens(themeStyleDirectory) {
  const light = new Map()
  const dark = new Map()
  for (const file of readdirSync(themeStyleDirectory).filter(name => name.endsWith('.css'))) {
    const css = readFileSync(join(themeStyleDirectory, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const rule of splitRules(css)) {
      // The theme defines light values on `:root` and on a bare `body` rule, and
      // dark values on `body[data-ds-dark-theme]`.
      const isDark = rule.selector.includes('data-ds-dark-theme')
      const isLight = !isDark && (rule.selector.includes(':root') || /(?:^|\s)body$|\bbody\s*,|\bbody\s*\{/u.test(rule.selector + '{'))
      const target = isDark ? dark : isLight ? light : undefined
      if (target === undefined) continue
      for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/giu)) {
        if (match[1] !== undefined && match[2] !== undefined) target.set(match[1], match[2].trim())
      }
    }
  }
  for (const [name, value] of light) if (!dark.has(name)) dark.set(name, value)
  return { light, dark }
}

/**
 * Split a stylesheet into `selector { body }` pairs, ignoring comments.
 * @param {string} css - Stylesheet text.
 * @returns {Array<{ selector: string, body: string }>} Top-level rules.
 */
function splitRules(css) {
  const rules = []
  collectRules(css, rules)
  return rules
}

/**
 * Collect every style rule, descending into at-rule blocks.
 *
 * Declarations nested in `@media`, `@supports` or `@layer` must expand too, so
 * the at-rule wrapper is skipped and its children are collected in place.
 * @param {string} css - Text to scan.
 * @param {Array<{ selector: string, body: string }>} rules - Accumulator.
 */
function collectRules(css, rules) {
  let depth = 0
  let start = 0
  let selectorEnd = -1
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]
    if (character === '{') {
      if (depth === 0) selectorEnd = index
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0 && selectorEnd >= 0) {
        const selector = css.slice(start, selectorEnd).trim()
        const body = css.slice(selectorEnd + 1, index)
        if (selector.startsWith('@')) collectRules(body, rules)
        else rules.push({ selector, body })
        start = index + 1
        selectorEnd = -1
      }
    }
  }
}

/**
 * Resolve one color operand to RGBA.
 * @param {string} value - Authored color operand.
 * @param {Map<string, string>} tokens - Token map for the active theme.
 * @param {number} depth - Recursion guard for nested `var()` chains.
 * @returns {{ r: number, g: number, b: number, a: number } | undefined} Literal color.
 */
function resolveColor(value, tokens, depth = 0) {
  const text = value.trim()
  if (depth > 8) return undefined
  const named = NAMED.get(text.toLowerCase())
  if (named !== undefined) return named
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(text)
  if (hex !== null) return parseHex(hex[1])
  const functional = /^rgba?\(([\s\S]+)\)$/iu.exec(text)
  if (functional !== null) return parseFunctional(functional[1])
  if (/^color-mix\(/iu.test(text)) return evaluateMix(text, tokens, depth + 1)
  if (/^var\(/iu.test(text)) {
    const inner = balancedInner(text, 'var')
    if (inner === undefined) return undefined
    // `var(--name, fallback)` — the name may itself be a var fallback chain.
    const parts = splitTopLevel(inner)
    const name = parts[0]?.trim()
    if (name !== undefined && tokens.has(name)) return resolveColor(tokens.get(name) ?? '', tokens, depth + 1)
    if (parts.length > 1) return resolveColor(parts.slice(1).join(','), tokens, depth + 1)
  }
  return undefined
}

/**
 * Read the contents of one balanced `name(...)` call.
 * @param {string} text - Text starting with `name(`.
 * @param {string} name - Function name.
 * @returns {string | undefined} Inner text, or undefined when unbalanced.
 */
function balancedInner(text, name) {
  if (!text.toLowerCase().startsWith(`${name}(`)) return undefined
  let depth = 0
  for (let index = name.length; index < text.length; index += 1) {
    const character = text[index]
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return text.slice(name.length + 1, index)
    }
  }
  return undefined
}

/**
 * Split a value on commas that are not nested inside parentheses.
 * @param {string} text - Value text.
 * @returns {string[]} Top-level segments.
 */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * Parse a hex color with 3, 4, 6 or 8 digits.
 * @param {string} digits - Hex digits without `#`.
 * @returns {{ r: number, g: number, b: number, a: number } | undefined} Literal color.
 */
function parseHex(digits) {
  const expand = value => parseInt(value.length === 1 ? value + value : value, 16)
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]),
      a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
    }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
  }
  return undefined
}

/**
 * Parse an `rgb()`/`rgba()` argument list.
 * @param {string} argumentsList - Text between the parentheses.
 * @returns {{ r: number, g: number, b: number, a: number } | undefined} Literal color.
 */
function parseFunctional(argumentsList) {
  // Support both `rgb(r, g, b)` and the space-separated `rgb(r g b / a%)` form.
  const [colorPart, alphaPart] = argumentsList.split('/')
  const parts = (colorPart ?? '').split(/[,\s]+/u).map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length < 3) return undefined
  const channel = (text) => {
    if (text === undefined) return undefined
    const value = text.endsWith('%') ? Number.parseFloat(text) * 2.55 : Number.parseFloat(text)
    return Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : undefined
  }
  const red = channel(parts[0])
  const green = channel(parts[1])
  const blue = channel(parts[2])
  if (red === undefined || green === undefined || blue === undefined) return undefined
  const alphaText = alphaPart ?? parts[3]
  const alpha = alphaText === undefined ? 1 : Number.parseFloat(alphaText) / (alphaText.trim().endsWith('%') ? 100 : 1)
  return { r: red, g: green, b: blue, a: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1 }
}

/**
 * Format an RGBA color the way the authored CSS does.
 * @param {{ r: number, g: number, b: number, a: number }} color - Literal color.
 * @returns {string} Hex with alpha, or `rgba()` when translucent.
 */
function formatColor(color) {
  const alpha = Math.round(color.a * 1000) / 1000
  const hex = `#${[color.r, color.g, color.b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
  return alpha >= 1 ? hex : `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`
}

/**
 * Blend two colors in sRGB with the CSS `color-mix` weighting model.
 * @param {{ r: number, g: number, b: number, a: number }} first - First color.
 * @param {{ r: number, g: number, b: number, a: number }} second - Second color.
 * @param {number} firstWeight - Weight of the first color, 0 to 1.
 * @returns {{ r: number, g: number, b: number, a: number }} Blended color.
 */
function mix(first, second, firstWeight) {
  const secondWeight = 1 - firstWeight
  return {
    r: first.r * firstWeight + second.r * secondWeight,
    g: first.g * firstWeight + second.g * secondWeight,
    b: first.b * firstWeight + second.b * secondWeight,
    a: first.a * firstWeight + second.a * secondWeight,
  }
}

/**
 * Evaluate one `color-mix()` call against a token map.
 * @param {string} call - Full `color-mix(...)` text.
 * @param {Map<string, string>} tokens - Token map for the active theme.
 * @returns {{ r: number, g: number, b: number, a: number } | undefined} Literal color.
 */
function evaluateMix(call, tokens, depth = 0) {
  const inner = balancedInner(call, 'color-mix')
  if (inner === undefined) return undefined
  // Operands nest (`var(--a, var(--b))`, or another color-mix), so only
  // top-level commas separate them.
  const segments = splitTopLevel(inner)
  if (segments.length < 3) return undefined
  if (!/^\s*in\s+srgb\s*$/iu.test(segments[0] ?? '')) return undefined
  const operands = segments.slice(1, 3).map((segment) => {
    const weight = /([\d.]+)%\s*$/u.exec(segment.trim())
    const colorText = weight === null ? segment.trim() : segment.trim().slice(0, weight.index).trim()
    return { color: colorText, weight: weight === null ? undefined : Number.parseFloat(weight[1]) / 100 }
  })
  const first = resolveColor(operands[0].color, tokens, depth + 1)
  const second = resolveColor(operands[1].color, tokens, depth + 1)
  if (first === undefined || second === undefined) return undefined
  const firstWeight = operands[0].weight ?? (operands[1].weight === undefined ? 0.5 : 1 - operands[1].weight)
  return mix(first, second, firstWeight)
}

/**
 * Replace every balanced `name(...)` call in a value.
 *
 * A regular expression cannot count parentheses, and these values nest
 * `var(--a, var(--b))` inside a mix. The scanner walks the text and hands each
 * complete call - arguments included - to the replacer.
 * @param {string} text - Declaration value.
 * @param {string} name - Function name without parentheses.
 * @param {(call: string) => string} replacer - Producer for each matched call.
 * @returns {string} Rewritten value.
 */
function replaceFunctionCalls(text, name, replacer) {
  let output = ''
  let index = 0
  const needle = `${name}(`
  while (index < text.length) {
    const start = text.toLowerCase().indexOf(needle, index)
    if (start < 0) {
      output += text.slice(index)
      break
    }
    output += text.slice(index, start)
    let depth = 0
    let end = -1
    for (let cursor = start + name.length; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    if (end < 0) {
      output += text.slice(start)
      break
    }
    output += replacer(text.slice(start, end + 1))
    index = end + 1
  }
  return output
}

/**
 * Replace every resolvable modern color function inside one value with its light literal.
 * @param {string} value - Declaration value.
 * @param {Map<string, string>} tokens - Light theme tokens.
 * @returns {string | undefined} Rewritten value, or undefined when nothing resolved.
 */
function expandValue(value, tokens) {
  let changed = false
  let expanded = replaceFunctionCalls(value, 'color-mix', (call) => {
    const color = evaluateMix(call, tokens)
    if (color === undefined) return call
    changed = true
    return formatColor(color)
  })
  expanded = replaceFunctionCalls(expanded, 'light-dark', (call) => {
    const [lightValue] = splitTopLevel(balancedInner(call, 'light-dark') ?? '')
    const color = resolveColor(lightValue ?? '', tokens)
    changed = true
    return color === undefined ? (lightValue ?? call).trim() : formatColor(color)
  })
  return changed ? expanded : undefined
}

/**
 * Replace every resolvable modern color function inside one value with its dark literal.
 * @param {string} value - Declaration value.
 * @param {Map<string, string>} tokens - Dark theme tokens.
 * @returns {string | undefined} Rewritten value, or undefined when nothing resolved.
 */
function expandDarkValue(value, tokens) {
  let changed = false
  let expanded = replaceFunctionCalls(value, 'color-mix', (call) => {
    const color = evaluateMix(call, tokens)
    if (color === undefined) return call
    changed = true
    return formatColor(color)
  })
  expanded = replaceFunctionCalls(expanded, 'light-dark', (call) => {
    const parts = splitTopLevel(balancedInner(call, 'light-dark') ?? '')
    const darkValue = parts[1]
    const color = resolveColor(darkValue ?? '', tokens)
    changed = true
    return color === undefined ? (darkValue ?? call).trim() : formatColor(color)
  })
  return changed ? expanded : undefined
}

/**
 * Expand modern color functions in one stylesheet.
 * @param {string} input - Stylesheet source, selector names still local.
 * @param {{ tokens: { light: Map<string, string>, dark: Map<string, string> }, file: string, cssModule: boolean }} options - Token maps, file name for reporting, and CSS-modules flag.
 * @returns {{ css: string, unresolved: Array<{ file: string, property: string, value: string }> }} Rewritten CSS plus every value that stayed verbatim.
 */
export function expandModernColors(input, options) {
  const unresolved = []
  const darkRules = []
  let changed = false
  // Comments are stripped first so every rule body is a contiguous slice of the
  // text this function searches; lightningcss minifies the output anyway.
  const source = input.replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules = splitRules(source)
  if (rules.length === 0) return { css: input, unresolved }
  let output = source
  // Custom properties a stylesheet defines for itself (a computed token that is
  // itself a color-mix) join the theme tokens for this file.
  const localTokens = new Map()
  for (const rule of rules) {
    for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/giu)) {
      if (match[1] !== undefined && match[2] !== undefined) localTokens.set(match[1], match[2].trim())
    }
  }
  const tokens = localTokens.size === 0 ? options.tokens : {
    light: new Map([...options.tokens.light, ...localTokens]),
    dark: new Map([...options.tokens.dark, ...localTokens]),
  }
  for (const rule of rules) {
    if (!/color-mix\(|light-dark\(/iu.test(rule.body)) continue
    const declarations = []
    const darkDeclarations = []
    for (const declaration of rule.body.split(';')) {
      const trimmed = declaration.trim()
      if (trimmed.length === 0) continue
      const separator = trimmed.indexOf(':')
      if (separator < 0) continue
      const property = trimmed.slice(0, separator).trim()
      const value = trimmed.slice(separator + 1).trim()
      if (!/color-mix\(|light-dark\(/iu.test(value)) {
        // Unrelated declarations are preserved verbatim.
        declarations.push(`${property}: ${value}`)
        continue
      }
      const light = expandValue(value, tokens.light)
      const dark = expandDarkValue(value, tokens.dark)
      if (light === undefined) {
        unresolved.push({ file: options.file, property, value })
        declarations.push(`${property}: ${value}`)
        continue
      }
      declarations.push(`${property}: ${light}`)
      if (dark !== undefined && dark !== light) darkDeclarations.push(`${property}: ${dark}`)
      declarations.push(`${property}: ${value}`)
      changed = true
    }
    const replacement = `${rule.selector}{${declarations.join(';')};}`
    const search = new RegExp(`${escapeRegExp(rule.selector)}\\s*\\{${escapeRegExp(rule.body)}\\}`, 'u')
    if (!search.test(output)) {
      // Offsets only diverge when the selector repeats across the file; report instead of guessing.
      for (const declaration of declarations) {
        if (declaration.includes('color-mix(') || declaration.includes('light-dark(')) {
          unresolved.push({ file: options.file, property: declaration.split(':')[0]?.trim() ?? '', value: declaration })
        }
      }
      continue
    }
    output = output.replace(search, () => replacement)
    if (darkDeclarations.length > 0) {
      const prefix = options.cssModule
        ? `:global(body[data-ds-dark-theme]) ${rule.selector}`
        : `body[data-ds-dark-theme] ${rule.selector}`
      darkRules.push(`${prefix}{${darkDeclarations.join(';')};}`)
    }
  }
  if (!changed) return { css: input, unresolved }
  return { css: darkRules.length === 0 ? output : `${output}\n${darkRules.join('\n')}\n`, unresolved }
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param {string} value - Literal text.
 * @returns {string} Escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
