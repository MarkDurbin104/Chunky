import type { ThemeMode } from './llm-config'

const THEME_KEY = 'chunky-theme'

/**
 * The mode the user picked. 'auto' means follow the OS via
 * prefers-color-scheme; 'light' and 'dark' are explicit overrides.
 *
 * Applied by writing `data-theme="<mode>"` on <html>; the design tokens
 * in src/styles/theme.css branch off that attribute.
 */
export type { ThemeMode } from './llm-config'

/** Resolved theme — what the page actually paints right now. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * Apply the chosen mode to the document root and remember it in
 * localStorage so the next mount can paint the right theme without
 * waiting for `loadSettings()` to come back.
 */
export const THEME_CHANGE_EVENT = 'chunky-theme-change'

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', mode)
  // Mantine (and `@blocknote/mantine`, which the BlockNote editor uses)
  // reads `data-mantine-color-scheme` on <html> for its own theming —
  // not our `data-theme`. It only understands `light` | `dark`, so we
  // resolve `auto` to the OS preference here. Without this attribute
  // the BlockNote editor stays light even when our `data-theme="dark"`
  // is set on the same element.
  const mantineResolved: 'light' | 'dark' =
    mode === 'auto'
      ? typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode
  document.documentElement.setAttribute(
    'data-mantine-color-scheme',
    mantineResolved,
  )
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* storage disabled — non-fatal */
  }
  // Same-tab signal — `storage` events don't fire in the tab that
  // wrote the value. Components that need to react in real time
  // (BlockNoteView's theme prop) listen for this event instead.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode } }),
    )
  }
}

/**
 * Read whatever theme was last applied (from localStorage) so the very
 * first render paints the right colours instead of flashing the default
 * while settings.json loads.
 */
export function readPersistedTheme(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'auto'
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    /* fall through */
  }
  return 'auto'
}

/**
 * Resolve the mode against the OS for `auto`. Returns the actual
 * light/dark value the page will paint with.
 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/**
 * Subscribe to OS color-scheme changes. Calls `cb(resolvedTheme)` only
 * when the current mode is 'auto' — explicit modes don't follow the OS.
 * Returns an unsubscribe function.
 */
export function watchOsScheme(
  getMode: () => ThemeMode,
  cb: (resolved: ResolvedTheme) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (getMode() === 'auto') {
      cb(mql.matches ? 'dark' : 'light')
    }
  }
  // `addEventListener('change', ...)` is the modern API; `addListener`
  // is the legacy form. We use the modern one — Tauri's webview is
  // recent enough to support it.
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
