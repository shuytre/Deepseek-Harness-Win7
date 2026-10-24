/**
 * PE import scanner for the Windows 7 track.
 *
 * Windows 7 SP1 loads a binary only when every imported symbol resolves. A
 * binary built against a newer SDK silently raises the floor by importing an
 * API that does not exist on NT 6.1, and the failure appears as a load-time
 * crash with no useful message. This scanner reads the import directory of
 * every shipped PE file and reports the symbols and DLLs Windows 7 lacks.
 *
 * It is a static check: a clean report is necessary but not sufficient, since
 * a dynamically resolved symbol (`GetProcAddress`) is invisible here.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Symbols absent before Windows 8 / 8.1 / 10, keyed by the DLL that exports them. */
const SYMBOL_FLOOR = new Map([
  ['WaitOnAddress', 8], ['WakeByAddressSingle', 8], ['WakeByAddressAll', 8],
  ['GetSystemTimePreciseAsFileTime', 8], ['CreateFile2', 8], ['GetThreadDescription', 10],
  ['SetThreadDescription', 10], ['GetPackageFullName', 8], ['GetCurrentPackageFullName', 8],
  ['GetTempPath2W', 10], ['SetProcessMitigationPolicy', 8], ['GetSystemCpuSetInformation', 10],
  ['PrefetchVirtualMemory', 8], ['GetDpiForWindow', 10], ['GetDpiForSystem', 10],
  ['SetThreadDpiAwarenessContext', 10], ['SetProcessDpiAwarenessContext', 10],
  ['GetPointerDeviceRects', 8], ['CreateAppContainerProfile', 8],
  ['RtlGenRandom', 0], // Present on Windows 7; listed to document that it is fine.
])

/** DLLs introduced after Windows 7, matched by prefix. */
const DLL_FLOOR = [
  { pattern: /^api-ms-win-core-synch-l1-2-/iu, floor: 8 },
  { pattern: /^api-ms-win-core-winrt/iu, floor: 8 },
  { pattern: /^api-ms-win-core-processthreads-l1-1-1/iu, floor: 8 },
  { pattern: /^api-ms-win-core-delayload/iu, floor: 8 },
  { pattern: /^api-ms-win-appmodel/iu, floor: 8 },
  { pattern: /^kernel\.appcore/iu, floor: 8 },
  { pattern: /^dcomp\.dll/iu, floor: 8 },
  { pattern: /^shcore\.dll/iu, floor: 8.1 },
  { pattern: /^d2d1\.dll/iu, floor: 0 },
  { pattern: /^d3d11\.dll/iu, floor: 0 },
  { pattern: /^winhttp\.dll/iu, floor: 0 },
  { pattern: /^bcrypt\.dll/iu, floor: 0 },
  { pattern: /^ucrtbase\.dll/iu, floor: 0 },
  { pattern: /^vcruntime1[0-9]+/iu, floor: 0 },
]

const MACHINES = new Map([[0x014c, 'x86'], [0x8664, 'x64'], [0xaa64, 'arm64']])

/**
 * Read the import table of one PE file.
 * @param {string} path - Absolute file path.
 * @returns {Promise<{ file: string, machine: string, libraries: string[], symbols: string[], failure?: string }>} Imported libraries and symbols.
 */
export async function readPeImports(path) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(0x40)
    await handle.read(header, 0, header.length, 0)
    if (header.readUInt16LE(0) !== 0x5a4d) return { file: path, machine: 'none', libraries: [], symbols: [], failure: 'not a PE image' }
    const peOffset = header.readUInt32LE(0x3c)
    const signature = Buffer.alloc(0x18)
    await handle.read(signature, 0, signature.length, peOffset)
    if (signature.readUInt32LE(0) !== 0x00004550) return { file: path, machine: 'none', libraries: [], symbols: [], failure: 'missing PE signature' }
    const machine = MACHINES.get(signature.readUInt16LE(4)) ?? 'unknown'
    const sectionCount = signature.readUInt16LE(6)
    const optionalSize = signature.readUInt16LE(20)
    const optional = Buffer.alloc(optionalSize)
    await handle.read(optional, 0, optionalSize, peOffset + 24)
    const magic = optional.readUInt16LE(0)
    const directoryOffset = magic === 0x20b ? 112 : 96
    const importRva = optional.readUInt32LE(directoryOffset + 8)
    if (importRva === 0) return { file: path, machine, libraries: [], symbols: [] }
    const sections = Buffer.alloc(sectionCount * 40)
    await handle.read(sections, 0, sections.length, peOffset + 24 + optionalSize)
    const toOffset = (rva) => {
      for (let index = 0; index < sectionCount; index += 1) {
        const base = index * 40
        const virtualSize = sections.readUInt32LE(base + 8)
        const virtualAddress = sections.readUInt32LE(base + 12)
        const rawSize = sections.readUInt32LE(base + 16)
        const rawPointer = sections.readUInt32LE(base + 20)
        if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
          return rawPointer + (rva - virtualAddress)
        }
      }
      return undefined
    }
    const libraries = []
    const symbols = []
    for (let descriptorIndex = 0; descriptorIndex < 4096; descriptorIndex += 1) {
      const descriptorOffset = toOffset(importRva + descriptorIndex * 20)
      if (descriptorOffset === undefined) break
      const descriptor = Buffer.alloc(20)
      await handle.read(descriptor, 0, 20, descriptorOffset)
      const originalThunk = descriptor.readUInt32LE(0)
      const nameRva = descriptor.readUInt32LE(12)
      const firstThunk = descriptor.readUInt32LE(16)
      if (originalThunk === 0 && nameRva === 0 && firstThunk === 0) break
      const nameOffset = toOffset(nameRva)
      if (nameOffset !== undefined) libraries.push((await readCString(handle, nameOffset)).toLowerCase())
      const thunkRva = originalThunk === 0 ? firstThunk : originalThunk
      const width = magic === 0x20b ? 8 : 4
      for (let thunkIndex = 0; thunkIndex < 8192; thunkIndex += 1) {
        const entryOffset = toOffset(thunkRva + thunkIndex * width)
        if (entryOffset === undefined) break
        const entry = Buffer.alloc(width)
        await handle.read(entry, 0, width, entryOffset)
        const value = width === 8 ? entry.readBigUInt64LE(0) : BigInt(entry.readUInt32LE(0))
        if (value === 0n) break
        const ordinalFlag = width === 8 ? 0x8000000000000000n : 0x80000000n
        if ((value & ordinalFlag) !== 0n) continue
        const hintOffset = toOffset(Number(value))
        if (hintOffset === undefined) continue
        symbols.push(await readCString(handle, hintOffset + 2))
      }
    }
    return { file: path, machine, libraries, symbols }
  } finally {
    await handle.close()
  }
}

