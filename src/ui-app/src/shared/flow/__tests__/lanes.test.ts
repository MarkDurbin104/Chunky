import { describe, expect, test } from 'vitest'
import {
  autoLayout,
  importStatechart,
  validateFlow,
  drawnBoxes,
  routeEdge,
  routeAllEdges,
} from '../index'
import type { FlowDoc } from '../model'
import type { Pt } from '../geometry'
import { CAPTIVATE_RAW } from '../captivate.generated'

// ── Overlap metric ───────────────────────────────────────────────────────────
//
// Count unordered pairs of axis-aligned segments from DIFFERENT edges that are
// collinear (same axis coord within tol) AND whose spans overlap by more than a
// few px — i.e. drawn on top of each other rather than merely crossing.

const COORD_TOL = 2
const SPAN_MIN = 4

interface ASeg {
  edgeId: string
  axis: 'v' | 'h'
  coord: number
  lo: number
  hi: number
}

function axisSegsOf(edgeId: string, pts: Pt[]): ASeg[] {
  const out: ASeg[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = Math.abs(a.x - b.x)
    const dy = Math.abs(a.y - b.y)
    if (dx <= 1e-6 && dy > 1e-6) {
      out.push({ edgeId, axis: 'v', coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
    } else if (dy <= 1e-6 && dx > 1e-6) {
      out.push({ edgeId, axis: 'h', coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
    }
  }
  return out
}

/** Overlap pairs across a set of polylines (edge id -> pts). */
function overlapCount(routes: Array<{ edgeId: string; pts: Pt[] }>): number {
  const segs: ASeg[] = []
  for (const r of routes) segs.push(...axisSegsOf(r.edgeId, r.pts))
  let count = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]
      const b = segs[j]
      if (a.edgeId === b.edgeId) continue
      if (a.axis !== b.axis) continue
      if (Math.abs(a.coord - b.coord) > COORD_TOL) continue
      if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > SPAN_MIN) count++
    }
  }
  return count
}

/** Pre-change base routing of every non-self edge (per-edge routeEdge). */
function baseRoutes(doc: FlowDoc): Array<{ edgeId: string; pts: Pt[] }> {
  const boxes = drawnBoxes(doc)
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const out: Array<{ edgeId: string; pts: Pt[] }> = []
  for (const e of doc.edges) {
    if (e.kind === 'self') continue
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    out.push({ edgeId: e.id, pts: routeEdge(from, to, boxes) })
  }
  return out
}

/** Post-change laned routing. */
function lanedRoutes(doc: FlowDoc): Array<{ edgeId: string; pts: Pt[] }> {
  const map = routeAllEdges(doc)
  return [...map.entries()].map(([edgeId, pts]) => ({ edgeId, pts }))
}

const r1 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R1')
const r2 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R2')
const r3 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R3')

describe('routeAllEdges — lane separation reduces collinear overlap', () => {
  test('corpus overlap drops dramatically BEFORE -> AFTER', () => {
    let before = 0
    let after = 0
    for (const row of CAPTIVATE_RAW) {
      let doc: FlowDoc
      try {
        doc = autoLayout(importStatechart(row.chart))
      } catch {
        continue
      }
      before += overlapCount(baseRoutes(doc))
      after += overlapCount(lanedRoutes(doc))
    }
    // eslint-disable-next-line no-console
    console.log(`lane overlap across 148 CAPTIVATE_RAW: BEFORE=${before} AFTER=${after}`)
    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before / 2)
  })

  test('a flow with clearly stacked columns has ~0 overlap after laning', () => {
    // pick the corpus flow with the most BASE overlap (the worst stacker)
    let worstKey = ''
    let worstBefore = -1
    for (const row of CAPTIVATE_RAW) {
      let doc: FlowDoc
      try {
        doc = autoLayout(importStatechart(row.chart))
      } catch {
        continue
      }
      const b = overlapCount(baseRoutes(doc))
      if (b > worstBefore) {
        worstBefore = b
        worstKey = row.key
      }
    }
    expect(worstBefore).toBeGreaterThan(0)
    const doc = autoLayout(importStatechart(CAPTIVATE_RAW.find((r) => r.key === worstKey)!.chart))
    const after = overlapCount(lanedRoutes(doc))
    // eslint-disable-next-line no-console
    console.log(`worst stacker "${worstKey}": BEFORE=${worstBefore} AFTER=${after}`)
    expect(after).toBeLessThanOrEqual(1)
  })
})

