// Extract a structural template from a reference document body.
//
// "Structure" here means the document's section outline — the
// hierarchy of heading blocks, in source order, with one empty
// paragraph beneath each so the user has a cursor target. Attachment
// scaffolding (the singleton "Attachments" toggle and its per-file
// `attach-*` children) is skipped because it's file-management
// chrome, not the document's real outline. Tables, images, lists,
// and paragraph prose are also skipped — the goal is a skeleton, not
// a copy.
//
// Used by the home-page editor when the user selects a reference
// against an empty Epic: the Epic body is seeded with the reference's
// section structure so authoring starts from the right shape rather
// than a blank page. Implementation deliberately tolerant of partial
// / malformed BlockNote JSON because saved bodies come from many
// extraction sources (mammoth HTML walk, manual edits, PDF text
// chunking) and can vary in shape.

import type { PartialBlock } from '@blocknote/core'

interface BlockLike {
  id?: string
  type?: string
  props?: { id?: string; level?: number; isToggleable?: boolean }
  content?: unknown
  children?: BlockLike[]
}

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object' && 'text' in (c as object)) {
        return String((c as { text?: string }).text ?? '')
      }
      return ''
    })
    .join('')
}

function isAttachmentScaffold(block: BlockLike): boolean {
  if (block.id === 'attachments-root') return true
  if (typeof block.id === 'string' && block.id.startsWith('attach-')) return true
  // Toggle headings used by the attachments grouping carry
  // `isToggleable: true` on a heading; treat ALL toggle headings as
  // scaffolding for skeleton purposes — the source document's real
  // outline uses regular (non-toggle) headings.
  if (block.type === 'heading' && block.props?.isToggleable) return true
  return false
}

/**
 * Heading titles that are document front-matter / boilerplate rather
 * than actual content sections — Index, Table of Contents, Glossary
 * etc. They show up in nearly every long reference doc and would
 * otherwise pollute the seeded Epic skeleton. Matched case-
 * insensitively against the trimmed text. The patterns include
 * common variants ("Contents", "Table of Contents", "TOC", "List of
 * Figures", etc.); anything more specific should be added when the
 * user actually hits it.
 */
const FRONT_MATTER_PATTERNS: RegExp[] = [
  /^(table\s+of\s+)?contents$/,
  /^toc$/,
  /^index$/,
  /^glossary$/,
  /^acronyms?$/,
  /^abbreviations?$/,
  /^list\s+of\s+(figures|tables|abbreviations|acronyms)$/,
  /^cover(\s+page)?$/,
  /^title(\s+page)?$/,
  /^copyright$/,
  /^revision\s+history$/,
  /^document\s+(history|control|information)$/,
  /^acknowledg(e)?ments?$/,
  /^preface$/,
  /^foreword$/,
  /^bibliography$/,
  /^references$/, // only matches when used as a section heading,
  // not the citation list inside a section.
]

function isFrontMatterHeading(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.length === 0) return false
  for (const p of FRONT_MATTER_PATTERNS) {
    if (p.test(t)) return true
  }
  return false
}

/**
 * Walk a BlockNote document tree and emit a flat list of heading +
 * placeholder-paragraph blocks. Heading level is clamped to 1-3 to
 * match BlockNote's supported range. Each heading is followed by an
 * empty paragraph so the editor has a cursor landing spot beneath
 * it. The result is suitable to pass directly to BlockNote as the
 * value of an Epic editor.
 */
export function extractStructureFromBlocks(
  blocks: unknown,
): PartialBlock[] {
  const out: PartialBlock[] = []
  const visit = (block: BlockLike) => {
    if (!block || typeof block !== 'object') return
    if (isAttachmentScaffold(block)) {
      // Don't descend into attachment scaffolding either — the
      // inner toggle children are per-file metadata, not the
      // document's outline.
      return
    }
    if (block.type === 'heading') {
      const text = inlineText(block.content).trim()
      if (text.length > 0 && !isFrontMatterHeading(text)) {
        const raw = Number(block.props?.level ?? 1)
        const level: 1 | 2 | 3 = (raw <= 1 ? 1 : raw === 2 ? 2 : 3) as 1 | 2 | 3
        out.push({
          type: 'heading',
          props: { level },
          content: text,
        })
        // Placeholder paragraph so the editor opens with an empty
        // cursor row under the heading the user just landed on.
        out.push({ type: 'paragraph', content: '' })
      }
      // Front-matter headings drop their entire subtree — we don't
      // want sub-sections like "Section 1 — Index" leaking through.
      if (text.length > 0 && isFrontMatterHeading(text)) return
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children) visit(child)
    }
  }
  if (Array.isArray(blocks)) {
    for (const b of blocks) visit(b as BlockLike)
  }
  return out
}

