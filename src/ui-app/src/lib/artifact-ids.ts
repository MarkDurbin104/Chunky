// Stable artifact ids for collection contents (D-018 §4.2).
//
// Every "draggable thing" inside an Artifact Collection — paragraphs,
// headings, images, attachment toggle-headings — gets a persistent
// `art-<uuid>` id stamped into its `props.id` field at save time. The
// downstream Document editor reads these ids to populate citation chips
// when the user drags content into their draft.
//
// Idempotent: items that already carry an `art-` id are left alone.

import type { Block, PartialBlock } from '@blocknote/core'

const ARTIFACT_TYPES = new Set<string>([
  'paragraph',
  'heading',
  'image',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  // Tables emit from XLSX/CSV ingest — the home-page tree renders
  // them via CollectionItemTree's TableLeaf, which needs an `art-…`
  // id in `props.id` to make the row draggable into a draft. Without
  // an entry here, tagArtifacts skips them and the table renders as
  // a dead, undraggable block.
  'table',
])

const newArtifactId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `art-${crypto.randomUUID()}`
    : `art-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

interface BlockWithProps {
  id?: string
  type?: string
  props?: Record<string, unknown> & { id?: string }
  children?: BlockWithProps[]
}

/**
 * Walk a BlockNote document tree and stamp `props.id` on every artifact
 * block that doesn't already have one. Returns a NEW array — input is
 * not mutated, so callers can safely call this with a state-owned blocks
 * array without violating React's immutability invariant.
 *
 * Image blocks already get a generated `block.id` from BlockNote; for
 * artifact tracking we additionally write `props.id` so the value is
 * preserved across save / load round-trips (BlockNote may regenerate
 * `block.id` on import; `props.id` survives).
 */
export function tagArtifacts<T extends BlockWithProps>(blocks: T[]): T[] {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((b) => cloneAndTag(b)) as T[]
}

function cloneAndTag(block: BlockWithProps): BlockWithProps {
  if (!block || typeof block !== 'object') return block
  const next: BlockWithProps = { ...block }
  if (block.props) {
    next.props = { ...block.props }
  }
  if (next.type && ARTIFACT_TYPES.has(next.type)) {
    const existing = next.props?.id
    if (typeof existing !== 'string' || !existing.startsWith('art-')) {
      next.props = { ...(next.props ?? {}), id: newArtifactId() }
    }
  }
  if (Array.isArray(block.children) && block.children.length > 0) {
    next.children = block.children.map(cloneAndTag)
  }
  return next
}

/** Type-helper: the function works against `Block[]` and `PartialBlock[]`. */
export type AnyBlocks = Block[] | PartialBlock[]
