/**
 * `node:sea` shim for Node 16.
 *
 * Only `isSea()` is used, by skill-office and the SSH helper, to detect
 * single-executable builds. Neither ships in the Desktop package, so the
 * honest answer on Windows 7 is always `false`; `getAsset` and `getAssetKeys`
 * throw rather than pretending to serve bytes.
 */
export function isSea() { return false }

export function getAsset() {
  throw new Error('node:sea shim: single-executable assets are unavailable on this runtime')
}

export function getAssetKeys() {
  throw new Error('node:sea shim: single-executable assets are unavailable on this runtime')
}

export default { isSea, getAsset, getAssetKeys }
