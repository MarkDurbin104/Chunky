// Background work queue for long-running data updates.
//
// Why this exists: post-save metadata extraction (`summariseAndAttach`)
// and the on-mount summary backfill both shell out to the LLM CLI
// sidecar, which is single-channel — two concurrent calls just queue
// inside the host. Calling them fire-and-forget from every save site
// also leaves the user with no visibility into what's happening,
// and racing two extractions of the same node clobbers the
// `summaryGeneratedAtUtc` marker order. A central serial queue gives
// us one place to observe progress, dedupe by `dedupeKey`, and surface
// state via a single status bar.
//
// Observability: subscribe via `subscribeWorkQueue` or the
// `useWorkQueueState` React hook. State updates are coalesced to the
// next microtask so a burst of enqueue/finish events renders once.

export interface WorkTask {
  /** Stable id used by React keys and the dedupe map. Generated if not
   *  supplied by the caller. */
  id: string
  /** Short human-readable label shown in the status bar. Keep it under
   *  ~60 chars so it doesn't wrap the bar. */
  label: string
  /** Optional dedupe key — enqueueing a task with a key already in the
   *  pending list (or currently active) is a no-op. Used so saves that
   *  fire summariseAndAttach repeatedly for the same node collapse to
   *  one outstanding extraction. */
  dedupeKey?: string
  /** Returns a promise that resolves when the task is done. Throwing
   *  is fine — the queue logs and moves on. */
  run: () => Promise<void>
  /** Hard wall-clock cap. When exceeded, the queue marks the task
   *  failed and moves on so a hung LLM / COM call can't permanently
   *  block the queue. Defaults to {@link DEFAULT_TASK_TIMEOUT_MS}. */
  maxDurationMs?: number
}

/** Default upper bound for any single queued task. 6 minutes is
 *  comfortably above the longest legitimate task (5-min llm_query
 *  timeout in Rust) so well-behaved tasks always complete before this
 *  fires. */
const DEFAULT_TASK_TIMEOUT_MS = 360_000

export interface WorkQueueState {
  active: {
    id: string
    label: string
    /** Wall-clock ms since the task started running. */
    elapsedMs: number
  } | null
  /** Labels of tasks currently waiting their turn, in queue order.
   *  Surfaces in the debug panel so you can see why the queue isn't
   *  draining. */
  pendingLabels: string[]
  pending: number
  /** Most recent finished tasks, newest first. Kept short so the UI
   *  doesn't grow unbounded. */
  recent: {
    id: string
    label: string
    status: 'ok' | 'failed'
    /** First line of the error message when status === 'failed'.
     *  Surfaced in the debug panel so you don't have to open DevTools
     *  to see why a task failed. */
    errorMessage?: string
    durationMs?: number
  }[]
  /** Lifetime totals since app start. Drive a "processed N today"
   *  counter or similar. */
  totalProcessed: number
  totalFailed: number
  /** One-shot flash message for transient confirmations that aren't
   *  really queued work (e.g. "Exported foo.md to Downloads/"). The
   *  StatusBar shows this in place of the idle text until the timeout
   *  expires or another flash overwrites it. */
  flash: { kind: 'info' | 'warn'; message: string } | null
}

type Listener = (s: WorkQueueState) => void

const RECENT_LIMIT = 5

const queue: WorkTask[] = []
const dedupe = new Set<string>()
let active: WorkTask | null = null
/** Wall-clock start of the currently-active task, used for the
 *  elapsed-time readout. */
let activeStartedAt = 0
let recent: WorkQueueState['recent'] = []
let totalProcessed = 0
let totalFailed = 0
const listeners = new Set<Listener>()

let notifyScheduled = false

function snapshot(): WorkQueueState {
  return {
    active: active
      ? {
          id: active.id,
          label: active.label,
          elapsedMs: activeStartedAt > 0 ? Date.now() - activeStartedAt : 0,
        }
      : null,
    pending: queue.length,
    pendingLabels: queue.map((t) => t.label),
    recent,
    totalProcessed,
    totalFailed,
    flash,
  }
}

/**
 * Post a one-shot status-bar flash. Use for transient confirmations
 * ("✓ Exported foo.md to Downloads/") that don't represent queued
 * work. Auto-clears after `timeoutMs` (default 6s). Calling again
 * before the timeout fires replaces the previous message and resets
 * the timer.
 */
export function flashStatusBar(
  message: string,
  opts: { kind?: 'info' | 'warn'; timeoutMs?: number } = {},
): void {
  flash = { kind: opts.kind ?? 'info', message }
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash = null
    flashTimer = null
    notify()
  }, opts.timeoutMs ?? 6000)
  notify()
}

let flash: WorkQueueState['flash'] = null
let flashTimer: ReturnType<typeof setTimeout> | null = null

let cachedSnapshot: WorkQueueState = snapshot()

