/**
 * Node's Zstandard surface, resolved at first use.
 *
 * `zstdCompress`, `zstdDecompress`, `zstdDecompressSync` and
 * `createZstdDecompress` arrived in Node 22.15. A named import of a builtin that
 * lacks them fails at link time, before any fallback can run, so every consumer
 * reads them from the module object here and gets one clear error instead.
 * @module dsh-session-persistence-jsonl/zlib-zstd
 */

import { createRequire } from 'node:module'
import type { ZstdOptions } from 'node:zlib'

/** The subset of `node:zlib` the Zstandard frame helpers use. */
export interface ZstdZlib {
  readonly constants: typeof import('node:zlib').constants
  zstdCompress(input: Buffer | string, options: ZstdOptions, callback: (error: Error | null, result: Buffer) => void): void
  zstdDecompress(input: Buffer, options: ZstdOptions, callback: (error: Error | null, result: Buffer) => void): void
  zstdDecompressSync(input: Buffer, options?: ZstdOptions): Buffer
  createZstdDecompress(options?: ZstdOptions): ReturnType<typeof import('node:zlib').createZstdDecompress>
}

/** Message every caller reports when the runtime has no Zstandard support. */
export const ZSTD_UNAVAILABLE = 'Zstandard session logs require node:zlib zstd support (Node 22.15 or later)'

/**
 * Read the runtime's Zstandard surface.
 * @returns the zlib zstd API.
 * @throws when the runtime has no Zstandard support.
 */
export function zstdZlib(): ZstdZlib {
  const zlib = createRequire(import.meta.url)('node:zlib') as Partial<ZstdZlib>
  /* v8 ignore next -- the Windows 7 track has no zstd and selects uncompressed sessions */
  if (typeof zlib.zstdCompress !== 'function') throw new Error(ZSTD_UNAVAILABLE)
  return zlib as ZstdZlib
}

/**
 * Report whether this runtime can encode and decode Zstandard frames.
 * @returns true when the zlib zstd API is present.
 */
export function hasZstdZlib(): boolean {
  try {
    zstdZlib()
    return true
  } catch {
    return false
  }
}
