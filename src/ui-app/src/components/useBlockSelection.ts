// Per-card click + shift-click + cmd-click range selection over the
// blocks rendered inside a CollectionItemTree. Hoisted out of
// DocumentPicker / CollectionPicker because both pickers want the
// same behaviour: one selection set per expanded card, shift-click
// ranges within the source-document DFS order, and dragging any
// selected leaf produces a bundled `kind: 'document'` payload.
//
// The hook exposes:
//   - `apiFor(cardId, blocks, cardTitle, srcPiId)` → BlockSelectionAPI
//     for wiring straight into <CollectionItemTree selection=… />
//   - `selectionSizeFor(cardId)` for the header-side "N selected" badge
//   - `clearCard(cardId)` so the parent can drop selection state when
//     a card collapses
//
// Selection state lives in `useState`s keyed by cardId — the parent
// only needs to pass the cardId in and call clearCard on collapse.

import { useState } from 'react'
import type { Block } from '@blocknote/core'
import type {
  ArtifactDragPayload,
  BlockSelectionAPI,
} from './CollectionItemTree'

// The "Attachments" wrapper is flattened away at render time by
// CollectionItemTree (its children are spliced in at the top level).
// Skip it here too so it never participates in the selection — it's
// neither clickable nor visible.
const isAttachmentsRoot = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  (b as { id?: unknown }).id === 'attachments-root'

function flattenArtifactIds(blocks: Block[]): string[] {
  const out: string[] = []
  const walk = (bs: unknown[]): void => {
    for (const b of bs) {
      if (!b || typeof b !== 'object') continue
      const node = b as { props?: { id?: unknown }; children?: unknown[] }
      if (!isAttachmentsRoot(b)) {
        const id = node.props?.id
        if (typeof id === 'string' && id.startsWith('art-')) out.push(id)
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(blocks as unknown[])
  return out
}

function collectSelectedBlocks(
  blocks: Block[],
  selected: ReadonlySet<string>,
): Block[] {
  const out: Block[] = []
  const walk = (bs: unknown[]): void => {
    for (const b of bs) {
      if (!b || typeof b !== 'object') continue
      const node = b as { props?: { id?: unknown }; children?: unknown[] }
      if (!isAttachmentsRoot(b)) {
        const id = node.props?.id
        if (typeof id === 'string' && selected.has(id)) {
          // Whole subtree under a selected node — for a toggle heading
          // that drags the heading PLUS its body. Don't recurse: the
          // children come with the parent we just pushed.
          out.push(b as Block)
          continue
        }
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(blocks as unknown[])
  return out
}

export interface UseBlockSelectionResult {
  apiFor: (
    cardId: string,
    blocks: Block[] | null,
    cardTitle: string,
    srcPiId: string | undefined,
  ) => BlockSelectionAPI
  selectionSizeFor: (cardId: string) => number
  clearCard: (cardId: string) => void
  clearAll: () => void
}

export function useBlockSelection(): UseBlockSelectionResult {
  const [selection, setSelection] = useState<Record<string, Set<string>>>({})
  const [anchors, setAnchors] = useState<Record<string, string | null>>({})

  const apiFor: UseBlockSelectionResult['apiFor'] = (
    cardId,
    blocks,
    cardTitle,
    srcPiId,
  ) => {
    const selected = selection[cardId] ?? new Set<string>()
    return {
      isSelected: (artifactId) => selected.has(artifactId),
      onLeafClick: (artifactId, mods) => {
        if (mods.shift) {
          const anchor = anchors[cardId] ?? null
          if (!blocks || !anchor || anchor === artifactId) {
            setSelection((prev) => ({
              ...prev,
              [cardId]: new Set([artifactId]),
            }))
            setAnchors((prev) => ({ ...prev, [cardId]: artifactId }))
            return
          }
          const order = flattenArtifactIds(blocks)
          const a = order.indexOf(anchor)
          const b = order.indexOf(artifactId)
          if (a < 0 || b < 0) {
            setSelection((prev) => ({
              ...prev,
              [cardId]: new Set([artifactId]),
            }))
            setAnchors((prev) => ({ ...prev, [cardId]: artifactId }))
            return
          }
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          const range = new Set<string>()
          for (let i = lo; i <= hi; i++) range.add(order[i])
          setSelection((prev) => ({ ...prev, [cardId]: range }))
          return
        }
        if (mods.meta || mods.ctrl) {
          setSelection((prev) => {
            const cur = new Set(prev[cardId] ?? [])
            if (cur.has(artifactId)) cur.delete(artifactId)
            else cur.add(artifactId)
            return { ...prev, [cardId]: cur }
          })
          setAnchors((prev) => ({ ...prev, [cardId]: artifactId }))
          return
        }
        setSelection((prev) => ({ ...prev, [cardId]: new Set([artifactId]) }))
        setAnchors((prev) => ({ ...prev, [cardId]: artifactId }))
      },
      getDragPayload: (artifactId): ArtifactDragPayload | null => {
        if (!blocks || selected.size <= 1 || !selected.has(artifactId)) {
          return null
        }
        const blocksToSend = collectSelectedBlocks(blocks, selected)
        if (blocksToSend.length === 0) return null
        return {
          collectionId: cardId,
          artifactId: `sel-${cardId}-${blocksToSend.length}`,
          kind: 'document',
          content: JSON.stringify(blocksToSend),
          collectionName: `${blocksToSend.length} sections from ${cardTitle}`,
          ...(srcPiId ? { srcPiId } : {}),
        }
      },
    }
  }

  const selectionSizeFor = (cardId: string): number =>
    selection[cardId]?.size ?? 0

  const clearCard = (cardId: string) => {
    setSelection((prev) => {
      if (!prev[cardId]) return prev
      const next = { ...prev }
      delete next[cardId]
      return next
    })
    setAnchors((prev) => {
      if (!(cardId in prev)) return prev
      const next = { ...prev }
      delete next[cardId]
      return next
    })
  }

  const clearAll = () => {
    setSelection({})
    setAnchors({})
  }

  return { apiFor, selectionSizeFor, clearCard, clearAll }
}
