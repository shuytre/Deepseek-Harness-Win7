/** Desktop-specific selection of workspace and runtime-only dependency patches. */

/** A patch shared with the workspace, excluded from runtime installation, or supplied only to Desktop. */
export type DesktopRuntimePatch =
  | { scope: 'shared'; reason: string }
  | { scope: 'workspace-only'; reason: string }
  | { scope: 'runtime-only'; path: string; reason: string }

/** Every workspace patch requires an explicit Desktop decision; runtime-only entries may add or replace a patch. */
export const DESKTOP_RUNTIME_PATCHES: Readonly<Record<string, DesktopRuntimePatch>> = {
  '@earendil-works/pi-ai@1.0.2': { scope: 'shared', reason: 'Runtime providers need the streamed argument parsing fix.' },
  '@electron/osx-sign@1.3.3': { scope: 'workspace-only', reason: 'Signing executes on the build host.' },
  '@fortune-sheet/core@1.0.4': { scope: 'workspace-only', reason: 'Patched spreadsheet code is embedded in the client bundle.' },
  '@fortune-sheet/react@1.0.4': { scope: 'workspace-only', reason: 'Patched spreadsheet code is embedded in the client bundle.' },
  '@yao-pkg/pkg@6.21.0': { scope: 'workspace-only', reason: 'The executable packer executes on the build host.' },
  'exceljs@4.4.0': { scope: 'workspace-only', reason: 'The patched parser is embedded in the client bundle and worker.' },
  'node-pty@1.2.0-beta.15': { scope: 'shared', reason: 'Runtime terminals need helper resolution and Windows worker cleanup.' },
}

/** Reviewed Desktop dependency constraints, independent of patch selection. */
export const DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES: Readonly<Record<string, string>> = {
  // The provider declares ^1.0.2; its patch is qualified against 1.0.2.
  '@earendil-works/pi-ai@^1.0.2': '1.0.2',
}

/**
 * Additional runtime constraints for the Windows 7 track.
 *
 * The shipped dsh tree runs on Node 16 (Electron 22), so a dependency whose
 * `engines` floor is newer than 16 fails to load there:
 *   - `execa@10` declares `node >= 22`; `execa@8.0.1` declares `>= 16.17`.
 *   - `undici@6` declares `node >= 18.17`; `undici@5.28.5` declares `>= 14`.
 *   - `undici@7` and `undici@8` do the same, and they also read runtime APIs
 *     Node 16 does not have while their own module bodies evaluate: eight
 *     reached `zlib.createZstdDecompress.bind(...)`, which threw
 *     "Cannot read properties of undefined (reading 'bind')" and took the fetch
 *     stack — and the Host — down before any request was made.
 * Keep this list limited to floors that are actually unmeetable, and re-check
 * it whenever the workspace bumps one of these packages.
 */
export const DESKTOP_WIN7_DEPENDENCY_OVERRIDES: Readonly<Record<string, string>> = {
  'execa@^10.0.1': '8.0.1',
  // A bare name pins every range: the ranges that matter are transitive peers
  // (`>=5 <9`, `8.10.2`, `7.29.1`), which change with the workspace.
  'undici': '5.28.5',
}

/**
 * Merge the Windows 7 constraints into the reviewed Desktop overrides.
 * @param enabled - Whether the Windows 7 track is building.
 * @param base - Reviewed Desktop overrides.
 * @returns Overrides the runtime installation applies.
 */
export function desktopRuntimeOverrides(
  enabled: boolean,
  base: Readonly<Record<string, string>> = DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES,
): Readonly<Record<string, string>> {
  return enabled ? { ...base, ...DESKTOP_WIN7_DEPENDENCY_OVERRIDES } : base
}
