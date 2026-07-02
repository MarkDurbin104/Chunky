// Client wrapper for the file extraction Web Worker.
//
// Spawns one worker per renderer (singleton, lazy). The worker handles
// mammoth/pdfjs/jszip/msgreader on its own thread so a 50 MB DOCX or
// a 200-page PDF no longer freezes the UI while extracting.
//
// Falls back to the main-thread `processFile` if `Worker` isn't
// available in this environment (e.g. SSR or unit tests under Node
// without a Worker shim). Production WebView2 always has Workers.
//
// Public API is a single function — `processFileInWorker(file)` —
// signature-compatible with `processFile` so callers swap in one line.

import type { ProcessedFile } from './extract'

let workerInstance: Worker | null = null
const pending = new Map<
  string,
  { resolve: (v: ProcessedFile) => void; reject: (e: Error) => void }
>()

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getWorker(): Worker | null {
  if (workerInstance) return workerInstance
  if (typeof Worker === 'undefined') {
    console.warn('[extract-client] Worker undefined — main-thread fallback')
    return null
  }
  try {
    workerInstance = new Worker(
      new URL('./extract-worker.ts', import.meta.url),
      { type: 'module' },
    )
    console.info('[extract-client] worker spawned')
  } catch (e) {
    console.warn('[extract-client] Worker spawn failed, falling back to main thread:', e)
    return null
  }
  workerInstance.addEventListener(
    'message',
    (e: MessageEvent<{ id: string; ok: boolean; result?: ProcessedFile; error?: string }>) => {
      const { id, ok, result, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok && result) p.resolve(result)
      else p.reject(new Error(error ?? 'extract worker returned no result'))
    },
  )
  workerInstance.addEventListener('error', (e) => {
    // A worker-global error fails every in-flight call. The user
    // gets the error string and the worker stays alive (Vite/HMR
    // will replace it on the next file).
    console.warn('[extract-client] worker error:', e.message)
    for (const [, p] of pending) {
      p.reject(new Error(e.message || 'worker error'))
    }
    pending.clear()
  })
  return workerInstance
}

/**
 * Process a file off the main thread. Returns the same
 * `ProcessedFile` shape as `processFile` so call sites are a
 * drop-in swap. If the Worker can't be created (no Worker global,
 * spawn failed), falls through to the main-thread implementation —
 * better a janky UI than a broken feature.
 */
// Legacy Office binaries (.doc/.xls/.ppt) need conversion through the
// Tauri host (COM-driving Word/Excel/PowerPoint), which uses an IPC
// bridge that only works on the main thread (`window.__TAURI_INTERNALS__`
// is not defined in workers). We do the conversion here on the main
// thread, then post the converted OOXML file into the worker.
const LEGACY_EXTS = new Set(['doc', 'xls', 'ppt'])

async function maybeConvertLegacy(file: File): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!LEGACY_EXTS.has(ext)) return file
  const { bridge } = await import('../bridge/client')
  // Read the file as a data URL on the main thread.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
  const result = await bridge.officeConvertLegacy({
    dataUrl,
    filename: file.name,
    format: ext as 'doc' | 'xls' | 'ppt',
  })
  // Materialise the converted data URL back into a File the worker
  // can structured-clone.
  const commaIdx = result.dataUrl.indexOf(',')
  const b64 = commaIdx >= 0 ? result.dataUrl.slice(commaIdx + 1) : result.dataUrl
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], result.filename, { type: result.mimeType })
}

export async function processFileInWorker(file: File): Promise<ProcessedFile> {
  const tCallStart = performance.now()
  // Resolve legacy Office on the main thread first; worker only ever
  // sees a modern OOXML file from this point on.
  const ready = await maybeConvertLegacy(file)
  const worker = getWorker()
  if (!worker) {
    console.warn(
      `[trace] processFileInWorker FALLBACK to main thread: ${ready.name}`,
    )
    const { processFile } = await import('./extract')
    const result = await processFile(ready)
    console.info(
      `[trace] main-thread processFile done: ${ready.name} in ${(performance.now() - tCallStart).toFixed(0)}ms`,
    )
    return result
  }
  console.info(
    `[trace] processFileInWorker post: ${ready.name} (${ready.size} bytes) @${tCallStart.toFixed(0)}ms`,
  )
  const id = newId()
  return new Promise<ProcessedFile>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => {
        console.info(
          `[trace] processFileInWorker reply: ${ready.name} round-trip ${(performance.now() - tCallStart).toFixed(0)}ms`,
        )
        resolve(v)
      },
      reject,
    })
    worker.postMessage({ id, file: ready })
  })
}
