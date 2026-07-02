import { describe, expect, test } from 'vitest'
import {
  makeEmptyDoc,
  addNode,
  addEdge,
  moveEdgeLabel,
  edgeLabelAnchor,
  edgeLabelPos,
  toSvg,
  validateFlow,
} from '../index'
import type { FlowDoc } from '../model'

// A small two-node flow with a single forward edge carrying a label, laid out
// far enough apart that nothing clashes by default.
function labelledDoc(): { doc: FlowDoc; edgeId: string } {
  const { doc: d0, id: a } = addNode(makeEmptyDoc('T'), 'screen', { x: 200, y: 40 })
  const { doc: d1, id: b } = addNode(d0, 'success', { x: 200, y: 400 })
  const { doc: d2, id: edgeId } = addEdge(d1, a, b, { label: 'go' })
  return { doc: d2, edgeId }
}

describe('moveEdgeLabel', () => {
  test('sets labelOffset immutably and leaves other edges untouched', () => {
    const { doc, edgeId } = labelledDoc()
    const next = moveEdgeLabel(doc, edgeId, { dx: 30, dy: -12 })
    const edge = next.edges.find((e) => e.id === edgeId)!
    expect(edge.labelOffset).toEqual({ dx: 30, dy: -12 })
    // original unchanged
    expect(next).not.toBe(doc)
    expect(doc.edges.find((e) => e.id === edgeId)!.labelOffset).toBeUndefined()
  })

  test('a later move replaces the offset rather than accumulating', () => {
    const { doc, edgeId } = labelledDoc()
    const a = moveEdgeLabel(doc, edgeId, { dx: 10, dy: 10 })
    const b = moveEdgeLabel(a, edgeId, { dx: 50, dy: 5 })
    expect(b.edges.find((e) => e.id === edgeId)!.labelOffset).toEqual({ dx: 50, dy: 5 })
  })
})

describe('edgeLabelPos / edgeLabelAnchor', () => {
  test('with no offset, pos equals the anchor', () => {
    const { doc, edgeId } = labelledDoc()
    const edge = doc.edges.find((e) => e.id === edgeId)!
    const anchor = edgeLabelAnchor(doc, edge)
    const pos = edgeLabelPos(doc, edge)
    expect(pos).toEqual(anchor)
  })

  test('pos = anchor + offset', () => {
    const { doc, edgeId } = labelledDoc()
    const before = edgeLabelAnchor(doc, doc.edges.find((e) => e.id === edgeId)!)
    const moved = moveEdgeLabel(doc, edgeId, { dx: 40, dy: -25 })
    const edge = moved.edges.find((e) => e.id === edgeId)!
    // anchor is unchanged (nodes didn't move) and pos tracks the offset
    expect(edgeLabelAnchor(moved, edge)).toEqual(before)
    expect(edgeLabelPos(moved, edge)).toEqual({ x: before.x + 40, y: before.y - 25 })
  })

  test('self-edge label position also honours the offset', () => {
    const { doc: d0, id: a } = addNode(makeEmptyDoc('T'), 'screen', { x: 200, y: 200 })
    const { doc: d1, id: edgeId } = addEdge(d0, a, a, { label: 'retry' })
    const edge0 = d1.edges.find((e) => e.id === edgeId)!
    const anchor = edgeLabelAnchor(d1, edge0)
    const moved = moveEdgeLabel(d1, edgeId, { dx: 12, dy: 18 })
    const edge = moved.edges.find((e) => e.id === edgeId)!
    expect(edgeLabelPos(moved, edge)).toEqual({ x: anchor.x + 12, y: anchor.y + 18 })
  })
})

describe('toSvg honours labelOffset', () => {
  test('the label text coordinates shift by the offset', () => {
    const { doc, edgeId } = labelledDoc()
    const reText = />go<\/text>/
    // locate the <text ... >go</text> coordinates in both renders
    const coords = (svg: string): { x: number; y: number } => {
      const m = /<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>go<\/text>/.exec(svg)!
      expect(m).toBeTruthy()
      return { x: Number(m[1]), y: Number(m[2]) }
    }
    const base = toSvg(doc)
    expect(base).toMatch(reText)
    const before = coords(base)

    const moved = toSvg(moveEdgeLabel(doc, edgeId, { dx: 33, dy: -17 }))
    const after = coords(moved)
    expect(after.x).toBeCloseTo(before.x + 33, 1)
    expect(after.y).toBeCloseTo(before.y - 17, 1)
  })
})

describe('validateFlow R3 reflects the moved label position', () => {
  test('clean by default, flagged when dragged onto a node, clean again when cleared', () => {
    const { doc, edgeId } = labelledDoc()
    const clean = validateFlow(doc)
    expect(clean.issues.some((i) => i.rule === 'R3')).toBe(false)

    // drag the label down onto the target node box (centred ~ (290,426))
    const targetNode = doc.nodes.find((n) => n.role === 'success')!
    const edge = doc.edges.find((e) => e.id === edgeId)!
    const anchor = edgeLabelAnchor(doc, edge)
    const sz = targetNode.size ?? { w: 190, h: 54 }
    const boxCx = targetNode.pos.x + sz.w / 2
    const boxCy = targetNode.pos.y + sz.h / 2
    const onto = moveEdgeLabel(doc, edgeId, {
      dx: boxCx - anchor.x,
      dy: boxCy - anchor.y,
    })
    const flagged = validateFlow(onto)
    expect(flagged.issues.some((i) => i.rule === 'R3' && i.edgeId === edgeId)).toBe(true)

    // move it back clear (well to the left of every box)
    const clear = moveEdgeLabel(doc, edgeId, { dx: -200, dy: 0 })
    const clearRes = validateFlow(clear)
    expect(clearRes.issues.some((i) => i.rule === 'R3')).toBe(false)
  })
})
