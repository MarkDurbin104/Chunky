import * as matchers from '@testing-library/jest-dom/matchers'
import { expect, vi, beforeEach } from 'vitest'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

// `@testing-library/jest-dom/vitest` is the canonical entry-point but conflicts
// with vitest 1.6.1 + `globals: true` over `expect.testPath`. The manual extend
// below is what `/vitest` does internally and avoids the property-redefine
// collision; revisit once we upgrade past vitest 1.6.
expect.extend(matchers)

// jsdom polyfills required by tldraw and other browser-API consumers.
if (typeof HTMLImageElement !== 'undefined' && !HTMLImageElement.prototype.decode) {
  HTMLImageElement.prototype.decode = function () {
    return Promise.resolve()
  }
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// tldraw cannot render under jsdom (it depends on canvas, ResizeObserver
// internals, and asset decoders the polyfills above only partially cover).
// Mock it with a minimal stub so Canvas-wrapper unit tests can assert on
// the wrapper's own behavior. End-to-end tldraw rendering is covered by
// browser-based integration tests, not vitest.
vi.mock('tldraw', async () => {
  const React = await import('react')
  type Listener = () => void
  const makeStore = () => {
    const listeners = new Set<Listener>()
    return {
      listeners,
      // tldraw v3 store.listen returns an unsubscribe fn. Canvas.tsx calls
      // this on mount — without it the component throws and every Canvas
      // test fails before the assertion runs.
      listen: (cb: Listener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      mergeRemoteChanges: () => {},
      put: () => {},
    }
  }
  const fakeEditor = {
    store: makeStore(),
    on: (_event: string, _cb: Listener) => {},
    off: () => {},
    createAssets: () => {},
    createShape: () => {},
    getCurrentPageShapes: () => [],
    getCurrentPageShapeIds: () => new Set<string>(),
    toImage: async () => ({ blob: new Blob(), width: 0, height: 0 }),
    zoomToFit: () => {},
  }
  return {
    Tldraw: ({ onMount }: { onMount?: (editor: typeof fakeEditor) => void }) => {
      React.useEffect(() => {
        onMount?.(fakeEditor)
      }, [])
      return React.createElement(
        'div',
        { className: 'tldraw' },
        React.createElement('div', { className: 'tldraw__editor' })
      )
    },
    TldrawEditor: class {},
    TldrawEditorConfig: class {},
    defaultShapeUtils: [],
    // tldraw v3 getSnapshot shape: {document: {store, schema}, session}.
    // Canvas.tsx accesses `.document.store` directly in one branch.
    getSnapshot: () => ({
      document: { store: {}, schema: {} },
      session: {},
    }),
    loadSnapshot: () => {},
    BaseBoxShapeUtil: class {},
    ShapeUtil: class {},
    DefaultColorStyle: { id: 'color', defaultValue: 'black' },
    SizeStyle: { id: 'size', defaultValue: 'm' },
    getDefaultColorTheme: () => ({ background: '#fff', text: '#000' }),
    HTMLContainer: ({ children }: { children?: unknown }) =>
      React.createElement('div', null, children as never),
    AssetRecordType: { createId: (s: string) => `asset:${s}` },
    createShapeId: () => 'shape:test',
    getHashForString: (s: string) => s,
  }
})

// Tauri 2 ships `@tauri-apps/api/mocks` for exactly this case. `mockIPC`
// installs a fake `__TAURI_INTERNALS__` on `window` so the real
// `@tauri-apps/api/event` module loads cleanly under jsdom; tests can drive
// `listen()` callbacks via `emit()` from the same import. Per-test state is
// reset in beforeEach so suites can override the handler when needed.
beforeEach(() => {
  clearMocks()
  mockIPC(() => undefined, { shouldMockEvents: true })
})
