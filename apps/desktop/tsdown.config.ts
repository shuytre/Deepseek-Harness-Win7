import { defineConfig } from 'tsdown'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { repositoryClientBuildEnvironment, resolveClientBuildEnvironment } from '../../scripts/client-build-environment.ts'
import { packagedImportsPlugin } from './scripts/desktop-bundle-imports.mjs'
import { win7Profile } from './win7/profile.mjs'

// This config runs after the workspace tsdown pass, not inside it: the main bundle inlines
// workspace devDependencies from their lib/ output, which the concurrent workspace pass does
// not order ahead of this package (root package.json build:lib:host).
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}
/** electron-builder ships the manifest `dependencies` next to the main bundle; Electron provides `electron` and Node. */
const mainProcessImports = { packages: new Set(['electron', ...Object.keys(manifest.dependencies)]), nodeBuiltins: true }
/**
 * The `require` polyfill of a sandboxed preload resolves only these modules
 * (Electron: Process Sandboxing, "Preload scripts").
 */
const preloadImports = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Use the client environment this build already received, otherwise the repository's own version and commit. */
const clientEnvironment = resolveClientBuildEnvironment(process.env.DSH_CLIENT_VERSION === undefined
  ? repositoryClientBuildEnvironment(REPOSITORY_ROOT, process.env)
  : process.env)
const clientVersion = clientEnvironment.DSH_CLIENT_VERSION
if (clientVersion === undefined) throw new Error('desktop build: the client environment carries no DSH_CLIENT_VERSION')

/** Inline the one public build value the Node entry reads; every other variable stays a runtime lookup. */
const clientVersionDefine = { 'process.env.DSH_CLIENT_VERSION': JSON.stringify(clientVersion) }

/**
 * Syntax target per track. Electron 22's Node 16 / Chromium 108 cannot parse
 * ES2024 output, so the Windows 7 track downlevels to ES2022.
 */
const SYNTAX_TARGET = process.env.DSH_TARGET_WIN7 === '1' ? 'es2022' : 'es2024'

/** The track this build belongs to; the Windows 7 track ships Electron 22. */
const win7 = win7Profile(process.env)

export default defineConfig([
  {
    entry: ['lib/types/command-manager-entry.js'],
    plugins: [packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: SYNTAX_TARGET,
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    deps: { alwaysBundle: ['@deepseek-ai/dsh-atomic-write'] },
  },
  {
    // The Windows 7 track installs Electron 22, which has no support for an
    // ES module entry point in the main process: that support arrived in
    // Electron 28. The main bundle is therefore a CommonJS module on that
    // track, and the packaged manifest names it as the entry point.
    //
    // The bundler rewrites `import.meta.url` to the bundle's own location,
    // so the preload paths and the module resolution the shell performs
    // stay correct in both module systems.
    entry: win7.enabled ? { main: 'lib/types/main.js' } : ['lib/types/main.js'],
    plugins: [packagedImportsPlugin(mainProcessImports)],
    define: clientVersionDefine,
    onSuccess: async () => {
      await build({
        configFile: false,
        plugins: [{
          name: 'desktop-brand-font',
          async generateBundle() {
            for (const name of ['brand-font.css', 'montserrat-regular.woff2', 'montserrat-light.woff2', 'montserrat-medium.woff2', 'Montserrat-OFL.txt']) {
              this.emitFile({
                type: 'asset',
                fileName: name,
                source: await readFile(new URL(`../../packages/client/ui-theme/src/styles/${name}`, import.meta.url)),
              })
            }
          },
        }],
        root: fileURLToPath(new URL('.', import.meta.url)),
        esbuild: { jsx: 'automatic' },
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
          outDir: 'lib/welcome',
          emptyOutDir: true,
          lib: {
            entry: 'src/client/welcome.tsx',
            formats: ['iife'],
            name: 'DesktopWelcome',
            fileName: () => 'welcome.js',
            cssFileName: 'welcome',
          },
        },
      })
    },
    outDir: 'lib',
    format: win7.enabled ? ['cjs'] : ['esm'],
    platform: 'node',
    target: SYNTAX_TARGET,
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  ...(['preload-app', 'preload-welcome', 'preload-platform-account', 'preload-mandatory', 'preload-update-dialog'] as const).map(name => ({
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: { [name]: `lib/types/${name}.js` },
    plugins: [packagedImportsPlugin(preloadImports)],
    outDir: 'lib',
    format: 'cjs' as const,
    codeSplitting: false,
    platform: 'node' as const,
    target: SYNTAX_TARGET,
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  })),
])
