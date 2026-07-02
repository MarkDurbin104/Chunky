import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { Block, PartialBlock } from '@blocknote/core'
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  createHeadingBlockSpec,
} from '@blocknote/core'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import './BlockNoteEditor.css'
import { ErrorBoundary } from '../ErrorBoundary'
import {
  readPersistedTheme,
  resolveTheme,
  watchOsScheme,
  THEME_CHANGE_EVENT,
  type ResolvedTheme,
  type ThemeMode,
} from '../../lib/theme'

/**
 * Track the current resolved theme (light/dark) so BlockNoteView's
 * `theme` prop stays in sync with the rest of the app. Reads the
 * persisted mode from localStorage (so we paint correctly on first
 * render) and listens for both explicit mode changes (storage event)
 * and OS scheme changes (when mode is 'auto').
 */
function useResolvedTheme(): ResolvedTheme {
  const [mode, setMode] = useState<ThemeMode>(() => readPersistedTheme())
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readPersistedTheme()),
  )

  useEffect(() => {
    // Cross-tab updates via storage event.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'chunky-theme' && e.newValue) {
        const v = e.newValue as ThemeMode
        if (v === 'light' || v === 'dark' || v === 'auto') {
          setMode(v)
          setResolved(resolveTheme(v))
        }
      }
    }
    // Same-tab updates via the custom event applyTheme dispatches.
    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: ThemeMode }>).detail
      if (!detail) return
      const v = detail.mode
      if (v === 'light' || v === 'dark' || v === 'auto') {
        setMode(v)
        setResolved(resolveTheme(v))
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange as EventListener)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(
        THEME_CHANGE_EVENT,
        onThemeChange as EventListener,
      )
    }
  }, [])

  useEffect(() => {
    setResolved(resolveTheme(mode))
    return watchOsScheme(
      () => mode,
      (r) => setResolved(r),
    )
  }, [mode])

  return resolved
}

export interface BlockNoteEditorHandle {
  /** Append plain-text paragraphs to the end of the document. */
  appendParagraphs: (paragraphs: string[]) => void
  /** Append a styled callout/header (used for file-attach markers). */
  appendHeader: (text: string) => void
  /** Append an image block referencing a URL (data URL or remote). */
  appendImage: (url: string, caption?: string) => void
  /**
   * Append a collapsible per-file toggle-heading inside a single outer
   * "Attachments" toggle-heading. The outer heading is auto-created on the
   * first call and reused on subsequent calls. Result: one collapsible
   * Attachments section that contains a collapsible block per file.
   */
  appendAttachmentSection: (args: {
    title: string
    children: PartialBlock[]
  }) => void
  /**
   * Splice one or more blocks immediately after the block with `targetId`.
   * Used by async image-text-extraction to attach extracted text once the
   * LLM returns. Returns true if the target was found and blocks inserted.
   */
  insertAfterBlockId: (targetId: string, blocks: PartialBlock[]) => boolean
  /**
   * Insert blocks at the current text cursor position (D-018 drag-drop).
   * Falls back to appending at the end if the editor has no cursor yet.
   */
  insertAtCursor: (blocks: PartialBlock[]) => void
  /**
   * Insert blocks at the document position under the client-space
   * coordinates `(clientX, clientY)`. Used by the drag-drop handler
   * so a drop lands where the user pointed instead of at the text
   * cursor (which may still be on block 0 from when the editor
   * mounted, even though the user dragged onto block 5). Falls
   * back to `insertAtCursor` when the coords don't resolve to a
   * BlockNote block (e.g. drop landed in editor chrome, outside
   * the ProseMirror surface).
   */
  insertAtCoords: (
    blocks: PartialBlock[],
    clientX: number,
    clientY: number,
  ) => void
  /** Move keyboard focus into the editor surface. */
  focus: () => void
  /**
   * Render the current document as markdown. Uses BlockNote's
   * `blocksToMarkdownLossy` — image blocks become `![]()` references
   * (data-URL bodies are preserved verbatim, which is huge but
   * faithful), tables render as GFM tables, toggleable headings
   * lose their fold state but keep the heading + body order.
   *
   * `stripImageCaptions`: when true, returns the markdown with the
   * image alt text emptied (`![caption](url)` → `![](url)`) AND any
   * paragraph immediately following the image that matches the
   * image's recorded caption removed. BlockNote v0.50 emits the
   * caption as an inline-paragraph that follows the image's
   * `![](url)` line, so we look it up via the editor's caption map
   * instead of guessing structurally.
   */
  getMarkdown: (opts?: { stripImageCaptions?: boolean }) => Promise<string>
  /**
   * Block id under the text cursor, or `null` when the editor has no
   * cursor (e.g. unfocused, no selection). Used by the slash-command
   * prompt builder to walk up to the nearest heading and pull its
   * `sectionPurpose` / `sectionStyleHint` into the prompt context.
   */
  getCursorBlockId: () => string | null
  /**
   * Render a visible drop indicator at the block + side that a drop
   * at `(clientX, clientY)` would land on. The indicator is a
   * horizontal line spanning the target block's width, aligned to
   * its top edge for "before" drops and bottom edge for "after"
   * drops. Idempotent: repeated calls at the same resolved position
   * do not re-render. Call `hideDropIndicator` on drop / dragleave.
   */
  showDropIndicatorAt: (clientX: number, clientY: number) => void
  /** Clear the drop indicator. Safe to call when none is showing. */
  hideDropIndicator: () => void
  undo: () => void
  redo: () => void
}

