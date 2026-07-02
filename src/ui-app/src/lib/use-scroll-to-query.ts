// Scroll-to-cited-block hook for document viewer pages.
//
// When the user clicks a citation chip in the chat, the destination
// route carries a `?q=<anchor>` hint (set up by `renderWithChips`).
// This hook reads the hint after the page's blocks have loaded, then
// finds the best-matching block IN THE RENDERED DOM, expands any
// collapsed toggleable-heading ancestors that wrap it, and scrolls
// the block into view with a brief highlight animation.
//
// The DOM-first strategy is deliberate. An earlier JSON-traversal
// version mis-fired whenever a matched block lacked an `id` field
// (e.g. paragraphs synthesised by `filesToToggleSections` ship
// without ids — BlockNote auto-generates one at mount time that the
// JSON snapshot never sees, so a `[data-id=...]` lookup always
// misses). DOM matching uses BlockNote's own `.bn-block-content` /
// `.bn-block` structure so id presence is irrelevant.
//
// Match precedence:
//   1. Verbatim substring (full anchor, then 60/40-char prefixes) —
//      handles cases where the LLM quoted the source closely.
//   2. TF-IDF-weighted word overlap — handles paraphrased claims
//      where the LLM didn't quote but shares domain terms. Rare
//      terms (e.g. "NTRIP", "Trimble") outweigh common ones, and a
//      density tie-break prefers blocks where the matched terms make
//      up a higher proportion of the block.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'us', 'them',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'the', 'of', 'in', 'on', 'at', 'to', 'from', 'for', 'with', 'by',
  'as', 'into', 'about', 'over', 'under', 'between', 'through',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  'not', 'no', 'so', 'too', 'very', 'just', 'also',
])

