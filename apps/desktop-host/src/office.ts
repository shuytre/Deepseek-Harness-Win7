/** Desktop Office skills and bundled authoring dependencies. */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeArchivePath } from './office-engine.ts'
import type { Context } from '@deepseek-ai/cordis'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'

/**
 * Resolve a package subpath to an absolute path on every supported runtime.
 *
 * Node 16 — the Windows 7 track — exposes no `import.meta.resolve` without an
 * experimental flag, so a host that only has that form fails its Office row with
 * `resolve is not a function`. `require.resolve` answers the same manifest
 * specifier through the package's exports map on both tracks.
 * @param specifier - Package subpath, for example `<package>/package.json`.
 * @returns Absolute filesystem path to the resolved file.
 */
function resolvePackageFile(specifier: string): string {
  try {
    return createRequire(import.meta.url).resolve(specifier)
  } catch (error) {
    const resolved = (import.meta as unknown as { resolve?: (id: string) => string }).resolve?.(specifier)
    if (typeof resolved !== 'string') throw error
    return fileURLToPath(resolved)
  }
}

/** Loader identity for the application-owned Office composition. */
export const name = 'desktop-office'
/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory. Missing sibling `office-skills` resources fail Host startup. */
  readonly source: string
  /** Harness-home directory where workspace dependencies are installed. */
  readonly root: string
  /** Prepared or ASAR-contained application dependency directory. */
  readonly runtimeDir: string
}

/**
 * Enable offline Office authoring and structural checks in the Desktop profile.
 * @param ctx - Profile scope; child plugins declare their own service requirements.
 * @param config - Bundled payload source and Harness-home installation root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(workspaceDependencies, config)
  const archive = runtimeArchivePath(config.runtimeDir) === undefined ? undefined : dirname(realpathSync(config.runtimeDir))
  const manifest = resolvePackageFile('@deepseek-ai/libreoffice-kit/package.json')
  const packageRoot = dirname(archive === undefined ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)))
  await ctx.plugin(officeSkills, {
    assetRoot: join(dirname(config.source), 'office-skills'),
    node: join(config.source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    cli: join(packageRoot, 'lib', 'cli.js'),
  })
}
