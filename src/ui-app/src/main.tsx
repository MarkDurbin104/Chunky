import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Surface any module-load / first-render errors directly in the page so we
// can see them without devtools (Tauri 2 doesn't auto-open the inspector).
function showFatal(reason: unknown) {
  const root = document.getElementById('root')
  if (!root) return
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  const stack = reason instanceof Error ? reason.stack ?? '(no stack)' : ''
  root.innerHTML = `
    <div style="padding:1.5rem;font-family:system-ui,sans-serif">
      <h1 style="color:#c33;margin:0 0 0.5rem">App failed to start</h1>
      <pre style="white-space:pre-wrap;background:#fbecec;padding:0.75rem;border:1px solid #c33;border-radius:6px;font-size:0.85rem">${message}\n\n${stack}</pre>
    </div>
  `
}

/**
 * Filter out known-benign window-level error events that aren't
 * actually fatal. Chromium surfaces some warnings as `error` events
 * for diagnostics — wiping the page for these is wildly
 * disproportionate and locks the user out of the app entirely.
 *
 * Currently filtered:
 *   - `ResizeObserver loop completed with undelivered notifications`
 *   - `ResizeObserver loop limit exceeded` (the older variant)
 *
 * Both fire when a ResizeObserver callback causes another size
 * change in the same frame. BlockNote + our splitter trip this
 * routinely on resize. They are NOT crashes — DOM, React, and
 * ProseMirror all keep working.
 */
function isBenignResizeObserverWarning(reason: unknown): boolean {
  const msg =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : ''
  return /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i.test(
    msg,
  )
}

window.addEventListener('error', (e) => {
  const reason = e.error ?? e.message
  if (isBenignResizeObserverWarning(reason)) {
    // Suppress the browser's default behaviour (don't print the
    // ugly noisy stack in the console either — it confuses users
    // who do open devtools).
    e.preventDefault()
    return
  }
  showFatal(reason)
})
window.addEventListener('unhandledrejection', (e) => {
  if (isBenignResizeObserverWarning(e.reason)) {
    e.preventDefault()
    return
  }
  showFatal(e.reason)
})

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} catch (err) {
  showFatal(err)
}
