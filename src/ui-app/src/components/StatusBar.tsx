import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getActiveElapsedMs,
  getWorkQueueState,
  subscribeWorkQueue,
  skipActiveTask,
} from '../lib/work-queue'

/**
 * Slim status bar that lives at the bottom of the app and surfaces
 * the background work queue. Shows the currently-running task's label
 * plus elapsed time, the count of queued tasks (with a click-to-expand
 * list of their labels), and the most recent failure with its error
 * message — all visible in-app without needing DevTools.
 */
export function StatusBar() {
  const state = useSyncExternalStore(
    subscribeWorkQueue,
    getWorkQueueState,
    getWorkQueueState,
  )
  // Tick once a second so the active task's elapsed-time readout
  // moves. The queue itself only re-notifies on enqueue/finish, so
  // without this the elapsed value freezes between events.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!state.active) return
    const handle = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(handle)
  }, [state.active])

  const [expanded, setExpanded] = useState(false)

  const idle = !state.active && state.pending === 0
  const showRecent = idle && state.recent.length > 0
  const lastFailed = state.recent.find((r) => r.status === 'failed')

  // Read elapsed live from the queue, not from the cached snapshot —
  // the snapshot is frozen between notify() events, so without this
  // the "X seconds" reading would only update on enqueue/finish.
  const elapsedDisplay = state.active ? formatElapsed(getActiveElapsedMs()) : ''

  return (
    <div className="app-status-bar" role="status" aria-live="polite">
      {state.active ? (
        <span className="app-status-bar__active">
          <span className="app-status-bar__spinner" aria-hidden="true" />
          <span className="app-status-bar__label">{state.active.label}</span>
          <span
            style={{
              marginLeft: '0.4rem',
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {elapsedDisplay}
          </span>
          {state.pending > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              style={{
                marginLeft: '0.4rem',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontSize: '0.72rem',
              }}
              title="Show queued task labels"
            >
              · {state.pending} more queued {expanded ? '▾' : '▸'}
            </button>
          )}
          <button
            type="button"
            onClick={skipActiveTask}
            title="Skip the active task and advance the queue. Use when an LLM call or external process visibly hangs."
            aria-label="Skip active task"
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              padding: '0.05rem 0.4rem',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: '0.72rem',
              lineHeight: 1.4,
            }}
          >
            skip
          </button>
        </span>
      ) : state.flash ? (
        <span
          className={
            state.flash.kind === 'warn'
              ? 'app-status-bar__warn'
              : 'app-status-bar__flash'
          }
        >
          {state.flash.message}
        </span>
      ) : showRecent ? (
        <span className="app-status-bar__idle">
          Idle · processed {state.totalProcessed}
          {state.totalFailed > 0 ? ` · ${state.totalFailed} failed` : ''}
        </span>
      ) : (
        <span className="app-status-bar__idle">Idle</span>
      )}
      {lastFailed && (
        <span
          className="app-status-bar__warn"
          title={lastFailed.errorMessage ?? `Last failure: ${lastFailed.label}`}
          style={{ marginLeft: '0.5rem' }}
        >
          ⚠ {lastFailed.label}
          {lastFailed.errorMessage ? `: ${lastFailed.errorMessage}` : ''}
        </span>
      )}
      {expanded && state.pendingLabels.length > 0 && (
        <div
          role="region"
          aria-label="Queued tasks"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '0.5rem',
            maxWidth: '60ch',
            maxHeight: '12rem',
            overflowY: 'auto',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-default)',
            borderRadius: 4,
            padding: '0.4rem 0.6rem',
            fontSize: '0.78rem',
            color: 'var(--text-primary)',
            zIndex: 50,
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
          }}
        >
          <div
            style={{
              fontSize: '0.7rem',
              color: 'var(--text-muted)',
              marginBottom: '0.3rem',
            }}
          >
            Queued ({state.pendingLabels.length}) — first up next:
          </div>
          <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {state.pendingLabels.slice(0, 20).map((label, i) => (
              <li key={`${i}-${label}`} style={{ margin: '0.15rem 0' }}>
                {label}
              </li>
            ))}
            {state.pendingLabels.length > 20 && (
              <li
                style={{ color: 'var(--text-muted)', listStyle: 'none' }}
              >
                …and {state.pendingLabels.length - 20} more
              </li>
            )}
          </ol>
        </div>
      )}
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return `${m}m${rs.toString().padStart(2, '0')}s`
}

export default StatusBar
