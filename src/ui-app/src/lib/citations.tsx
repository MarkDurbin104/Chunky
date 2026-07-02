// Citation parsing and renderer helpers for the chat page.
//
// The model is instructed (system prompt in §4.4 of TRP D-014) to cite
// claims with `[<node-id>]` tokens. The bridge handler intersects the
// returned citation set with the search hits we sent in, so any id rendered
// in the markdown is guaranteed to map to a known node — but we still
// resolve gracefully if a stray id slips through (render it as plain text).

import React, { Fragment } from 'react'
import { Link } from 'react-router-dom'

/** A single citation token detected in the assistant markdown. */
export interface CitationToken {
  raw: string // the literal `[id]` text including brackets
  id: string
  start: number // byte offset in the source markdown
  end: number
}

const CITATION_PATTERN =
  '\\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\]'

export function findCitationTokens(markdown: string): CitationToken[] {
  const out: CitationToken[] = []
  // Local instance per call so concurrent callers don't race on lastIndex.
  const re = new RegExp(CITATION_PATTERN, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    out.push({
      raw: m[0],
      id: m[1].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Lighter-weight extractor used by D-019 (Epic references derivation) and
 * D-021 (slash agent grounding). Returns lowercased UUIDs in first-seen
 * order with duplicates removed. Mirrors Rust workspace_service::
 * parse_uuid_citations exactly so renderer-side and bridge-side citation
 * parsing always agree.
 */
export function extractCitations(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of findCitationTokens(text)) {
    if (!seen.has(tok.id)) {
      seen.add(tok.id)
      out.push(tok.id)
    }
  }
  return out
}

/** Walk a document body string (typically the stringified JSON of a
 *  doc's bodyMd) and collect all citation uuids found inside. */
export function extractCitationsFromBody(bodyMd: string): string[] {
  return extractCitations(bodyMd)
}

export interface SearchHitLite {
  nodeId: string
  title?: string
  snippet?: string
  score?: number
  /**
   * Canonical node type (`product_increment` / `artifact_collection` /
   * `requirement_document` / `epic` / `reference` / etc.). Used by
   * `routeForNode` below to decide which viewer the citation chip
   * navigates to. Optional — when absent, the chip falls back to the
   * legacy `/requirement/create` route which the App-level redirect maps
   * to `/collection/create` for back-compat.
   */
  type?: string
}

/**
 * Resolve the in-app route for a cited node, given its canonical type.
 * Authoring Phase added five typed surfaces; the citation chip used to
 * hardcode `/requirement/create` regardless, sending users to the wrong
 * page for non-collection cited nodes (REM-031).
 *
 * Closed-set match against the post-B-017 `WorkspaceType` union. Unknown
 * or absent `type` falls through to the legacy redirect target so older
 * chats that lack type metadata still resolve to a real page.
 */
export function routeForNode(
  type: string | undefined,
  id: string,
  anchorQuery?: string,
): string {
  const safeId = encodeURIComponent(id)
  // `q` is a free-text fragment the destination page can pattern-
  // match against block contents to scroll + highlight the cited
  // section. Doc viewers wire it via `useScrollToQuery`; other
  // pages ignore it.
  const q =
    anchorQuery && anchorQuery.trim().length > 0
      ? `?q=${encodeURIComponent(anchorQuery.trim())}`
      : ''
  switch (type) {
    case 'product_increment':
      return `/pi/${safeId}${q}`
    case 'artifact_collection':
      return `/collection/${safeId}${q}`
    case 'requirement_document':
      return `/document/${safeId}${q}`
    case 'epic':
      return `/epic/${safeId}${q}`
    case 'reference':
      return `/references/${safeId}${q}`
    // Legacy v1 entity types still in the union — point at the Browse
    // detail surface so the chip resolves rather than 404s.
    case 'component':
    case 'interface':
    case 'constraint':
    case 'decision':
    case 'risk':
    case 'testcase':
    case 'annotation':
    case 'evidence':
      return `/browse?id=${safeId}${q ? `&q=${encodeURIComponent(anchorQuery!.trim())}` : ''}`
    default:
      // Type unknown (no readNode resolution succeeded, or older chat
      // record missing the field). Hand back the legacy create route;
      // App.tsx redirects `/requirement/create` → `/collection/create`
      // preserving querystring, so the chip still lands somewhere.
      return `/requirement/create?draftId=${safeId}${q ? `&q=${encodeURIComponent(anchorQuery!.trim())}` : ''}`
  }
}

/**
 * Strip BlockNote/FTS5 noise out of a search snippet to leave a
 * plain-text fragment the destination page can pattern-match
 * against. The snippet that came back from `search_nodes` has
 * `<mark>` highlight tags around hit terms and ellipses where it
 * windowed the source — both confuse a literal `includes()` match
 * against the doc's body text. We also clip to ~80 characters so
 * the URL stays short and the match remains robust against minor
 * whitespace / punctuation differences nearby.
 */
/**
 * Pull the LLM's claim text from immediately before a citation token —
 * the sentence (or last 80 chars) ending at `tokenStart`. This is the
 * natural search anchor: the LLM's text *is* the claim the citation
 * supports, so a fuzzy match against the cited doc lands on the
 * supporting passage with high precision.
 *
 * Strips any *prior* citation tokens out of the lookback window so a
 * sentence with two citations doesn't pick up the other UUID as
 * "context."
 */
export function claimAnchorBefore(markdown: string, tokenStart: number): string {
  const LOOKBACK = 240
  const start = Math.max(0, tokenStart - LOOKBACK)
  const before = markdown
    .slice(start, tokenStart)
    .replace(
      /\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
  if (!before) return ''
  // Take the last sentence-ish chunk. Split on `. ! ? ;` and keep the
  // trailing fragment — that's the clause the citation grounds.
  const parts = before.split(/(?<=[.!?;])\s+/)
  const last = parts[parts.length - 1] || before
  // Cap to 80 chars from the end (the bit closest to the token), which
  // keeps URLs short and stays robust against minor whitespace /
  // punctuation differences.
  const tail = last.length > 80 ? last.slice(-80) : last
  return tail.trim()
}

export function snippetToAnchorQuery(snippet: string | undefined): string {
  if (!snippet) return ''
  return snippet
    .replace(/<\/?mark>/g, ' ')
    .replace(/…/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Render markdown that contains `[<uuid>]` citation tokens, replacing each
 * known token with a clickable chip linking to the corresponding draft.
 * Unknown ids are left as plain `[id]` text to make fabrication visible.
 *
 * Round-1 implementation: text segmentation only — no markdown formatting
 * (bold, italics, lists) is rendered. The chat markdown body is shown as
 * `<pre>`-style preserved-whitespace text with chips inline. A future
 * iteration can swap this for a proper Markdown renderer that walks an
 * AST and embeds chips during the text-block step.
 */
export function renderWithChips(
  markdown: string,
  hitsById: Map<string, SearchHitLite>,
): React.ReactNode {
  const tokens = findCitationTokens(markdown)
  if (tokens.length === 0) return markdown

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) {
      parts.push(markdown.slice(cursor, token.start))
    }
    const hit = hitsById.get(token.id)
    if (hit) {
      const shortId = token.id.slice(0, 8)
      // Carry an anchor hint as `?q=` so the destination doc viewer can
      // scroll to and highlight the cited section rather than dumping
      // the whole document on the user.
      //
      // Prefer the **LLM's claim text immediately preceding this token**
      // over the resolved-hit snippet. `hit.snippet` is just the first
      // 200 chars of the doc body (see `resolveCitations` in Chat.tsx),
      // which always matches block 0 and never reflects where the LLM
      // actually drew the claim from. The text before the token IS the
      // claim — using it as the anchor query matches the supporting
      // sentence in the cited doc with much higher precision.
      const anchor =
        claimAnchorBefore(markdown, token.start) ||
        snippetToAnchorQuery(hit.snippet)
      parts.push(
        <Link
          key={`${token.id}-${token.start}`}
          to={routeForNode(hit.type, token.id, anchor)}
          className="citation-chip"
          title={
            hit.title
              ? `${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ''}`
              : token.id
          }
        >
          {shortId}…
        </Link>,
      )
    } else {
      // Unknown id — render literal so fabrication is visible.
      parts.push(
        <span key={`${token.id}-${token.start}`} className="citation-stale">
          {token.raw}
        </span>,
      )
    }
    cursor = token.end
  }
  if (cursor < markdown.length) {
    parts.push(markdown.slice(cursor))
  }
  return (
    <Fragment>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </Fragment>
  )
}