/**
 * Read a NUL-terminated ASCII string at an absolute file offset.
 * @param {import('node:fs/promises').FileHandle} handle - Open file handle.
 * @param {number} offset - Absolute file offset.
 * @returns {Promise<string>} Decoded string.
 */
async function readCString(handle, offset) {
  const chunk = Buffer.alloc(256)
  await handle.read(chunk, 0, chunk.length, offset)
  const end = chunk.indexOf(0)
  return chunk.subarray(0, end < 0 ? chunk.length : end).toString('latin1')
}

/**
 * Report every import Windows 7 SP1 cannot satisfy.
 * @param {{ file: string, libraries: string[], symbols: string[] }} imports - Parsed import table.
 * @returns {Array<{ file: string, kind: 'library' | 'symbol', name: string, floor: number }>} Findings, empty when the binary is Windows 7 clean.
 */
export function findWindows7Violations(imports) {
  const findings = []
  for (const library of imports.libraries) {
    for (const rule of DLL_FLOOR) {
      if (rule.floor > 0 && rule.pattern.test(library)) findings.push({ file: imports.file, kind: 'library', name: library, floor: rule.floor })
    }
  }
  for (const symbol of imports.symbols) {
    const floor = SYMBOL_FLOOR.get(symbol)
    if (floor !== undefined && floor > 0) findings.push({ file: imports.file, kind: 'symbol', name: symbol, floor })
  }
  return findings
}

/** Extensions that carry PE content in the packaged runtime. */
const PE_EXTENSIONS = new Set(['.exe', '.dll', '.node', '.pyd', '.so'])

/**
 * Third-party binaries the track has to ship but cannot make NT 6.1 import-clean.
 *
 * Every entry names the feature that degrades instead, so the scan can still fail
 * on a new violation — in the shell, in the runtime, or in a package we build —
 * without blocking on binaries that only a Windows 10 SDK can produce.
 */
export const KNOWN_WIN7_IMPORT_BLOCKERS = [
  { pattern: /[\\/]node-pty[\\/].*[\\/]conpty[\\/]/iu, feature: 'terminal',
    reason: 'ConPTY is a Windows 10 API; node-pty starts winpty on Windows 7 instead' },
  { pattern: /[\\/]@img[\\/]sharp-win32-x64[\\/]/iu, feature: 'image processing',
    reason: 'sharp requires Node 20+ and is never loaded on the Node 16 track' },
  { pattern: /[\\/]sherpa-onnx-win-x64[\\/]/iu, feature: 'speech',
    reason: 'the speech engine has no Windows 7 build; dictation stays unavailable' },
  { pattern: /[\\/]@vscode[\\/]ripgrep-win32-x64[\\/]/iu, feature: 'file search',
    reason: 'ripgrep releases target Windows 8.1+; content search degrades' },
  { pattern: /[\\/]libreoffice-kit-win32-x64[\\/]/iu, feature: 'document conversion',
    reason: 'the office engine imports Windows 8 synchronisation primitives; conversion degrades' },
]

/**
 * Identify a documented third-party downgrade.
 * @param {string} file - Absolute path of the scanned binary.
 * @returns {{ pattern: RegExp, feature: string, reason: string } | undefined} Matching entry, if the file is a known blocker.
 */
export function knownWin7Blocker(file) {
  return KNOWN_WIN7_IMPORT_BLOCKERS.find(entry => entry.pattern.test(file))
}

/**
 * Walk a directory tree and scan every PE file.
 * @param {string} root - Directory to scan.
 * @returns {Promise<{ findings: Array<{ file: string, kind: string, name: string, floor: number }>, scanned: string[] }>} Findings and scanned files.
 */
export async function scanDirectory(root) {
  const findings = []
  const scanned = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
      if (!PE_EXTENSIONS.has(extension)) continue
      const info = await stat(full).catch(() => undefined)
      if (info === undefined || info.size === 0) continue
      const imports = await readPeImports(full)
      if (imports.failure !== undefined && imports.machine === 'none') continue
      scanned.push(full)
      findings.push(...findWindows7Violations(imports))
    }
  }
  await walk(root)
  return { findings, scanned }
}