describe('routeAllEdges — rules stay green across the corpus', () => {
  test('R1, R2, R3 are 0/148 after lane separation', () => {
    let withR1 = 0
    let withR2 = 0
    let withR3 = 0
    for (const row of CAPTIVATE_RAW) {
      let doc: FlowDoc
      try {
        doc = autoLayout(importStatechart(row.chart))
      } catch {
        continue
      }
      if (r1(doc).length) withR1++
      if (r2(doc).length) withR2++
      if (r3(doc).length) withR3++
    }
    // eslint-disable-next-line no-console
    console.log(`after laning: R1=${withR1}/148 R2=${withR2}/148 R3=${withR3}/148`)
    expect(withR1).toBe(0)
    expect(withR2).toBe(0)
    expect(withR3).toBe(0)
  })
})

describe('edgeEndpoints — side entry for facing boxes', () => {
  test('a horizontally-separated facing pair enters the SIDES (horizontal connector)', () => {
    // two boxes whose VERTICAL spans overlap, one entirely left of the other.
    const doc: FlowDoc = {
      id: 'x',
      title: 't',
      revision: [],
      overview: '',
      nodes: [
        { id: 'a', label: 'A', role: 'screen', pos: { x: 0, y: 100 } },
        { id: 'b', label: 'B', role: 'screen', pos: { x: 500, y: 110 } },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', events: [], kind: 'forward', label: '' }],
    }
    const pts = routeAllEdges(doc).get('e')!
    // straight, clear -> 2-point connector
    expect(pts.length).toBe(2)
    const [p0, p1] = pts
    // HORIZONTAL: both endpoints share a y...
    expect(Math.abs(p0.y - p1.y)).toBeLessThanOrEqual(1)
    const boxes = drawnBoxes(doc)
    const a = boxes.find((bx) => bx.id === 'a')!
    const b = boxes.find((bx) => bx.id === 'b')!
    // ...and they sit on the FACING side borders (a's right edge, b's left edge),
    // not pulled to a top/bottom corner.
    expect(Math.abs(p0.x - (a.x + a.w))).toBeLessThanOrEqual(1)
    expect(Math.abs(p1.x - b.x)).toBeLessThanOrEqual(1)
    // the shared y is inside BOTH vertical spans (a true side entry)
    const yInA = p0.y >= a.y && p0.y <= a.y + a.h
    const yInB = p0.y >= b.y && p0.y <= b.y + b.h
    expect(yInA && yInB).toBe(true)
    // and the validator is happy (endpoints on borders, no through-box)
    expect(validateFlow(doc).issues.filter((i) => i.rule === 'R1' || i.rule === 'R2')).toEqual([])
  })

  test('a vertically-separated facing pair enters top/bottom (vertical connector)', () => {
    const doc: FlowDoc = {
      id: 'x',
      title: 't',
      revision: [],
      overview: '',
      nodes: [
        { id: 'a', label: 'A', role: 'screen', pos: { x: 0, y: 0 } },
        { id: 'b', label: 'B', role: 'screen', pos: { x: 8, y: 300 } },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', events: [], kind: 'forward', label: '' }],
    }
    const pts = routeAllEdges(doc).get('e')!
    expect(pts.length).toBe(2)
    const [p0, p1] = pts
    // VERTICAL: both endpoints share an x
    expect(Math.abs(p0.x - p1.x)).toBeLessThanOrEqual(1)
  })
})

describe('routeAllEdges — straights and determinism', () => {
  test('an isolated straight-clear edge stays a 2-point route', () => {
    const doc: FlowDoc = {
      id: 'x',
      title: 't',
      revision: [],
      overview: '',
      nodes: [
        { id: 'a', label: 'A', role: 'screen', pos: { x: 0, y: 0 } },
        { id: 'b', label: 'B', role: 'screen', pos: { x: 0, y: 300 } },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', events: [], kind: 'forward', label: '' }],
    }
    const pts = routeAllEdges(doc).get('e')!
    expect(pts.length).toBe(2)
  })

  test('same doc -> identical laned map', () => {
    const doc = autoLayout(
      importStatechart(CAPTIVATE_RAW.find((r) => r.key === 'apps__alignment-toolkit-editor')!.chart),
    )
    const a = routeAllEdges(doc)
    // fresh doc (defeat the memo) to prove determinism, not just caching
    const doc2 = autoLayout(
      importStatechart(CAPTIVATE_RAW.find((r) => r.key === 'apps__alignment-toolkit-editor')!.chart),
    )
    const b = routeAllEdges(doc2)
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})
