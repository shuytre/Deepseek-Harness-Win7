/**
 * Electron entry for the graphical probe.
 *
 * The probe has to be the Electron main process, because the events it
 * observes - the console output of the renderer, the renderer exiting, a
 * failed load - are main-process events that cannot be attached to a running
 * application from the outside.
 *
 * The real product entry point is loaded, so the code under test is the code
 * that ships.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

const root = process.env.DSH_GUI_PROBE_ROOT
if (root === undefined || root.length === 0) {
  console.error('gui probe: the launcher must allocate DSH_GUI_PROBE_ROOT')
  app.exit(2)
}

const application = join(root, 'app')
app.setAppPath(application)
app.setPath('userData', join(root, 'userdata'))
app.setPath('logs', join(root, 'logs'))

/**
 * Load the product entry point.
 *
 * The product is an ES module, so it is imported rather than required. The
 * launcher names the entry point, because the bundled and the compiled
 * entry point sit in different places.
 */
async function loadProduct() {
  const entry = process.env.DSH_GUI_PROBE_ENTRY ?? join(application, 'lib', 'main.js')
  await import(pathToFileURL(entry).href)
}

process.on('uncaughtException', (error) => {
  console.error('gui probe: uncaught', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('gui probe: unhandled rejection', reason)
})

void loadProduct().catch((error) => {
  console.error('gui probe: the product entry point could not be loaded', error)
  app.exit(1)
})
