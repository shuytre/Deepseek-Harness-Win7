/**
 * Windows 7 API rules for the native code the Desktop shell ships.
 *
 * The Windows 7 track fails in ways a Windows Server runner cannot observe:
 * a binary that imports an API Windows 7 does not have does not load at all,
 * and the failure surfaces as a crash with no message. The two faults this
 * file exists to prevent are both in code the project owns:
 *
 *   * an API introduced after Windows 7 SP1 (error 50 was caused by using
 *     `PROC_THREAD_ATTRIBUTE_JOB_LIST`, a Windows 8 attribute, on Windows 7);
 *   * an API that exists but is only available on a newer release, which the
 *     headers hide behind a version macro rather than behind a missing
 *     symbol.
 *
 * The rules name the Windows release that introduced each API, so a use of
 * one is reported with the version that rejects it.
 */

/** Windows release numbers used by the rules. */
export const WINDOWS_RELEASES = {
  vista: 6.0,
  win7: 6.1,
  win8: 6.2,
  win81: 6.3,
  win10: 10.0,
}

/**
 * Win32 symbols that Windows 7 SP1 does not have, with the release that
 * introduced them.
 *
 * A symbol is listed when it is absent from Windows 7 SP1. Symbols that only
 * changed behaviour later are not listed here, because a behaviour change
 * does not stop a binary from loading.
 */
export const WIN7_ABSENT_SYMBOLS = new Map(Object.entries({
  // Windows 8
  WaitOnAddress: 8,
  WakeByAddressSingle: 8,
  WakeByAddressAll: 8,
  GetSystemTimePreciseAsFileTime: 8,
  CreateFile2: 8,
  GetThreadDescription: 10,
  SetThreadDescription: 10,
  GetPackageFullName: 8,
  GetCurrentPackageFullName: 8,
  GetTempPath2W: 10,
  SetProcessMitigationPolicy: 8,
  GetSystemCpuSetInformation: 10,
  PrefetchVirtualMemory: 8,
  GetDpiForWindow: 10,
  GetDpiForSystem: 10,
  SetThreadDpiAwarenessContext: 10,
  SetProcessDpiAwarenessContext: 10,
  GetPointerDeviceRects: 8,
  CreateAppContainerProfile: 8,
  // Windows 8.1
  GetDpiForMonitor: 8.1,
  IsWindows8Point1: 8.1,
  // Windows 10
  GetSystemTimePreciseAsFileTime: 8,
  SetThreadDescription: 10,
}))

/**
 * Attribute flags and constants that only exist from a given release.
 *
 * `PROC_THREAD_ATTRIBUTE_JOB_LIST` is the fault that produced the reported
 * `Windows error 50`: the attribute list is accepted on Windows 7, but the
 * job attribute is rejected, and the rejection surfaces as an unsupported
 * request rather than as a load failure.
 *
 * `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` and `InitializeProcThreadAttributeList`
 * exist on Windows 7 and are therefore absent from this table: naming them
 * would report a call the platform accepts.
 */
export const WIN7_ABSENT_CONSTANTS = new Map(Object.entries({
  PROC_THREAD_ATTRIBUTE_JOB_LIST: 8,
  PROC_THREAD_ATTRIBUTE_JOB_OBJECT: 8,
  PROC_THREAD_ATTRIBUTE_ALTERNATIVE_SECURITY_TOKEN: 8,
  PROC_THREAD_ATTRIBUTE_PARENT_PROCESS: 8,
  PROC_THREAD_ATTRIBUTE_GROUP_AFFINITY: 6.2,
  PROC_THREAD_ATTRIBUTE_IDEAL_PROCESSOR: 6.2,
  PROC_THREAD_ATTRIBUTE_PROTECTION_LEVEL: 6.2,
  PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY: 10,
  CreatePseudoConsole: 10,
}))

/**
 * C runtime functions that only exist from a given release.
 */
export const WIN7_ABSENT_C_RUNTIME = new Map(Object.entries({
  _wfopen_s: 8,
  _wopen_s: 8,
  _sopen_s: 8,
  _get_sigsafe: 8,
  _lfindfirsti64: 8,
  _lfindnexti64: 8,
  _utcnt64: 8,
  _mkgmtime64: 8,
  _strtime64: 8,
  _wstrtime64: 8,
  _localtime64: 8,
  _localtime64_s: 8,
  _ctime64_s: 8,
  _time64: 8,
  _wctime64: 8,
  _wctime64_s: 8,
  _gmtime64_s: 8,
  _fseeki64: 8,
  _ftelli64: 8,
  _tell: 8,
  _tell64: 8,
}))

/**
 * Windows API-set DLLs that only exist from a given release.
 */
export const WIN7_ABSET_DLLS = [
  { pattern: /^api-ms-win-core-synch-l1-2-/iu, floor: 8 },
  { pattern: /^api-ms-win-core-winrt/iu, floor: 8 },
  { pattern: /^api-ms-win-core-processthreads-l1-1-1/iu, floor: 8 },
  { pattern: /^api-ms-win-core-delayload/iu, floor: 8 },
  { pattern: /^api-ms-win-appmodel/iu, floor: 8 },
  { pattern: /^kernel\.appcore/iu, floor: 8 },
  { pattern: /^dcomp\.dll/iu, floor: 8 },
  { pattern: /^shcore\.dll/iu, floor: 8.1 },
]

/**
 * The same rules as a global pattern, for scanning source text.
 *
 * `matchAll` requires a global pattern, so the anchored forms above are
 * rewritten into a form that finds the same names inside a source file.
 */
export const WIN7_ABSENT_DLL_PATTERNS = WIN7_ABSET_DLLS.map(rule => ({
  pattern: new RegExp(rule.pattern.source.replace(/^\^/u, '').replace(/\$/u, ''), 'giu'),
  floor: rule.floor,
}))
