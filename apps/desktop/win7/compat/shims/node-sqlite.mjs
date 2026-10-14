/**
 * `node:sqlite` shim for Node 16.
 *
 * The Harness imports exactly two APIs: `DatabaseSync` (`prepare`, `exec`,
 * `close`) and `StatementSync` (`get`, `all`, `run`, `iterate`). Both drivers
 * below expose those shapes, so no calling code changes.
 *
 * Driver order:
 *   1. `better-sqlite3` — fastest, used when a Node 16-compatible build is
 *      installed beside the dsh runtime.
 *   2. `node-sqlite3-wasm` — pure WebAssembly, no native build and no Node-API
 *      ABI coupling, so it loads under both Electron 22's Node and the
 *      standalone Node 16 runtime. This is the shipped default.
 *
 * Resolution walks the module roots the shell passes in `DSH_WIN7_MODULE_ROOTS`
 * (the dsh tree is not an ancestor of this file), then falls back to ordinary
 * `require` resolution.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** Module roots where a driver may be installed, most specific first. */
function searchRoots() {
  const declared = process.env.DSH_WIN7_MODULE_ROOTS
  const roots = declared === undefined ? [] : declared.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  return [...roots, undefined]
}

/** Load one driver from the candidate roots, or throw a diagnosable error. */
function loadDriver() {
  const failures = []
  for (const root of searchRoots()) {
    for (const name of ['better-sqlite3', 'node-sqlite3-wasm']) {
      try {
        const specifier = root === undefined ? name : join(root, 'node_modules', name)
        if (root !== undefined && !existsSync(specifier)) continue
        return { name, loaded: require(specifier) }
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const failure = new Error(
    'node:sqlite shim: no SQLite driver is installed for this runtime. '
    + 'Windows 7 builds ship node-sqlite3-wasm beside the dsh runtime; set '
    + 'DSH_WIN7_MODULE_ROOTS to the tree that contains its node_modules.',
  )
  failure.cause = failures
  throw failure
}

/** Adapt a driver statement to the `node:sqlite` statement surface. */
function adaptStatement(statement) {
  return {
    get: (...parameters) => statement.get(...parameters),
    all: (...parameters) => statement.all(...parameters),
    run: (...parameters) => {
      const result = statement.run(...parameters)
      return result === undefined ? {} : result
    },
    iterate: (...parameters) => {
      if (typeof statement.iterate === 'function') return statement.iterate(...parameters)
      // WASM drivers expose only `all`; iterate lazily over that snapshot.
      const rows = statement.all(...parameters)
      return (function* generator() { for (const row of rows) yield row })()
    },
    setAllowBareNamedParameters: () => undefined,
  }
}

/** Adapt a driver database to the `node:sqlite` database surface. */
function adaptDatabase(driver, path) {
  const isBetterSqlite = typeof driver === 'function'
  const database = isBetterSqlite ? new driver(path) : new driver.Database(path)
  if (isBetterSqlite && typeof database.pragma === 'function') {
    try {
      database.pragma('journal_mode = WAL')
    } catch {
      // A read-only or in-memory database keeps its default journal mode.
    }
  }
  return {
    database,
    api: {
      prepare: sql => adaptStatement(database.prepare(sql)),
      exec: (sql) => { database.exec(sql) },
      close: () => { database.close() },
      createFunction: (name, implementation) => {
        if (typeof database.function === 'function') database.function(name, implementation)
      },
      transaction: (callback) => {
        if (typeof database.transaction !== 'function') return callback
        return database.transaction(callback)
      },
    },
  }
}

/** Cached driver so one process loads it once. */
let cachedDriver

/** `node:sqlite` compatible database constructor. */
export class DatabaseSync {
  /** @param {string} path - Database file, or `:memory:`. */
  constructor(path) {
    cachedDriver ??= loadDriver()
    const adapted = adaptDatabase(cachedDriver.loaded, path)
    this.database = adapted.database
    this.api = adapted.api
  }

  /** @param {string} sql - Statement text. */
  prepare(sql) { return this.api.prepare(sql) }

  /** @param {string} sql - Script text. */
  exec(sql) { this.api.exec(sql) }

  /** @param {string} name - Function name exposed to SQL. */
  createFunction(name, implementation) { this.api.createFunction(name, implementation) }

  /** @param {Function} callback - Invoked inside a transaction. */
  transaction(callback) { return this.api.transaction(callback) }

  close() { this.api.close() }
}

/** `node:sqlite` compatible statement type marker. */
export const StatementSync = undefined

export default { DatabaseSync, StatementSync }