/**
 * Parse a saved `bodyMd` JSON string and return its structural
 * skeleton. Returns an empty array on any parse failure so callers
 * can simply "if (skeleton.length > 0) seed".
 */
export function extractStructureFromBodyMd(bodyMd: string): PartialBlock[] {
  try {
    const parsed = JSON.parse(bodyMd) as { blocks?: unknown }
    return extractStructureFromBlocks(parsed.blocks)
  } catch {
    return []
  }
}

/**
 * Best-effort emptiness check for an Epic's current blocks. Returns
 * true if the editor is showing nothing the user has typed — used as
 * the guard against overwriting in-progress content when they switch
 * references. "Empty" covers: zero blocks, a single empty paragraph
 * (BlockNote's default fresh state), or only headings with no body
 * text (a previously-seeded but untouched skeleton).
 */
export function isBodyBlocksEmpty(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return true
  if (blocks.length === 0) return true
  for (const b of blocks as BlockLike[]) {
    if (b.type === 'paragraph') {
      const txt = inlineText(b.content).trim()
      if (txt.length > 0) return false
    } else if (
      b.type === 'bulletListItem' ||
      b.type === 'numberedListItem' ||
      b.type === 'checkListItem'
    ) {
      const txt = inlineText(b.content).trim()
      if (txt.length > 0) return false
    } else if (b.type === 'image' || b.type === 'table') {
      return false
    }
    // Headings without body text are treated as part of the
    // seeded skeleton — they don't count as "user content".
    if (Array.isArray(b.children) && !isBodyBlocksEmpty(b.children)) {
      return false
    }
  }
  return true
}

/**
 * Walk a flat block list and find the heading block that owns the
 * `cursorBlockId` (the nearest preceding heading, scanning top to
 * bottom). Returns the heading block plus its `sectionPurpose` /
 * `sectionStyleHint` props, which the slash-command prompt builder
 * uses to make generated content section-appropriate.
 *
 * Recurses into `children` so toggle headings (e.g. the
 * "Attachments" wrapper) don't trap the cursor inside a section
 * we'd otherwise miss.
 */
export interface NearestHeading {
  title: string
  purpose?: string
  styleHint?: string
}

export function findHeadingForCursor(
  blocks: BlockLike[] | undefined,
  cursorBlockId: string | undefined,
): NearestHeading | null {
  if (!Array.isArray(blocks) || !cursorBlockId) return null
  let currentHeading: NearestHeading | null = null
  let found = false
  const walk = (bs: BlockLike[]): void => {
    if (found) return
    for (const b of bs) {
      if (found) return
      if (b.type === 'heading') {
        const title = inlineText(b.content).trim()
        const props = b.props as Record<string, unknown> | undefined
        const purposeRaw =
          props && typeof props.sectionPurpose === 'string'
            ? props.sectionPurpose.trim()
            : ''
        const styleRaw =
          props && typeof props.sectionStyleHint === 'string'
            ? props.sectionStyleHint.trim()
            : ''
        currentHeading = {
          title: title || '(untitled section)',
          ...(purposeRaw ? { purpose: purposeRaw } : {}),
          ...(styleRaw ? { styleHint: styleRaw } : {}),
        }
      }
      if (b.id === cursorBlockId) {
        found = true
        return
      }
      if (Array.isArray(b.children) && b.children.length > 0) {
        walk(b.children)
      }
    }
  }
  walk(blocks)
  return found ? currentHeading : null
}
