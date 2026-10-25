/**
 * Listener removal across Electron generations.
 *
 * The preload scripts run inside the renderer, in a sandbox, and they
 * remove the listeners they registered when a subscription ends. Electron 22
 * offers `removeListener` on the renderer bridge; `off` is the newer name and
 * arrived with Electron 30. A preload that called the newer name on the
 * Windows 7 track would fail with a `TypeError` the moment a subscription
 * ended, and the window would be left with a listener it could not take
 * back.
 */

/** The renderer bridge surface this module needs. */
interface RendererBridge {
  off?: (channel: string, listener: (...args: never[]) => void) => void
  removeListener: (channel: string, listener: (...args: never[]) => void) => void
}

/**
 * Remove a listener from the renderer bridge.
 * @param bridge - The renderer bridge.
 * @param channel - Channel the listener was registered on.
 * @param listener - The listener to remove.
 */
export function removeRendererListener(
  bridge: RendererBridge,
  channel: string,
  listener: (...args: never[]) => void,
): void {
  if (typeof bridge.off === 'function') {
    bridge.off(channel, listener)
    return
  }
  bridge.removeListener(channel, listener)
}