interface BlockNoteEditorProps {
  value?: Block[]
  onChange?: (blocks: Block[]) => void
  placeholder?: string
  /** Read-only mode (used by ReferenceReader, future doc preview surfaces). */
  editable?: boolean
}

export const BlockNoteEditor = forwardRef<BlockNoteEditorHandle, BlockNoteEditorProps>(
  ({ value, onChange, placeholder: _placeholder, editable = true }, ref) => {
    // BlockNote requires `initialContent` to be undefined OR a non-empty array
    // of partial blocks. An empty array crashes the editor at construction.
    const initialContent: PartialBlock[] | undefined =
      value && value.length > 0 ? (value as PartialBlock[]) : undefined

    // Custom schema: replaces the default heading spec with one that allows
    // toggleable headings. With this on, every heading gets a chevron that
    // folds everything under it until the next same-or-higher-level heading.
    // Memoised so the schema instance is stable across renders.
    const schema = useMemo(
      () =>
        BlockNoteSchema.create({
          blockSpecs: {
            ...defaultBlockSpecs,
            heading: createHeadingBlockSpec({ allowToggleHeadings: true }),
          },
        }),
      [],
    )

    const editor = useCreateBlockNote({ schema, initialContent })
    const resolvedTheme = useResolvedTheme()
    const containerRef = useRef<HTMLDivElement>(null)
    const [dropIndicator, setDropIndicator] = useState<{
      top: number
      left: number
      width: number
    } | null>(null)

    // Shared coord-resolver used by BOTH the drop indicator and the
    // actual insert. Same fallbacks as before — primary path uses
    // ProseMirror's posAtCoords + walk-up to nearest block-with-id;
    // when the cursor lands in editor whitespace (between blocks,
    // above the first block, below the last), pick the closest
    // visible block by Y so the indicator and the insert agree.
    const resolveDropPlacement = (
      clientX: number,
      clientY: number,
    ): { blockId: string; rect: DOMRect; placement: 'before' | 'after' } | null => {
      try {
        const view = editor.prosemirrorView
        if (!view) return null
        const dom = view.dom as HTMLElement | undefined
        if (!dom) return null

        let blockId: string | null = null
        const resolved = view.posAtCoords({ left: clientX, top: clientY })
        if (resolved) {
          const $pos = view.state.doc.resolve(resolved.pos)
          for (let depth = $pos.depth; depth >= 0; depth--) {
            const node = $pos.node(depth)
            const id = (node.attrs as { id?: unknown } | undefined)?.id
            if (typeof id === 'string' && id.length > 0) {
              blockId = id
              break
            }
          }
        }

        let el: HTMLElement | null = null
        if (blockId) {
          el = dom.querySelector(
            `[data-id="${blockId}"]`,
          ) as HTMLElement | null
        }
        if (!el) {
          // Whitespace fallback: pick the closest visible block by Y.
          const all = Array.from(
            dom.querySelectorAll('[data-id]'),
          ) as HTMLElement[]
          if (all.length === 0) return null
          const firstRect = all[0].getBoundingClientRect()
          if (clientY < firstRect.top) {
            const id = all[0].dataset.id
            if (!id) return null
            return { blockId: id, rect: firstRect, placement: 'before' }
          }
          const lastRect = all[all.length - 1].getBoundingClientRect()
          if (clientY > lastRect.bottom) {
            const id = all[all.length - 1].dataset.id
            if (!id) return null
            return { blockId: id, rect: lastRect, placement: 'after' }
          }
          let best: { el: HTMLElement; rect: DOMRect; dist: number } | null = null
          for (const b of all) {
            const r = b.getBoundingClientRect()
            const mid = (r.top + r.bottom) / 2
            const dist = Math.abs(mid - clientY)
            if (!best || dist < best.dist) best = { el: b, rect: r, dist }
          }
          if (!best || !best.el.dataset.id) return null
          const placement: 'before' | 'after' =
            clientY < (best.rect.top + best.rect.bottom) / 2
              ? 'before'
              : 'after'
          return { blockId: best.el.dataset.id, rect: best.rect, placement }
        }
        const rect = el.getBoundingClientRect()
        const placement: 'before' | 'after' =
          clientY < (rect.top + rect.bottom) / 2 ? 'before' : 'after'
        return { blockId: blockId!, rect, placement }
      } catch {
        return null
      }
    }

    // BlockNote v0.50 exposes `editor.isEditable` as a writable property.
    // Toggle whenever the prop changes; `editor` itself is stable per mount
    // (useCreateBlockNote returns a memoised instance) so it's not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
      editor.isEditable = editable
    }, [editable])

    // Relocate BlockNote's floating-UI portal from <body> into this
    // editor's container. By default `BlockNoteEditor.mount` does
    // `document.body.appendChild(this.portalElement)`, which puts
    // every floating widget (table-handle row/column buttons, side
    // menu, formatting toolbar, slash menu) at the document root
    // — outside any of our overflow:hidden ancestors. The result
    // is that the table-handle widgets paint over the app header
    // when the table is near the top of the editor pane. Moving
    // the portal under `.blocknote-editor-container` (which has
    // `overflow: hidden` + relative position) clips them to the
    // editor pane the way users expect.
    //
    // Floating-UI positions popovers via `transform: translate()`
    // based on the reference's `getBoundingClientRect()`, so
    // moving the portal into a different DOM parent doesn't change
    // their on-screen position — it just changes which ancestor
    // chain clips them.
    useEffect(() => {
      const container = containerRef.current
      if (!container) return
      const portal = editor.portalElement
      if (!portal) return
      container.appendChild(portal)
      // No cleanup: when the editor unmounts it removes its own
      // portal via the unmount path; the appendChild we did just
      // re-parents it for the lifetime of THIS mount. Leaving it
      // in place after re-mount is fine because containerRef will
      // point at the new container by then.
    }, [editor])

    useImperativeHandle(
      ref,
      () => ({
        appendParagraphs: (paragraphs) => {
          if (!paragraphs.length) return
          const blocks: PartialBlock[] = paragraphs.map((p) => ({
            type: 'paragraph',
            content: p,
          }))
          const lastBlock = editor.document[editor.document.length - 1]
          if (lastBlock) {
            editor.insertBlocks(blocks, lastBlock, 'after')
          } else {
            editor.replaceBlocks(editor.document, blocks)
          }
        },
        appendHeader: (text) => {
          const block: PartialBlock = {
            type: 'heading',
            props: { level: 3 },
            content: text,
          }
          const lastBlock = editor.document[editor.document.length - 1]
          if (lastBlock) {
            editor.insertBlocks([block], lastBlock, 'after')
          } else {
            editor.replaceBlocks(editor.document, [block])
          }
        },
        appendImage: (url, caption) => {
          // BlockNote ships an `image` block with `url`, `caption`, and a
          // `previewWidth` prop. Caption is optional; the block renders the
          // image inline at its natural aspect ratio.
          const block: PartialBlock = {
            type: 'image',
            props: {
              url,
              caption: caption ?? '',
            },
          }
          const lastBlock = editor.document[editor.document.length - 1]
          if (lastBlock) {
            editor.insertBlocks([block], lastBlock, 'after')
          } else {
            editor.replaceBlocks(editor.document, [block])
          }
        },
        insertAfterBlockId: (targetId, blocks) => {
          if (!blocks || blocks.length === 0) return false
          // Walk the document tree (including children of toggle headings)
          // looking for the target id. BlockNote stores blocks in a
          // recursive tree; `editor.getBlock(id)` returns just the block,
          // so we use it for the existence check then call insertBlocks
          // with the looked-up block as the placement reference.
          const target = editor.getBlock(targetId)
          if (!target) return false
          editor.insertBlocks(blocks, target, 'after')
          return true
        },
        insertAtCursor: (blocks) => {
          if (!blocks || blocks.length === 0) return
          try {
            const pos = editor.getTextCursorPosition()
            if (pos?.block) {
              editor.insertBlocks(blocks, pos.block, 'after')
              return
            }
          } catch {
            // No cursor (editor not focused yet) — fall through.
          }
          const lastBlock = editor.document[editor.document.length - 1]
          if (lastBlock) {
            editor.insertBlocks(blocks, lastBlock, 'after')
          } else {
            editor.replaceBlocks(editor.document, blocks)
          }
        },
        insertAtCoords: (blocks, clientX, clientY) => {
          if (!blocks || blocks.length === 0) return
          const target = resolveDropPlacement(clientX, clientY)
          if (target) {
            const block = editor.getBlock(target.blockId)
            if (block) {
              editor.insertBlocks(blocks, block, target.placement)
              return
            }
          }
          try {
            const pos = editor.getTextCursorPosition()
            if (pos?.block) {
              editor.insertBlocks(blocks, pos.block, 'after')
              return
            }
          } catch {
            /* fall through */
          }
          const lastBlock = editor.document[editor.document.length - 1]
          if (lastBlock) {
            editor.insertBlocks(blocks, lastBlock, 'after')
          } else {
            editor.replaceBlocks(editor.document, blocks)
          }
        },
        showDropIndicatorAt: (clientX, clientY) => {
          const t = resolveDropPlacement(clientX, clientY)
          if (!t) {
            setDropIndicator((prev) => (prev === null ? prev : null))
            containerRef.current?.classList.remove('bn-drag-exclude')
            return
          }
          // Suppress BlockNote's built-in DropCursor extension (the
          // pale-blue/purple bar) while our own indicator is showing.
          // BlockNote walks up from the dragover target looking for
          // a `.bn-drag-exclude` ancestor and bails out when it finds
          // one. Toggling the class only during external drags leaves
          // internal block-reorder dragging unaffected.
          containerRef.current?.classList.add('bn-drag-exclude')
          const top = t.placement === 'before' ? t.rect.top : t.rect.bottom
          setDropIndicator((prev) => {
            if (
              prev &&
              prev.top === top &&
              prev.left === t.rect.left &&
              prev.width === t.rect.width
            ) {
              return prev
            }
            return { top, left: t.rect.left, width: t.rect.width }
          })
        },
        hideDropIndicator: () => {
          setDropIndicator((prev) => (prev === null ? prev : null))
          containerRef.current?.classList.remove('bn-drag-exclude')
        },
        focus: () => {
          try {
            editor.focus()
          } catch {
            /* ignore */
          }
        },
        undo: () => {
          try { editor._tiptapEditor.commands.undo() } catch { /* ignore */ }
        },
        redo: () => {
          try { editor._tiptapEditor.commands.redo() } catch { /* ignore */ }
        },
        getMarkdown: async (opts) => {
          // BlockNote's exporter walks the supplied document and emits
          // GFM-flavoured markdown. We pass the live `editor.document`
          // straight through (cloning the tree to wipe captions
          // broke image emission — `blocksToMarkdownLossy` relies on
          // block identity for image src/alt resolution).
          const md = await editor.blocksToMarkdownLossy(editor.document)
          if (!opts?.stripImageCaptions) return md

          // Collect every image's recorded caption keyed by its url,
          // so we know which paragraph immediately following each
          // `![](url)` in the markdown is the caption (vs. a real
          // following paragraph the author wrote).
          const captionByUrl = new Map<string, string>()
          const walk = (blocks: readonly Block[]): void => {
            for (const b of blocks) {
              if (b.type === 'image') {
                const props =
                  (b as { props?: Record<string, unknown> }).props ?? {}
                const url =
                  typeof props.url === 'string' ? props.url : ''
                const caption =
                  typeof props.caption === 'string' ? props.caption : ''
                if (url && caption) captionByUrl.set(url, caption.trim())
              }
              const children = (b as { children?: Block[] }).children
              if (Array.isArray(children)) walk(children)
            }
          }
          walk(editor.document)

          // For every `![alt](url)` in the markdown:
          //   1. Empty the alt-text → `![](url)`.
          //   2. If the next non-blank line equals the recorded
          //      caption for that url (case- and whitespace-
          //      insensitive), drop that line (and any surrounding
          //      blank lines it leaves behind).
          const escapeRe = (s: string): string =>
            s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          // Match `![alt](url)` where url runs to the matching `)` —
          // BlockNote URL-encodes `)` inside data URLs (it doesn't
          // appear), so a non-greedy run up to the next `)` is safe.
          const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
          let out = ''
          let lastIdx = 0
          for (let m = imgRe.exec(md); m; m = imgRe.exec(md)) {
            const [full, , url] = m
            out += md.slice(lastIdx, m.index)
            out += `![](${url})`
            lastIdx = m.index + full.length
            // Scan forward for the caption line.
            const caption = captionByUrl.get(url) ?? ''
            if (!caption) continue
            const rest = md.slice(lastIdx)
            const next = rest.match(/^(\s*\n)+([^\n]*)/)
            if (!next) continue
            const candidate = next[2].trim()
            if (candidate.length === 0) continue
            if (candidate.toLowerCase() === caption.toLowerCase()) {
              // Skip past the blank-line run + the caption line.
              lastIdx += next[0].length
            }
          }
          out += md.slice(lastIdx)
          return out
        },
        getCursorBlockId: () => {
          try {
            const pos = editor.getTextCursorPosition()
            return pos?.block?.id ?? null
          } catch {
            return null
          }
        },
        appendAttachmentSection: ({ title, children }) => {
          // Stable id for the outer "Attachments" wrapper so we can find it
          // again on subsequent appends and attach more children.
          const ROOT_ID = 'attachments-root'

          // Per-file toggle-heading id. Pre-collapse via the localStorage
          // key BlockNote uses for toggle state.
          const childId =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? `attach-${crypto.randomUUID()}`
              : `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          try {
            window.localStorage.setItem(`toggle-${childId}`, 'false')
          } catch {
            // Non-fatal: section will render expanded if storage unavailable.
          }

          const tInsertStart = performance.now()
          console.info(
            `[trace] appendAttachmentSection: title="${title}" children=${children.length}`,
          )

          // Insert the toggle-heading WITHOUT children first, then append
          // children in batches asynchronously. ProseMirror's transaction
          // cost scales with tree size; inserting 1000+ paragraph nodes
          // in one shot blocks the main thread for tens of seconds. By
          // committing the heading immediately and chunking the children
          // through setTimeout(0) yields, the UI stays responsive — each
          // batch is ~50 blocks (~10–50ms of ProseMirror work) followed
          // by a paint opportunity. Pre-collapsed toggle keeps the
          // visible cost low while batches drain.
          const BATCH_SIZE = 50
          const childSectionEmpty: PartialBlock = {
            id: childId,
            type: 'heading',
            props: { level: 3, isToggleable: true },
            content: title,
            children: [],
          }

          const existingRoot = editor.document.find((b) => b.id === ROOT_ID)
          if (existingRoot) {
            // Append to the existing root's children. The full Block (with
            // children) is what `getBlock` returns; spread its children to
            // preserve everything that's already there.
            const fullRoot = editor.getBlock(ROOT_ID) ?? existingRoot
            const existingChildren = (fullRoot as { children?: PartialBlock[] }).children ?? []
            editor.updateBlock(fullRoot, {
              children: [...existingChildren, childSectionEmpty],
            })
          } else {
            // First attachment: create the outer "Attachments" toggle
            // heading and place the empty per-file section inside it.
            // Starts collapsed so the doc stays compact even with many
            // attachments.
            try {
              window.localStorage.setItem(`toggle-${ROOT_ID}`, 'false')
            } catch {
              // Non-fatal.
            }
            const root: PartialBlock = {
              id: ROOT_ID,
              type: 'heading',
              props: { level: 2, isToggleable: true },
              content: 'Attachments',
              children: [childSectionEmpty],
            }
            const lastBlock = editor.document[editor.document.length - 1]
            if (lastBlock) {
              editor.insertBlocks([root], lastBlock, 'after')
            } else {
              editor.replaceBlocks(editor.document, [root])
            }
          }

          if (children.length === 0) {
            console.info(
              `[trace] appendAttachmentSection committed (empty) in ${(performance.now() - tInsertStart).toFixed(0)}ms`,
            )
            return
          }

          // Drain the children in batches. Each tick yields to the
          // event loop so the UI can paint between batches and the
          // user can keep typing in the editor.
          let cursor = 0
          const pumpBatch = () => {
            const batchStart = performance.now()
            const slice = children.slice(cursor, cursor + BATCH_SIZE)
            const targetBlock = editor.getBlock(childId)
            if (!targetBlock) {
              console.warn(
                '[trace] appendAttachmentSection: target heading vanished mid-batch',
              )
              return
            }
            const existing = (targetBlock as { children?: PartialBlock[] }).children ?? []
            editor.updateBlock(targetBlock, {
              children: [...existing, ...slice],
            })
            cursor += slice.length
            console.info(
              `[trace] appendAttachmentSection batch ${cursor}/${children.length} in ${(performance.now() - batchStart).toFixed(0)}ms`,
            )
            if (cursor < children.length) {
              setTimeout(pumpBatch, 0)
            } else {
              console.info(
                `[trace] appendAttachmentSection committed all ${children.length} children in ${(performance.now() - tInsertStart).toFixed(0)}ms`,
              )
            }
          }
          setTimeout(pumpBatch, 0)
        },
      }),
      [editor],
    )

    return (
      <div ref={containerRef} className="blocknote-editor-container">
        <ErrorBoundary
          fallback={(error, reset) => (
            <div className="blocknote-editor-error">
              <strong>The editor hit an error and recovered.</strong>
              <p style={{ margin: '0.25rem 0 0.5rem' }}>
                Your draft is still saved on disk. Click Retry to remount the
                editor, or use the back button to leave this page.
              </p>
              <details style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                <summary>Error detail</summary>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '0.25rem 0' }}>
                  {error.message}
                </pre>
              </details>
              <button type="button" className="btn" onClick={reset} style={{ marginTop: '0.5rem' }}>
                Retry
              </button>
            </div>
          )}
        >
          <BlockNoteView
            editor={editor}
            theme={resolvedTheme}
            onChange={() => {
              if (onChange) onChange(editor.document)
            }}
          />
        </ErrorBoundary>
        {dropIndicator &&
          createPortal(
            // Portal the indicator into document.body so it escapes
            // any ancestor that creates a containing block for
            // `position: fixed` (transform, filter, contain: paint,
            // etc.). `.home-work-editor-drop` uses `contain: paint`
            // to clip BlockNote's table widgets; under that
            // containing block the indicator's viewport-relative
            // rect coordinates appear offset, and webview-level
            // zoom amplifies the discrepancy. Rendering at the body
            // level keeps `position: fixed` truly viewport-relative.
            <div
              className="bn-drop-indicator"
              aria-hidden="true"
              style={{
                top: dropIndicator.top - 1,
                left: dropIndicator.left,
                width: dropIndicator.width,
              }}
            />,
            document.body,
          )}
      </div>
    )
  },
)

BlockNoteEditor.displayName = 'BlockNoteEditor'

export default BlockNoteEditor
