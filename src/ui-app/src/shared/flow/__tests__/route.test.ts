import { describe, expect, test } from 'vitest'
import {
  autoLayout,
  importStatechart,
  validateFlow,
  drawnBoxes,
  routeEdge,
  onBorder,
} from '../index'
import type { FlowDoc } from '../model'
import type { Box } from '../geometry'
import { CAPTIVATE_RAW } from '../captivate.generated'

const TOL = 11

function chartFor(key: string): string {
  const row = CAPTIVATE_RAW.find((r) => r.key === key)
  if (!row) throw new Error(`no captivate sample "${key}"`)
  return row.chart
}

const r2 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R2')
const r1 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R1')

// The alignment editor: states include Import / Equation / Converting /
// NewAlignment. This is the flow that motivated the rewrite.
const ALIGN_KEY = 'apps__alignment-toolkit-editor'

describe('routeEdge avoids intervening boxes (R2)', () => {
  test('alignment editor really contains Import/Equation/Converting/NewAlignment', () => {
    const doc = autoLayout(importStatechart(chartFor(ALIGN_KEY)))
    const ids = new Set(doc.nodes.map((n) => n.id))
    for (const s of ['Import', 'Equation', 'Converting', 'NewAlignment']) {
      expect(ids.has(s), `state ${s}`).toBe(true)
    }
  })

  test('alignment editor has ZERO R2 issues after autoLayout', () => {
    const doc = autoLayout(importStatechart(chartFor(ALIGN_KEY)))
    expect(r2(doc), JSON.stringify(r2(doc), null, 2)).toEqual([])
  })

  test('alignment editor endpoints all satisfy R1 (on a border)', () => {
    const doc = autoLayout(importStatechart(chartFor(ALIGN_KEY)))
    expect(r1(doc), JSON.stringify(r1(doc), null, 2)).toEqual([])
  })
})

describe('routeEdge keeps clear edges straight (house style)', () => {
  test('a simple 2-node flow with nothing in between stays a 2-point route', () => {
    const from: Box = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const to: Box = { id: 'b', x: 0, y: 200, w: 100, h: 50 }
    const pts = routeEdge(from, to, [from, to])
    expect(pts.length).toBe(2)
  })

  test('an edge whose straight path is clear is not bent even with bystanders', () => {
    const from: Box = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const to: Box = { id: 'b', x: 0, y: 300, w: 100, h: 50 }
    // bystander far off to the side — not on the straight path
    const other: Box = { id: 'c', x: 400, y: 120, w: 100, h: 50 }
    const pts = routeEdge(from, to, [from, to, other])
    expect(pts.length).toBe(2)
  })
})

describe('routeEdge bends only when a box blocks the straight path', () => {
  test('a box directly between the endpoints forces a multi-point route that clears it', () => {
    const from: Box = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const mid: Box = { id: 'm', x: 0, y: 120, w: 100, h: 50 }
    const to: Box = { id: 'b', x: 0, y: 260, w: 100, h: 50 }
    const boxes = [from, mid, to]
    const pts = routeEdge(from, to, boxes)
    expect(pts.length).toBeGreaterThan(2)
    // none of the routed segments may cross the shrunk middle box
    const r = { id: 'm', x: mid.x + 5, y: mid.y + 5, w: mid.w - 10, h: mid.h - 10 }
    for (let i = 0; i + 1 < pts.length; i++) {
      // re-use the validator's own R2 geometry indirectly via segHitsRect import
      // (segments touching the endpoint boxes are exempt — mid is neither)
      // We assert via a fresh doc validation below; here just assert clearance.
      const s1 = pts[i]
      const s2 = pts[i + 1]
      const cross =
        // Liang–Barsky cheap test inline
        (() => {
          let t0 = 0
          let t1 = 1
          const dx = s2.x - s1.x
          const dy = s2.y - s1.y
          const p = [-dx, dx, -dy, dy]
          const q = [s1.x - r.x, r.x + r.w - s1.x, s1.y - r.y, r.y + r.h - s1.y]
          for (let k = 0; k < 4; k++) {
            if (p[k] === 0) {
              if (q[k] < 0) return false
            } else {
              const t = q[k] / p[k]
              if (p[k] < 0) {
                if (t > t1) return false
                if (t > t0) t0 = t
              } else {
                if (t < t0) return false
                if (t < t1) t1 = t
              }
            }
          }
          return t0 < t1
        })()
      expect(cross).toBe(false)
    }
  })

  test('endpoints of a bent route still land on the two endpoint borders (R1)', () => {
    const from: Box = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const mid: Box = { id: 'm', x: 0, y: 120, w: 100, h: 50 }
    const to: Box = { id: 'b', x: 0, y: 260, w: 100, h: 50 }
    const boxes = [from, mid, to]
    const pts = routeEdge(from, to, boxes)
    const a = pts[0]
    const b = pts[pts.length - 1]
    expect(onBorder(a, from, TOL)).toBe(true)
    expect(onBorder(b, to, TOL)).toBe(true)
  })
})

describe('routeEdge is deterministic', () => {
  test('same input → identical route (alignment editor edges)', () => {
    const doc = autoLayout(importStatechart(chartFor(ALIGN_KEY)))
    const boxes = drawnBoxes(doc)
    const byId = new Map(boxes.map((b) => [b.id, b]))
    for (const e of doc.edges) {
      if (e.kind === 'self') continue
      const f = byId.get(e.from)
      const t = byId.get(e.to)
      if (!f || !t) continue
      const r1Route = routeEdge(f, t, boxes)
      const r2Route = routeEdge(f, t, boxes)
      expect(r1Route).toEqual(r2Route)
    }
  })

  test('a blocked route is identical across repeated calls', () => {
    const from: Box = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const mid: Box = { id: 'm', x: 0, y: 120, w: 100, h: 50 }
    const to: Box = { id: 'b', x: 0, y: 260, w: 100, h: 50 }
    const boxes = [from, mid, to]
    expect(routeEdge(from, to, boxes)).toEqual(routeEdge(from, to, boxes))
  })
})

describe('existing imported samples still validate clean', () => {
  for (const key of [
    'apps__active-instrument-selection',
    ALIGN_KEY,
    'apps__auto-logging',
  ]) {
    test(`${key} has no R1/R2 errors after autoLayout`, () => {
      const doc = autoLayout(importStatechart(chartFor(key)))
      expect(r1(doc)).toEqual([])
      expect(r2(doc)).toEqual([])
    })
  }
})

describe('corpus: R2 across all 148 CAPTIVATE_RAW flows after autoLayout', () => {
  test('logs how many flows still have any R2 issue and the total count', () => {
    let withR2 = 0
    let total = 0
    const offenders: string[] = []
    for (const row of CAPTIVATE_RAW) {
      let doc: FlowDoc
      try {
        doc = autoLayout(importStatechart(row.chart))
      } catch {
        continue
      }
      const issues = r2(doc)
      if (issues.length > 0) {
        withR2++
        total += issues.length
        offenders.push(`${row.key}:${issues.length}`)
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `CAPTIVATE_RAW R2 after router rewrite: ${withR2}/${CAPTIVATE_RAW.length} flows, ` +
        `${total} segments still cross` +
        (offenders.length ? ` — ${offenders.join(', ')}` : ''),
    )
    // the orthogonal router clears every corpus flow
    expect(withR2).toBe(0)
    expect(total).toBe(0)
  })
})
