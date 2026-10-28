/**
 * Renderer polyfills injected into the boot script.
 *
 * Chromium 108 in Electron 22 lacks `Promise.withResolvers` (Chrome 119), the
 * copy-free array helpers (Chrome 110), `URL.parse` (126) and
 * `String.prototype.toWellFormed` (111), and the client bundle uses them —
 * `web-document.ts` itself composes `__DSH_BOOT_READY__` from
 * `Promise.withResolvers`. `structuredClone` (Chrome 98), `:has()` (105) and
 * container queries (105) are already present and stay untouched.
 *
 * Kept as a string so the same bytes can be emitted into the served document
 * without a separate asset request.
 */
export const WIN7_BOOT_POLYFILL_SOURCE = `(function(){
  if (typeof Promise.withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    } });
  }
  if (typeof Symbol.dispose !== 'symbol') {
    Object.defineProperty(Symbol, 'dispose', { configurable: true, value: Symbol.for('Symbol.dispose') });
  }
  if (typeof Symbol.asyncDispose !== 'symbol') {
    Object.defineProperty(Symbol, 'asyncDispose', { configurable: true, value: Symbol.for('Symbol.asyncDispose') });
  }
  if (typeof AbortSignal === 'function' && typeof AbortSignal.timeout !== 'function') {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value: function (ms) {
      var controller = new AbortController();
      var timer = setTimeout(function () {
        var error = new Error('The operation was aborted due to timeout after ' + ms + 'ms');
        error.name = 'TimeoutError';
        controller.abort(error);
      }, ms);
      controller.signal.addEventListener('abort', function () { clearTimeout(timer); }, { once: true });
      return controller.signal;
    } });
  }
  if (typeof AbortSignal === 'function' && typeof AbortSignal.any !== 'function') {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: function (signals) {
      var controller = new AbortController();
      var list = Array.prototype.slice.call(signals);
      var aborted = list.filter(function (signal) { return signal.aborted; })[0];
      if (aborted) { controller.abort(aborted.reason); return controller.signal; }
      list.forEach(function (signal) {
        signal.addEventListener('abort', function () { controller.abort(signal.reason); }, { once: true });
      });
      return controller.signal;
    } });
  }
  var arrayMethods = {
    with: function (index, value) {
      var length = this.length;
      var normalized = index < 0 ? length + index : index;
      if (normalized < 0 || normalized >= length) throw new RangeError('Invalid index');
      var copy = Array.prototype.slice.call(this);
      copy[normalized] = value;
      return copy;
    },
    toSorted: function (compare) { return Array.prototype.slice.call(this).sort(compare); },
    toReversed: function () { return Array.prototype.slice.call(this).reverse(); },
    toSpliced: function (start, deleteCount) {
      var copy = Array.prototype.slice.call(this);
      var rest = Array.prototype.slice.call(arguments, 2);
      if (arguments.length === 1) return copy.splice(start);
      if (arguments.length === 2) return copy.splice(start, deleteCount);
      return copy.splice(start, deleteCount, rest[0], rest[1], rest[2], rest[3], rest[4]);
    },
    findLast: function (predicate, thisArg) {
      for (var index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index], index, this)) return this[index];
      }
      return undefined;
    },
    findLastIndex: function (predicate, thisArg) {
      for (var index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index], index, this)) return index;
      }
      return -1;
    }
  };
  Object.keys(arrayMethods).forEach(function (name) {
    if (typeof Array.prototype[name] === 'function') return;
    Object.defineProperty(Array.prototype, name, { configurable: true, writable: true, value: arrayMethods[name] });
  });
  if (typeof URL.parse !== 'function') {
    Object.defineProperty(URL, 'parse', { configurable: true, writable: true, value: function (input, base) {
      try { return new URL(input, base); } catch (error) { return null; }
    } });
  }
  if (typeof String.prototype.toWellFormed !== 'function') {
    Object.defineProperty(String.prototype, 'toWellFormed', { configurable: true, writable: true, value: function () {
      var text = String(this);
      var result = '';
      for (var index = 0; index < text.length; index += 1) {
        var code = text.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
          var next = text.charCodeAt(index + 1);
          if (next >= 0xDC00 && next <= 0xDFFF) { result += text[index] + text[index + 1]; index += 1; }
          else { result += '\uFFFD'; }
          continue;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) { result += '\uFFFD'; continue; }
        result += text[index];
      }
      return result;
    } });
  }
  if (typeof URL.canParse !== 'function') {
    Object.defineProperty(URL, 'canParse', { configurable: true, writable: true, value: function (input, base) {
      try { void new URL(input, base); return true; } catch (error) { return false; }
    } });
  }
})();`
