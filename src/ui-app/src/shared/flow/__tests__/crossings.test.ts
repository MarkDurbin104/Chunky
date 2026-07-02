import { describe, expect, test } from 'vitest'
import { autoLayout, importStatechart } from '../index'
import { computeLanedRoutes } from '../geometry'
import type { FlowDoc } from '../model'
import type { Pt } from '../geometry'
import { CAPTIVATE_RAW } from '../captivate.generated'

// ── Crossing metric ──────────────────────────────────────────────────────────
//
// A PROPER crossing is one HORIZONTAL segment and one VERTICAL segment from
// DIFFERENT edges whose interiors intersect (a true X — not a shared endpoint,
// not a collinear overlap, which the lanes overlap metric already covers). We
// count, across a doc's laned routes:
//   • total — the number of crossing segment-pairs (unordered)
//   • doublePairs — the number of unordered EDGE pairs that cross MORE THAN ONCE
//     (a weave: cross then cross back; at least one such crossing is redundant)
//
// We measure these BEFORE (the legacy arbitrary lane order) and AFTER (the
// crossing-aware ordering + double-crossing elimination) over all 148 flows.

interface XSeg {
  ax: 'v' | 'h'
  coord: number
  lo: number
  hi: number
}

function xsegsOf(pts: Pt[]): XSeg[] {
  const out: XSeg[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = Math.abs(a.x - b.x)
    const dy = Math.abs(a.y - b.y)
    if (dx <= 1e-6 && dy > 1e-6) {
      out.push({ ax: 'v', coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
    } else if (dy <= 1e-6 && dx > 1e-6) {
      out.push({ ax: 'h', coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
    }
  }
  return out
}

/** Proper crossings between two polylines (interior horizontal×vertical hits). */
function crossingsBetween(p: Pt[], q: Pt[]): number {
  const ps = xsegsOf(p)
  const qs = xsegsOf(q)
  let c = 0
  for (const s of ps) {
    for (const t of qs) {
      if (s.ax === t.ax) continue
      const v = s.ax === 'v' ? s : t
      const h = s.ax === 'v' ? t : s
      if (
        v.coord > h.lo + 1e-6 &&
        v.coord < h.hi - 1e-6 &&
        h.coord > v.lo + 1e-6 &&
        h.coord < v.hi - 1e-6
      ) {
        c++
      }
    }
  }
  return c
}

interface Tally {
  total: number //       crossing segment-pairs
  doublePairs: number // edge pairs crossing more than once
}

function tally(routes: Pt[][]): Tally {
  let total = 0
  let doublePairs = 0
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const c = crossingsBetween(routes[i], routes[j])
      total += c
      if (c > 1) doublePairs++
    }
  }
  return { total, doublePairs }
}

function laned(doc: FlowDoc, order: 'feed' | 'edgeIndex'): Pt[][] {
  return [...computeLanedRoutes(doc, order).values()]
}

function corpusTally(order: 'feed' | 'edgeIndex'): Tally {
  let total = 0
  let doublePairs = 0
  for (const row of CAPTIVATE_RAW) {
    let doc: FlowDoc
    try {
      doc = autoLayout(importStatechart(row.chart))
    } catch {
      continue
    }
    const t = tally(laned(doc, order))
    total += t.total
    doublePairs += t.doublePairs
  }
  return { total, doublePairs }
}

describe('routeAllEdges — crossing-aware ordering removes needless crossings', () => {
  test('corpus crossings drop meaningfully BEFORE -> AFTER', () => {
    const before = corpusTally('edgeIndex')
    const after = corpusTally('feed')
    // eslint-disable-next-line no-console
    console.log(
      `crossings across 148 CAPTIVATE_RAW: total BEFORE=${before.total} AFTER=${after.total}` +
        ` | double-crossing pairs BEFORE=${before.doublePairs} AFTER=${after.doublePairs}`,
    )
    expect(before.total).toBeGreaterThan(0)
    // a meaningful reduction in total proper crossings
    expect(after.total).toBeLessThan(before.total * 0.7)
  })

  test('double-crossing (weave) pairs are dramatically reduced', () => {
    const before = corpusTally('edgeIndex')
    const after = corpusTally('feed')
    expect(before.doublePairs).toBeGreaterThan(100)
    // weaves nearly eliminated: a few genuinely-constrained cases may remain, but
    // the count must collapse by well over an order of magnitude.
    expect(after.doublePairs).toBeLessThan(before.doublePairs / 10)
  })

  test('crossing tallies are deterministic (fresh doc -> identical numbers)', () => {
    const key = 'apps__measure-foresight'
    const row = CAPTIVATE_RAW.find((r) => r.key === key)!
    const t1 = tally(laned(autoLayout(importStatechart(row.chart)), 'feed'))
    const t2 = tally(laned(autoLayout(importStatechart(row.chart)), 'feed'))
    expect(t1).toEqual(t2)
  })
})
