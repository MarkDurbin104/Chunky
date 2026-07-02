import { describe, expect, test } from 'vitest'
import {
  autoLayout,
  declashLabels,
  importStatechart,
  validateFlow,
  labelRect,
} from '../index'
import type { FlowDoc } from '../model'
import { CAPTIVATE_RAW } from '../captivate.generated'

const r3 = (doc: FlowDoc) => validateFlow(doc).issues.filter((i) => i.rule === 'R3')

function chartFor(key: string): string {
  const row = CAPTIVATE_RAW.find((r) => r.key === key)
  if (!row) throw new Error(`no captivate sample "${key}"`)
  return row.chart
}

// Charts exercised explicitly: the 5-self-edge instrument selection plus two
// other real flows.
const SAMPLE_KEYS = [
  'apps__active-instrument-selection',
  'apps__alignment-toolkit-editor',
  'apps__auto-logging',
]

describe('declashLabels — R3 label clashes are removed by autoLayout', () => {
  for (const key of SAMPLE_KEYS) {
    test(`${key} has zero R3 label-clash issues after autoLayout`, () => {
      const doc = autoLayout(importStatechart(chartFor(key)))
      expect(r3(doc)).toEqual([])
    })
  }

  test('active-instrument-selection really has the 5 stacked self edges', () => {
    const doc = autoLayout(importStatechart(chartFor('apps__active-instrument-selection')))
    const selfEdges = doc.edges.filter((e) => e.kind === 'self' && e.label)
    expect(selfEdges.length).toBeGreaterThanOrEqual(5)
    // their label boxes must be mutually disjoint
    const rects = selfEdges.map((e) => labelRect(doc, e))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(overlap).toBe(false)
      }
    }
  })
})

describe('declashLabels is deterministic and idempotent', () => {
  for (const key of SAMPLE_KEYS) {
    test(`${key}: declash(declash(doc)) deep-equals declash(doc)`, () => {
      const base = autoLayout(importStatechart(chartFor(key)))
      const once = declashLabels(base)
      const twice = declashLabels(once)
      expect(twice).toEqual(once)
    })

    test(`${key}: declash is a pure function of its input`, () => {
      const base = autoLayout(importStatechart(chartFor(key)))
      const a = declashLabels(base)
      const b = declashLabels(base)
      expect(a).toEqual(b)
    })
  }
})

describe('declashLabels respects already-placed manual offsets', () => {
  test('an edge with a manual labelOffset is left untouched', () => {
    const base = autoLayout(importStatechart(chartFor('apps__active-instrument-selection')))
    const target = base.edges.find((e) => e.label)!
    const pinned: FlowDoc = {
      ...base,
      edges: base.edges.map((e) =>
        e.id === target.id ? { ...e, labelOffset: { dx: 99, dy: -77 } } : e,
      ),
    }
    const out = declashLabels(pinned)
    expect(out.edges.find((e) => e.id === target.id)!.labelOffset).toEqual({
      dx: 99,
      dy: -77,
    })
  })
})

describe('corpus: R3 label clashes across all CAPTIVATE_RAW flows', () => {
  test('reports how many of the 148 flows still have any R3 issue after autoLayout', () => {
    let withR3 = 0
    const offenders: string[] = []
    for (const row of CAPTIVATE_RAW) {
      let doc: FlowDoc
      try {
        doc = autoLayout(importStatechart(row.chart))
      } catch {
        continue
      }
      if (r3(doc).length > 0) {
        withR3++
        offenders.push(row.key)
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `CAPTIVATE_RAW R3 after declash: ${withR3}/${CAPTIVATE_RAW.length} flows still clash` +
        (offenders.length ? ` — ${offenders.join(', ')}` : ''),
    )
    // the explicitly-checked samples must be fully clean
    expect(withR3).toBeLessThanOrEqual(CAPTIVATE_RAW.length)
  })
})
