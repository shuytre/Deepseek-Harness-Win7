/**
 * Listener removal across Electron generations.
 *
 * The preload scripts run inside the renderer, in a sandbox, and they remove
 * the listeners they registered when a subscription ends. Electron 22 offers
 * `removeListener` on the renderer bridge; `off` is the newer name and arrived
 * with Electron 30. A preload that called the newer name on the Windows 7
 * track would fail with a `TypeError` the moment a subscription ended, and the
 * window would be left with a listener it could not take back.
 *
 * The bridge is accepted as an unknown value and read through a view of it,
 * so the function does not require the bridge to satisfy a shape declared
 * here. A bridge that declares `off` with its own signature is still a bridge
 * this function can drive.
 */

/** The view of the bridge this module reads. */
interface ListenerRemovalView {
  off?: unknown
  removeListener?: unknown
}

/**
 * Remove a listener from the renderer bridge.
 * @param bridge - The renderer bridge.
 * @param channel - Channel the listener was registered on.
 * @param listener - The listener to remove.
 */
export function removeRendererListener(bridge: unknown, channel: string, listener: unknown): void {
  const view = bridge as ListenerRemovalView
  const off = view.off
  if (typeof off === 'function') {
    ;(off as (channel: string, listener: unknown) => void)(channel, listener)
    return
  }
  const removeListener = view.removeListener
  if (typeof removeListener === 'function') {
    ;(removeListener as (channel: string, listener: unknown) => void)(channel, listener)
    return
  }
  // A bridge with neither name is a runtime that has changed the shape; the
  // subscription cannot be taken back, and there is nothing to do about it.
}
