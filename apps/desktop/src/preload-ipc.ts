/**
 * Listener removal across Electron generations.
 *
 * The preload scripts run inside the renderer, in a sandbox, and they remove
 * the listeners they registered when a subscription ends. Electron 22 offers
 * `removeListener` on the renderer bridge; `off` is the newer name and arrived
 * with Electron 30. A preload that called the newer name on the Windows 7
 * track would fail with a `TypeError` the moment a subscription ended, and the
 * window would be left with a listener it could not take back.
 */

/**
 * The renderer bridge surface this module needs.
 *
 * The listener type is left to the caller, because the bridge declares it in
 * terms of its own event type and a narrower signature here would make the
 * bridge unacceptable as an argument.
 */
interface RendererBridge {
  off?: <L>(channel: string, listener: L) => void
  removeListener<L>(channel: string, listener: L): void
}

/**
 * Remove a listener from the renderer bridge.
 * @param bridge - The renderer bridge.
 * @param channel - Channel the listener was registered on.
 * @param listener - The listener to remove.
 */
export function removeRendererListener<L>(bridge: RendererBridge, channel: string, listener: L): void {
  if (typeof bridge.off === 'function') {
    bridge.off(channel, listener)
    return
  }
  bridge.removeListener(channel, listener)
}
