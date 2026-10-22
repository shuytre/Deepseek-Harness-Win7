import { deserialize, serialize } from 'node:v8'

/**
 * Install the Node 17-22 globals the harness uses but the Windows 7 runtime
 * (Node 16) lacks. Imported first by app-boot, so it runs before any module
 * body that could call one of these. Every shim is defined only when missing:
 * on Node 20+ this module is a no-op and the native implementations stay.
 */
type Bag = Record<string, unknown>

const globalScope = globalThis as typeof globalThis & { structuredClone?: <T>(value: T) => T }
if (typeof globalScope.structuredClone !== 'function') {
  // structuredClone (Node 17): v8 serialization is the same deep copy for the
  // plain config values the harness clones and rejects the same function/symbol
  // inputs, so it is a faithful stand-in (without transferables).
  globalScope.structuredClone = <T>(value: T): T => deserialize(serialize(value)) as T
}

const arrayProto = Array.prototype as unknown as Bag
if (typeof arrayProto.toReversed !== 'function') {
  arrayProto.toReversed = function toReversed<T>(this: T[]): T[] {
    return [...this].reverse()
  }
}
if (typeof arrayProto.toSorted !== 'function') {
  arrayProto.toSorted = function toSorted<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    return [...this].sort(compare)
  }
}
if (typeof arrayProto.toSpliced !== 'function') {
  arrayProto.toSpliced = function toSpliced<T>(this: T[], start: number, deleteCount?: number, ...items: T[]): T[] {
    const copy = [...this]
    if (deleteCount === undefined) copy.splice(start)
    else copy.splice(start, deleteCount, ...items)
    return copy
  }
}
if (typeof arrayProto.with !== 'function') {
  arrayProto.with = function withAt<T>(this: T[], index: number, value: T): T[] {
    const copy = [...this]
    copy[index < 0 ? copy.length + index : index] = value
    return copy
  }
}
if (typeof arrayProto.findLast !== 'function') {
  arrayProto.findLast = function findLast<T>(
    this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown,
  ): T | undefined {
    for (let index = this.length - 1; index >= 0; index--) {
      const value = this[index] as T
      if (predicate.call(thisArg, value, index, this)) return value
    }
    return undefined
  }
}
if (typeof arrayProto.findLastIndex !== 'function') {
  arrayProto.findLastIndex = function findLastIndex<T>(
    this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown,
  ): number {
    for (let index = this.length - 1; index >= 0; index--) {
      if (predicate.call(thisArg, this[index] as T, index, this)) return index
    }
    return -1
  }
}

const objectCtor = Object as unknown as Bag
if (typeof objectCtor.groupBy !== 'function') {
  objectCtor.groupBy = <T>(items: Iterable<T>, keyOf: (value: T, index: number) => PropertyKey): Bag => {
    const grouped: Bag = Object.create(null) as Bag
    let index = 0
    for (const item of items) {
      const key = String(keyOf(item, index++))
      const bucket = grouped[key] as T[] | undefined
      if (bucket) bucket.push(item)
      else grouped[key] = [item]
    }
    return grouped
  }
}

const mapCtor = Map as unknown as Bag
if (typeof mapCtor.groupBy !== 'function') {
  mapCtor.groupBy = <T, K>(items: Iterable<T>, keyOf: (value: T, index: number) => K): Map<K, T[]> => {
    const grouped = new Map<K, T[]>()
    let index = 0
    for (const item of items) {
      const key = keyOf(item, index++)
      const bucket = grouped.get(key)
      if (bucket) bucket.push(item)
      else grouped.set(key, [item])
    }
    return grouped
  }
}

const promiseCtor = Promise as unknown as Bag
if (typeof promiseCtor.withResolvers !== 'function') {
  promiseCtor.withResolvers = <T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  } => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}

const abortSignalCtor = AbortSignal as unknown as Bag
if (typeof abortSignalCtor.any !== 'function') {
  abortSignalCtor.any = (signals: AbortSignal[]): AbortSignal => {
    const controller = new AbortController()
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); return controller.signal }
    }
    const detach = signals.map(signal => {
      const listener = (): void => { controller.abort(signal.reason) }
      signal.addEventListener('abort', listener, { once: true })
      return () => signal.removeEventListener('abort', listener)
    })
    controller.signal.addEventListener('abort', () => { for (const off of detach) off() }, { once: true })
    return controller.signal
  }
}

const arrayCtor = Array as unknown as Bag
if (typeof arrayCtor.fromAsync !== 'function') {
  arrayCtor.fromAsync = async (items: AsyncIterable<unknown> | Iterable<unknown>): Promise<unknown[]> => {
    const out: unknown[] = []
    for await (const item of items as AsyncIterable<unknown>) out.push(item)
    return out
  }
}

const stringProto = String.prototype as unknown as Bag
if (typeof stringProto.isWellFormed !== 'function') {
  stringProto.isWellFormed = function isWellFormed(this: string): boolean {
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(this)
  }
}
if (typeof stringProto.toWellFormed !== 'function') {
  stringProto.toWellFormed = function toWellFormed(this: string): string {
    return this.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD')
  }
}
