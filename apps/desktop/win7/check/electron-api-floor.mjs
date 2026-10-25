/**
 * Electron API floor for the Windows 7 track.
 *
 * The Windows 7 track ships Electron 22.3.27, the last release that still
 * supports Windows 7. Every Electron API the Desktop shell touches therefore
 * has to exist in that release: an API introduced later is `undefined` at
 * runtime, and the call site either throws a `TypeError` during startup or
 * silently disables the feature it was meant to enable.
 *
 * The Windows 10 track ships a current Electron and is not constrained. This
 * module exists because a CI runner on Windows Server cannot observe the
 * difference: `protocol.handle()` is simply present there, and only the
 * Windows 7 user sees the crash.
 *
 * The floor is derived from the shipped `electron@22.3.27` type definitions
 * rather than from a hand-written list, so it cannot drift from the runtime
 * the track actually installs.
 */

/** Electron release the Windows 7 track installs. */
export const WIN7_ELECTRON_VERSION = '22.3.27'

/**
 * Electron releases that introduced the APIs the Desktop shell uses.
 *
 * A value is the first Electron version that ships the API. `undefined` means
 * the API is absent from every Electron release and is a usage error.
 */
export const ELECTRON_API_FLOOR = {
  // Chromium 108 / Electron 22 baseline.
  app: 1,
  BrowserWindow: 1,
  Menu: 1,
  MenuItem: 1,
  Tray: 1,
  clipboard: 1,
  dialog: 1,
  ipcMain: 1,
  ipcRenderer: 1,
  contextBridge: 1,
  nativeImage: 1,
  Notification: 1,
  screen: 1,
  session: 1,
  shell: 1,
  systemPreferences: 1,
  protocol: 1,
  webFrameMain: 25,
  webUtils: 29,
  WebContentsView: 30,
}

/**
 * Members of `protocol` that the Windows 7 track cannot use.
 *
 * `protocol.handle` arrived in Electron 25 and replaced the
 * `register*Protocol` family. Electron 22 exposes no equivalent of the
 * request/response `Response` plumbing it provides, so the Desktop shell uses
 * the older `registerStreamProtocol` shape on that track.
 */
export const WIN7_UNSUPPORTED_PROTOCOL_MEMBERS = new Set(['handle', 'unhandle'])

/**
 * Electron versions whose `webContents` console event carries a details
 * object instead of positional arguments.
 *
 * Electron 22 emits `(event, level, message, line, sourceId)` with a numeric
 * level. The details object (`details.level === 'error'`,
 * `details.sourceId`, `details.lineNumber`) only arrived much later, so a
 * listener written against the modern shape silently stops collecting on
 * Electron 22 — the `details` argument is the event, whose `level` is
 * `undefined`, and `undefined !== 'error'` is always true.
 */
export const ELECTRON_CONSOLE_DETAILS_MIN_VERSION = 35

/**
 * Numeric console level that means "error" in the positional signature.
 *
 * Chromium reports console levels as 0 (verbose), 1 (info), 2 (warning) and
 * 3 (error).
 */
export const CONSOLE_ERROR_LEVEL = 3

/**
 * First Electron version that can load an ES module as the main entry point.
 *
 * Electron added ES module support to the main process in 28.0.0. Before
 * that the entry point had to be a CommonJS module, and a package that
 * declares `"type": "module"` made the packaged application fail to start
 * with a loader error and no window.
 */
export const ELECTRON_ESM_MAIN_MIN_VERSION = 28
