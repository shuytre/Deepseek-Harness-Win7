import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Synchronizes Windows context menus and caption colors with the application document. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { installWindowsMenu } from './preload-menu.ts'


/**
 * Mark a window the operating system does not round.
 *
 * Windows 11 rounds the window itself, so the content column only rounds the
 * corner inside the frame; Windows 8.1 and older draw a square window, and the
 * same rule leaves a square notch on the right. The preload runs sandboxed and
 * has no `node:os`, so the client hints are the source: Windows 11 reports
 * platform version 13 and later, Windows 10 reports 10 and earlier. A browser
 * without client hints is treated as square, which only adds the corner.
 * @param root - Document element carrying the platform markers.
 */
function markSquareCorners(root: HTMLElement): void {
  const data = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }> }
  }).userAgentData
  if (data === undefined) {
    root.dataset.windowsSquareCorners = ''
    return
  }
  void data.getHighEntropyValues(['platformVersion']).then((values) => {
    const major = Number.parseInt(String(values.platformVersion ?? '0').split('.')[0] ?? '0', 10)
    if (major >= 13) delete root.dataset.windowsSquareCorners
    else root.dataset.windowsSquareCorners = ''
  }).catch(() => {
    root.dataset.windowsSquareCorners = ''
  })
}

/** Install the Windows-only titlebar marker and observe application language and palette changes. */
export function syncWindowsAppearance(): void {
  if (process.platform !== 'win32') return
  const mark = (): void => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    // Windows 11 rounds the window itself, so the content column only rounds its
    // inner corner; Windows 7 and 8 draw a square window, and the same rule then
    // leaves a square notch on the right. The marker lets the stylesheet close it.
    markSquareCorners(root)
    root.style.setProperty('--dsh-windows-titlebar-height', `${WINDOWS_TITLEBAR_HEIGHT}px`)
  }
  // The root can be absent before the HTML parser creates it.
  if ((document.documentElement as HTMLElement | null) !== null) mark()
  const install = (): void => {
    mark()
    const root = document.documentElement
    const menu = installWindowsMenu()
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
    document.body.append(probe)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('Desktop caption requires a 2D canvas context')
    const nativeColor = (color: string): string => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`
    }
    let previous = ''
    const send = (): void => {
      const style = getComputedStyle(probe)
      const color = nativeColor(style.backgroundColor)
      const symbolColor = nativeColor(style.color)
      const values = [root.lang, color, symbolColor]
      const current = JSON.stringify(values)
      if (current === previous) return
      previous = current
      menu.update()
      ipcRenderer.send(DESKTOP_IPC.windowsAppearance, ...values)
    }
    const observer = new MutationObserver(send)
    observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    document.head.addEventListener('load', send, true)
    window.addEventListener('pagehide', () => {
      observer.disconnect()
      menu.dispose()
      probe.remove()
      document.head.removeEventListener('load', send, true)
    }, { once: true })
    send()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