function contentTerms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Pick the best-matching `.bn-block` element under `root` for the
 * given anchor query. Searches over every `.bn-block` whose content
 * has at least a few characters; ignores the toggle-summary heading
 * blocks (they tend to share keywords with the section title but
 * aren't the cited body text).
 */
function findBestBlock(
  root: ParentNode,
  anchor: string,
): HTMLElement | null {
  const blocks = Array.from(
    root.querySelectorAll('.bn-block'),
  ) as HTMLElement[]
  if (blocks.length === 0) return null

  // Pre-compute the per-block text once.
  const records = blocks.map((el) => {
    const content =
      (el.querySelector(':scope > .bn-block-content') as HTMLElement | null) ??
      (el.querySelector(
        ':scope > .react-renderer > .bn-block-content',
      ) as HTMLElement | null)
    const text = content ? content.textContent ?? '' : ''
    return { el, text: normText(text), terms: contentTerms(text) }
  }).filter((r) => r.text.length > 0)
  if (records.length === 0) return null

  // 1) Verbatim substring (full → 60 → 40 char prefixes).
  const normAnchor = normText(anchor)
  for (const candidate of [normAnchor, normAnchor.slice(0, 60), normAnchor.slice(0, 40)]) {
    if (candidate.length === 0) continue
    for (const r of records) {
      if (r.text.includes(candidate)) return r.el
    }
  }

  // 2) IDF-weighted word overlap. Document frequency is computed over
  //    the blocks we just collected, so common navigation words don't
  //    drown out the rare terms that actually identify the section.
  const queryTerms = new Set(contentTerms(anchor))
  if (queryTerms.size === 0) return null
  const df = new Map<string, number>()
  for (const r of records) {
    const seen = new Set<string>()
    for (const t of r.terms) {
      if (seen.has(t)) continue
      seen.add(t)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const N = records.length
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1
  const minHit = queryTerms.size >= 2 ? 2 : 1

  let best: { score: number; el: HTMLElement } | null = null
  for (const r of records) {
    const termSet = new Set(r.terms)
    let hits = 0
    let weighted = 0
    for (const q of queryTerms) {
      if (termSet.has(q)) {
        hits++
        weighted += idf(q)
      }
    }
    if (hits < minHit) continue
    const density = hits / Math.min(40, Math.max(1, r.terms.length))
    const composite = weighted + density * 0.5
    if (best === null || composite > best.score) {
      best = { score: composite, el: r.el }
    }
  }
  return best ? best.el : null
}

/**
 * BlockNote toggle structure (per @blocknote/core dist):
 *
 *   <div class="bn-block" data-id="...">
 *     <div class="bn-block-content" data-content-type="heading" ...>
 *       <div>
 *         <div class="bn-toggle-wrapper" data-show-children="false|true">
 *           <button class="bn-toggle-button">…</button>
 *         </div>
 *         <h3>filename.pdf</h3>
 *       </div>
 *     </div>
 *     <div class="bn-block-group">   ← display:none when data-show-children=false
 *       <!-- children blocks -->
 *     </div>
 *   </div>
 *
 * To make `target`'s children visible we walk every ancestor toggle
 * wrapper and click each `bn-toggle-button` whose wrapper is in the
 * collapsed state. Returns true if any click was issued so the
 * caller can wait a frame for BlockNote to re-render.
 */
function expandAncestorToggles(target: HTMLElement, root: ParentNode): boolean {
  let clicked = false
  let cursor: HTMLElement | null = target
  while (cursor && cursor !== root) {
    // The toggle wrapper lives INSIDE the .bn-block of the toggle
    // heading itself, not as an ancestor — so for each .bn-block on
    // the way up, check whether it owns a collapsed wrapper.
    if (cursor.classList?.contains('bn-block')) {
      const wrapper = cursor.querySelector(
        ':scope > .bn-block-content .bn-toggle-wrapper[data-show-children="false"],' +
        ':scope > .react-renderer > .bn-block-content .bn-toggle-wrapper[data-show-children="false"]',
      ) as HTMLElement | null
      if (wrapper) {
        const btn = wrapper.querySelector(
          '.bn-toggle-button',
        ) as HTMLElement | null
        if (btn) {
          btn.click()
          clicked = true
        }
      }
    }
    cursor = cursor.parentElement
  }
  return clicked
}

/**
 * After the document's content has loaded and `ready` is true, read
 * `?q=` from the URL and scroll the best-matching BlockNote block
 * into view. Pulses a `citation-scroll-target` CSS class on the
 * element for a few seconds so the user sees what was cited.
 *
 * `blocks` is no longer consulted directly — it's kept in the
 * signature so callers don't have to rewire, and as a `useEffect`
 * dep so the hook re-runs when the document's content swaps in.
 *
 * Safe to call on pages that don't have a `?q=` parameter — it
 * no-ops when the param is empty or no candidate blocks render.
 */
export function useScrollToQuery(
  blocks: unknown,
  ready: boolean,
  containerRef?: React.RefObject<HTMLElement>,
): void {
  const { search } = useLocation()
  useEffect(() => {
    if (!ready) return
    const params = new URLSearchParams(search)
    const raw = params.get('q')
    if (!raw) return
    const anchor = raw.trim()
    if (anchor.length === 0) return

    const root: ParentNode = containerRef?.current ?? document
    let cancelled = false

    const scrollAndPulse = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('citation-scroll-target')
      window.setTimeout(() => {
        el.classList.remove('citation-scroll-target')
      }, 2500)
    }

    const run = (attempt: number) => {
      if (cancelled) return
      const target = findBestBlock(root, anchor)
      if (!target) {
        // BlockNote may not have mounted its DOM yet on the first
        // pass — retry a few times before giving up.
        if (attempt < 14) {
          window.setTimeout(() => run(attempt + 1), 100)
        }
        return
      }
      if (expandAncestorToggles(target, root)) {
        // A click flipped a toggle from collapsed → expanded. Wait
        // a frame for BlockNote / CSS to update layout before we
        // scroll, so the block has a real layout box.
        window.setTimeout(() => {
          if (cancelled) return
          scrollAndPulse(target)
        }, 80)
        return
      }
      scrollAndPulse(target)
    }

    requestAnimationFrame(() => run(0))
    return () => {
      cancelled = true
    }
  }, [blocks, ready, search, containerRef])
}
