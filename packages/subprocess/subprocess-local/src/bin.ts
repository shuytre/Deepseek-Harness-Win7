/** Thin executable/importable entry for the provider-private runner core. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { consumeRunnerSelection } from './runner-launch.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

/**
 * Run a selector already removed by a packaging bootstrap.
 * @param selection - private runner selector or Linux launch-request locator.
 */
export async function runSelectedSubprocessRunner(selection: string): Promise<void> {
  try {
    await runSpawnRunner(selection, process.argv.slice(2))
  } catch (error) {
    await reportSpawnRunnerFailure(selection, error)
  }
}

// import.meta.main is Node 22.19+; the Windows 7 runtime is Node 16.
const isMain = (import.meta as ImportMeta & { main?: boolean }).main
  ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
if (isMain) {
  const selection = consumeRunnerSelection()
  if (selection === undefined) {
    process.exitCode = 127
  } else {
    void runSelectedSubprocessRunner(selection)
  }
}
