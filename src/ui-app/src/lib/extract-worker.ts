// Web Worker that runs file extraction off the main thread.
//
// Bundled by Vite's `import.meta.url` Worker constructor pattern from
// `extract-client.ts`. The worker imports the same `processFile` the
// main thread used to call directly; `extract.ts` has been adjusted so
// the only DOM API it touches (canvas for PDF page rendering) routes
// through `makeCanvas2d` which picks `OffscreenCanvas` when `document`
// is absent.
//
// Protocol: messages are `{ id, file }` requests in, `{ id, ok, ... }`
// responses out. The id correlates request and response so a single
// worker can handle multiple concurrent calls — but each `processFile`
// is still serial inside the worker since most parsers do bursts of
// CPU work; concurrency would just queue inside.

// Vite's HMR client (injected into every worker module in dev) calls
// `location.reload()` when it decides a worker needs to refresh —
// typically after one of our source files changes mid-session. Web
// Workers have a `location` (WorkerLocation) but it has no `reload`
// method, so the call throws an uncaught `TypeError: location.reload
// is not a function`. That error bubbles up as a worker-global
// `error` event, which in turn rejects every in-flight `processFile`
// call (see the error listener in `extract-client.ts`) — i.e. PDF
// extracts started just before the HMR fires die with the same
// confusing message.
//
// Defining a no-op `reload` on `location` makes the spurious call a
// no-op. Production builds don't ship the HMR client, so this is
// dev-only insurance. Wrapped because some environments expose
// `location` as a read-only WorkerLocation; `defineProperty` with
// `configurable: true` works on the WebView2 / Chromium realisation,
// and the try/catch keeps us safe elsewhere.
;(() => {
  if (
    typeof (globalThis as { location?: unknown }).location === 'undefined'
  ) {
    return
  }
  const loc = (globalThis as unknown as { location: { reload?: unknown } }).location
  if (typeof loc.reload === 'function') return
  try {
    Object.defineProperty(loc, 'reload', {
      value: () => {
        console.info('[extract-worker] suppressed location.reload() — dev HMR')
      },
      configurable: true,
      writable: true,
    })
  } catch {
    // Fall through — if the property isn't definable here, the
    // worker-global error handler below still swallows the throw.
  }
})()

import { processFile, type ProcessedFile } from './extract'

interface WorkerRequest {
  id: string
  file: File
}

interface WorkerResponseOk {
  id: string
  ok: true
  result: ProcessedFile
}

interface WorkerResponseErr {
  id: string
  ok: false
  error: string
}

type WorkerResponse = WorkerResponseOk | WorkerResponseErr

// `self` in a module worker is `DedicatedWorkerGlobalScope` but the
// lib.webworker DOM lib isn't loaded by tsconfig; cast for the
// addEventListener and postMessage typing.
const ctx = self as unknown as DedicatedWorkerGlobalScope

// One-shot boot log so we can confirm the worker is actually spawned
// rather than the client falling back to main-thread `processFile`
// (e.g. if Vite mis-bundles the worker URL on a stale chunk).
console.info('[extract-worker] booted in', typeof DOMParser === 'undefined' ? 'Worker (no DOMParser)' : 'main (has DOMParser)', 'context')

ctx.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  const { id, file } = e.data
  const tStart = performance.now()
  console.info(
    `[trace:worker] recv: ${file.name} (${file.size} bytes) @${tStart.toFixed(0)}ms`,
  )
  try {
    const result = await processFile(file)
    const tEnd = performance.now()
    console.info(
      `[trace:worker] processFile done: ${file.name} in ${(tEnd - tStart).toFixed(0)}ms — kind=${result.kind}`,
    )
    const reply: WorkerResponseOk = { id, ok: true, result }
    ctx.postMessage(reply)
  } catch (err) {
    console.warn(
      `[trace:worker] processFile FAILED: ${file.name} after ${(performance.now() - tStart).toFixed(0)}ms`,
      err,
    )
    const reply: WorkerResponseErr = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(reply)
  }
})