function notify() {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicrotask(() => {
    notifyScheduled = false
    cachedSnapshot = snapshot()
    for (const l of listeners) l(cachedSnapshot)
  })
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `wq-${crypto.randomUUID()}`
  }
  return `wq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** When set, the active task should treat itself as cancelled — the
 *  queue advances regardless of whether `run()` resolves. The active
 *  promise can keep running in the background (we can't abort it),
 *  but its eventual resolve/reject is ignored. Set by
 *  {@link skipActiveTask} or the per-task watchdog. */
let activeAbortReason: 'timeout' | 'manual' | null = null

let pumping = false
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const next = queue.shift()!
      active = next
      activeStartedAt = Date.now()
      activeAbortReason = null
      notify()
      const cap = next.maxDurationMs ?? DEFAULT_TASK_TIMEOUT_MS
      // Race the task against (a) its own timeout, (b) a manual skip
      // signal. Both branches resolve the timeoutPromise to 'timeout';
      // the manual case is distinguished by `activeAbortReason`.
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      let pollHandle: ReturnType<typeof setInterval> | null = null
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), cap)
        pollHandle = setInterval(() => {
          if (activeAbortReason === 'manual') resolve('timeout')
        }, 200)
      })
      let outcome: 'ok' | 'timeout' | 'fail' = 'ok'
      let err: unknown = null
      try {
        const winner = await Promise.race([
          next.run().then(() => 'done' as const),
          timeoutPromise,
        ])
        if (winner === 'timeout') {
          outcome = 'timeout'
        }
      } catch (e) {
        outcome = 'fail'
        err = e
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle)
        if (pollHandle !== null) clearInterval(pollHandle)
      }
      const durationMs = Date.now() - activeStartedAt
      if (outcome === 'ok') {
        totalProcessed += 1
        recent = [
          { id: next.id, label: next.label, status: 'ok', durationMs },
          ...recent,
        ].slice(0, RECENT_LIMIT)
      } else if (outcome === 'timeout') {
        totalFailed += 1
        const reason = activeAbortReason === 'manual' ? 'skipped' : 'timed out'
        recent = [
          {
            id: next.id,
            label: `${next.label} (${reason})`,
            status: 'failed',
            errorMessage: `${reason} after ${cap}ms`,
            durationMs,
          },
          ...recent,
        ].slice(0, RECENT_LIMIT)
        console.warn(
          `[work-queue] task ${reason} after ${cap}ms:`,
          next.label,
        )
      } else {
        totalFailed += 1
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'unknown error'
        recent = [
          {
            id: next.id,
            label: next.label,
            status: 'failed',
            errorMessage: message.slice(0, 240),
            durationMs,
          },
          ...recent,
        ].slice(0, RECENT_LIMIT)
        console.warn('[work-queue] task failed:', next.label, err)
      }
      if (next.dedupeKey) dedupe.delete(next.dedupeKey)
      active = null
      activeStartedAt = 0
      activeAbortReason = null
      notify()
    }
  } finally {
    pumping = false
  }
}

/**
 * Force the currently-running task to be treated as failed and
 * advance the queue. The underlying promise keeps running in the
 * background — we can't abort an arbitrary `Promise` — but its
 * eventual outcome is ignored. Used by the status-bar "skip"
 * button when an LLM call or external process visibly hangs.
 *
 * No-op when nothing's running.
 */
export function skipActiveTask(): void {
  if (!active) return
  console.warn('[work-queue] manual skip requested for:', active.label)
  activeAbortReason = 'manual'
}

/**
 * Live wall-clock elapsed-ms of the active task, or `0` when nothing
 * is running. Callers can poll this from a 1s interval to render a
 * ticking clock — the cached snapshot doesn't tick between notify()
 * events, so it's worth reading direct.
 */
export function getActiveElapsedMs(): number {
  return active && activeStartedAt > 0 ? Date.now() - activeStartedAt : 0
}

/**
 * Enqueue a task. Returns the task id (so callers can correlate
 * subsequent state changes). If `dedupeKey` matches a task already
 * pending or running, the new task is dropped and the existing id is
 * returned instead.
 */
export function enqueueWorkTask(input: Omit<WorkTask, 'id'> & { id?: string }): string {
  if (input.dedupeKey && dedupe.has(input.dedupeKey)) {
    // Find the existing task id so the caller can correlate.
    if (active && active.dedupeKey === input.dedupeKey) return active.id
    const existing = queue.find((t) => t.dedupeKey === input.dedupeKey)
    if (existing) return existing.id
    // Race — `dedupe.has` was true but the matching task has
    // finished between the check and now. Fall through and enqueue
    // normally.
  }
  const task: WorkTask = {
    id: input.id ?? genId(),
    label: input.label,
    dedupeKey: input.dedupeKey,
    run: input.run,
    ...(input.maxDurationMs !== undefined
      ? { maxDurationMs: input.maxDurationMs }
      : {}),
  }
  if (task.dedupeKey) dedupe.add(task.dedupeKey)
  queue.push(task)
  notify()
  // Fire the pump but don't block the caller — pump() is async and
  // returns when the queue drains.
  void pump()
  return task.id
}

/**
 * Result-returning variant of `enqueueWorkTask`. The promise resolves
 * (or rejects) with whatever `run()` returned, after the queue has
 * served the task. Use this for foreground work the caller needs the
 * value from (e.g. file extraction) so the status bar still shows
 * what's happening — the per-task label is committed to the store
 * before `run()` fires, so even a CPU-bound run that blocks the main
 * thread for several seconds gets its label visible first.
 *
 * Tasks enqueued through this helper are NOT deduped (each call is
 * its own promise the caller needs back), so don't use it for
 * idempotent background passes — use `enqueueWorkTask` for those.
 */
export function runOnWorkQueue<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueueWorkTask({
      label,
      run: async () => {
        console.error(`[trace] queue task START: ${label}`)
        try {
          const v = await run()
          console.error(`[trace] queue task INNER DONE: ${label}`)
          resolve(v)
          console.error(`[trace] queue task RESOLVED: ${label}`)
        } catch (e) {
          console.error(`[trace] queue task FAILED: ${label}`, e)
          reject(e)
          throw e
        }
      },
    })
  })
}

export function subscribeWorkQueue(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getWorkQueueState(): WorkQueueState {
  return cachedSnapshot
}
