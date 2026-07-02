/**
 * Per-node serialising save queue.
 *
 * Problem: the home-page editor's auto-save is fire-and-forget on the
 * generic work queue. When the user edits doc A, switches to Epics,
 * then switches back to A, the load effect calls `bridge.readNode(A)`
 * which races with the pending in-flight upsert from the auto-save
 * tick. If the read wins, the editor re-loads pre-edit content and
 * the next auto-save tick writes that stale content back to disk —
 * effectively reverting the user's edits.
 *
 * The fix: route every persist through this queue. Writes for the
 * same node id are serialised (no two upserts in flight), and any
 * pending coalesces to the latest payload. Readers can call
 * `waitForDrain(id)` before issuing a `readNode` to guarantee they
 * see the latest persisted state.
 *
 * Coalescing rationale: if six edits happen back-to-back during a
 * single 5s window, we only need to persist the final payload —
 * earlier ones are obsolete. Queueing all six and serialising them
 * just delays the user-visible "saved" state without any data benefit.
 */

export type SaveOp = () => Promise<void>

interface Slot {
  /** Currently-running op for this id, if any. */
  running: Promise<void> | null
  /** Pending op queued to run after `running` completes. */
  pending: SaveOp | null
  /** Resolvers for callers awaiting `waitForDrain` against this id. */
  drainWaiters: Array<() => void>
}

const slots = new Map<string, Slot>()

function getOrCreate(id: string): Slot {
  let slot = slots.get(id)
  if (!slot) {
    slot = { running: null, pending: null, drainWaiters: [] }
    slots.set(id, slot)
  }
  return slot
}

function notifyDrained(id: string) {
  const slot = slots.get(id)
  if (!slot) return
  if (slot.running !== null) return
  if (slot.pending !== null) return
  const waiters = slot.drainWaiters
  slot.drainWaiters = []
  for (const w of waiters) {
    try { w() } catch { /* swallow */ }
  }
  // Clean up the slot once nobody is waiting and nothing is pending.
  if (slot.drainWaiters.length === 0) slots.delete(id)
}

async function runChain(id: string) {
  const slot = slots.get(id)
  if (!slot) return
  while (slot.pending !== null) {
    const op = slot.pending
    slot.pending = null
    slot.running = (async () => {
      try {
        await op()
      } catch (e) {
        // Surface to console — caller already cleared dirty
        // optimistically, so swallowing here would silently drop
        // writes. The next dirty edit re-enqueues anyway.
        console.error(`[save-queue] op failed for ${id}:`, e)
      }
    })()
    try {
      await slot.running
    } finally {
      slot.running = null
    }
  }
  notifyDrained(id)
}

/**
 * Enqueue a save op for `id`. If another op is already queued (not
 * running), it is replaced by `op` (coalesce-to-latest). If one is
 * currently running, `op` waits behind it. Returns immediately.
 */
export function enqueueSave(id: string, op: SaveOp): void {
  const slot = getOrCreate(id)
  // Coalesce: keep only the latest pending op. The prior pending op
  // hadn't started, so dropping it loses nothing — the new op carries
  // the freshest payload.
  slot.pending = op
  if (slot.running === null) {
    // No active chain; kick one off. runChain is async; we don't
    // await it here so the caller returns immediately.
    void runChain(id)
  }
  // If a chain is already running, it will pick up `pending` after
  // the current op finishes (the while-loop in runChain).
}

/**
 * Resolve when the queue for `id` has no running or pending op.
 * Callers (e.g. the editor's load effect) should `await` this before
 * issuing `readNode(id)` to avoid reading stale disk content while a
 * write is in flight.
 */
export function waitForDrain(id: string): Promise<void> {
  const slot = slots.get(id)
  if (!slot || (slot.running === null && slot.pending === null)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    slot.drainWaiters.push(resolve)
  })
}

/**
 * Test-only helper. Returns the count of nodes that have either a
 * running or pending op. Used by unit tests to assert the queue
 * drained correctly.
 */
export function _activeSlotCount(): number {
  return slots.size
}
