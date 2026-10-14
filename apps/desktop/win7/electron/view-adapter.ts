/**
 * Attachable child web view across Electron generations.
 *
 * Electron 30 replaced `BrowserView` with `WebContentsView` and moved window
 * composition onto `BaseWindow.contentView`; Electron 22 has only
 * `BrowserView` + `BrowserWindow.setBrowserView`. Both constructors are read
 * off the Electron namespace at runtime rather than imported by name, because
 * neither name exists in every supported generation's type surface.
 */

import * as electron from 'electron'
import type { BrowserWindow, WebContents, WebPreferences } from 'electron'
import { closeWebContentsCompat } from './api-compat.ts'

/** Bounds of a child view inside the owner window's content area. */
export interface AttachableViewBounds { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** One child view that can be mounted into an owner window. */
export interface AttachableView {
  readonly webContents: WebContents
  /** @param bounds - Content-relative rectangle. */
  setBounds(bounds: AttachableViewBounds): void
  /** @param visible - Whether the child view is painted. */
  setVisible(visible: boolean): void
  /** @param owner - Window that receives the view. */
  attach(owner: BrowserWindow): void
  /** @param owner - Window that currently owns the view. */
  detach(owner: BrowserWindow): void
  /** Release native resources. */
  destroy(): void
}

/** Constructor surface shared by `WebContentsView` and `BrowserView`. */
interface ViewConstructor {
  new (options: { webPreferences: WebPreferences }): {
    webContents: WebContents
    setBounds(bounds: AttachableViewBounds): void
    setBackgroundColor?(color: string): void
  }
}

/** Electron namespaces of both generations, typed loosely on purpose. */
type ElectronGenerations = {
  readonly WebContentsView?: ViewConstructor
  readonly BrowserView?: ViewConstructor
}

/** Window surface that differs between the two generations. */
type ComposingWindow = BrowserWindow & {
  readonly contentView?: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
  }
  setBrowserView?(view: unknown | null): void
}

/**
 * Create a child view for the running Electron generation.
 * @param options - Web preferences applied to the child contents.
 * @returns Attachable view.
 */
export function createAttachableView(options: { readonly webPreferences: WebPreferences }): AttachableView {
  const generations = electron as unknown as ElectronGenerations
  const Modern = generations.WebContentsView
  if (typeof Modern === 'function') {
    const view = new Modern({ webPreferences: options.webPreferences })
    return {
      webContents: view.webContents,
      setBounds: bounds => { view.setBounds(bounds) },
      setVisible: (visible) => {
        const candidate = view as unknown as { setVisible?: (value: boolean) => void }
        candidate.setVisible?.(visible)
      },
      attach: (owner) => { (owner as ComposingWindow).contentView?.addChildView(view) },
      detach: (owner) => { (owner as ComposingWindow).contentView?.removeChildView(view) },
      destroy: () => { closeWebContentsCompat(view.webContents) },
    }
  }
  const Legacy = generations.BrowserView
  if (typeof Legacy !== 'function') {
    throw new Error('desktop platform view: this Electron build exposes neither WebContentsView nor BrowserView')
  }
  // Electron 22 path: BrowserView owns its contents and mounts through the window.
  const view = new Legacy({ webPreferences: options.webPreferences })
  let mounted: ComposingWindow | undefined
  return {
    webContents: view.webContents,
    setBounds: bounds => { view.setBounds(bounds) },
    // BrowserView has no visibility flag; mounting and unmounting is the equivalent.
    setVisible: (visible) => {
      const owner = mounted
      if (owner === undefined) return
      owner.setBrowserView?.(visible ? view : null)
    },
    attach: (owner) => {
      const composing = owner as ComposingWindow
      mounted = composing
      composing.setBrowserView?.(view)
    },
    detach: (owner) => {
      const composing = owner as ComposingWindow
      if (mounted === composing) {
        composing.setBrowserView?.(null)
        mounted = undefined
      }
    },
    destroy: () => {
      mounted = undefined
      closeWebContentsCompat(view.webContents)
    },
  }
}
