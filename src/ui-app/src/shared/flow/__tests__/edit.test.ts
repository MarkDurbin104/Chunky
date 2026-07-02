import { describe, expect, test } from 'vitest'
import {
  makeEmptyDoc,
  addNode,
  updateNode,
  moveNode,
  removeNode,
  addEdge,
  updateEdge,
  removeEdge,
} from '../index'
import type { FlowDoc } from '../model'

function baseDoc(): FlowDoc {
  const { doc, id: a } = addNode(makeEmptyDoc('T'), 'screen', { x: 10, y: 20 })
  const { doc: d2, id: b } = addNode(doc, 'success', { x: 30, y: 200 })
  const { doc: d3 } = addEdge(d2, a, b)
  return d3
}

describe('makeEmptyDoc', () => {
  test('blank doc has a single start node and no edges', () => {
    const doc = makeEmptyDoc('Hello')
    expect(doc.title).toBe('Hello')
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0].role).toBe('start')
    expect(doc.nodes[0].label.length).toBeGreaterThan(0)
    expect(doc.edges).toEqual([])
  })

  test('default title and unique ids across calls', () => {
    const a = makeEmptyDoc()
    const b = makeEmptyDoc()
    expect(a.title.length).toBeGreaterThan(0)
    expect(a.id).not.toBe(b.id)
    expect(a.nodes[0].id).not.toBe(b.nodes[0].id)
  })
})

describe('addNode', () => {
  test('adds exactly one node with the given role/pos and a non-empty label', () => {
    const doc = makeEmptyDoc()
    const before = doc.nodes.length
    const { doc: next, id } = addNode(doc, 'screen', { x: 100, y: 150 })
    expect(next.nodes).toHaveLength(before + 1)
    const node = next.nodes.find((n) => n.id === id)!
    expect(node.role).toBe('screen')
    expect(node.pos).toEqual({ x: 100, y: 150 })
    expect(node.label.length).toBeGreaterThan(0)
    expect(node.size).toBeTruthy()
  })

  test('immutability: input unchanged, new reference returned', () => {
    const doc = makeEmptyDoc()
    const snapshotLen = doc.nodes.length
    const { doc: next } = addNode(doc, 'error', { x: 0, y: 0 })
    expect(next).not.toBe(doc)
    expect(next.nodes).not.toBe(doc.nodes)
    expect(doc.nodes).toHaveLength(snapshotLen)
  })

  test('partial overrides label but never id/role/pos source values', () => {
    const doc = makeEmptyDoc()
    const { doc: next, id } = addNode(
      doc,
      'screen',
      { x: 5, y: 6 },
      { label: 'Custom', subtitle: 'ctrl' },
    )
    const node = next.nodes.find((n) => n.id === id)!
    expect(node.label).toBe('Custom')
    expect(node.subtitle).toBe('ctrl')
    expect(node.pos).toEqual({ x: 5, y: 6 })
  })
})

describe('updateNode', () => {
  test('patch merge keeps id stable and other nodes untouched', () => {
    const doc = baseDoc()
    const target = doc.nodes[1]
    const other = doc.nodes[0]
    const next = updateNode(doc, target.id, { label: 'Renamed', subtitle: 's' })
    const updated = next.nodes.find((n) => n.id === target.id)!
    expect(updated.id).toBe(target.id)
    expect(updated.label).toBe('Renamed')
    expect(updated.subtitle).toBe('s')
    expect(updated.role).toBe(target.role)
    // unrelated node identity preserved
    expect(next.nodes.find((n) => n.id === other.id)).toBe(other)
  })

  test('immutable: original node object unchanged', () => {
    const doc = baseDoc()
    const target = doc.nodes[1]
    const next = updateNode(doc, target.id, { label: 'X' })
    expect(next).not.toBe(doc)
    expect(target.label).not.toBe('X')
  })
})

describe('moveNode', () => {
  test('updates pos only', () => {
    const doc = baseDoc()
    const target = doc.nodes[1]
    const next = moveNode(doc, target.id, { x: 999, y: 888 })
    const moved = next.nodes.find((n) => n.id === target.id)!
    expect(moved.pos).toEqual({ x: 999, y: 888 })
    expect(moved.label).toBe(target.label)
    expect(target.pos).not.toEqual({ x: 999, y: 888 })
  })
})

describe('removeNode', () => {
  test('cascades edges in both directions', () => {
    let doc = makeEmptyDoc()
    const r1 = addNode(doc, 'screen', { x: 0, y: 0 })
    const r2 = addNode(r1.doc, 'screen', { x: 0, y: 200 })
    const r3 = addNode(r2.doc, 'success', { x: 0, y: 400 })
    doc = r3.doc
    const mid = r2.id
    // incoming edge to mid, outgoing edge from mid
    doc = addEdge(doc, r1.id, mid).doc
    doc = addEdge(doc, mid, r3.id).doc
    expect(doc.edges).toHaveLength(2)
    const next = removeNode(doc, mid)
    expect(next.nodes.find((n) => n.id === mid)).toBeUndefined()
    expect(next.edges).toHaveLength(0)
    // original untouched
    expect(doc.edges).toHaveLength(2)
    expect(next).not.toBe(doc)
  })

  test('leaves unrelated edges intact', () => {
    const doc = baseDoc()
    const next = removeNode(doc, 'no-such-id')
    expect(next.nodes).toHaveLength(doc.nodes.length)
    expect(next.edges).toHaveLength(doc.edges.length)
  })
})

describe('addEdge', () => {
  test('defaults kind to forward when from !== to', () => {
    const doc = baseDoc()
    const a = doc.nodes[0].id
    const b = doc.nodes[1].id
    const { doc: next, id } = addEdge(doc, a, b)
    const edge = next.edges.find((e) => e.id === id)!
    expect(edge.kind).toBe('forward')
    expect(edge.events).toEqual([])
    expect(edge.label).toBe('')
    expect(edge.from).toBe(a)
    expect(edge.to).toBe(b)
  })

  test('defaults kind to self when from === to', () => {
    const doc = baseDoc()
    const a = doc.nodes[0].id
    const { doc: next, id } = addEdge(doc, a, a)
    const edge = next.edges.find((e) => e.id === id)!
    expect(edge.kind).toBe('self')
  })

  test('partial can override kind/events/label and immutability holds', () => {
    const doc = baseDoc()
    const a = doc.nodes[0].id
    const b = doc.nodes[1].id
    const beforeLen = doc.edges.length
    const { doc: next, id } = addEdge(doc, a, b, {
      kind: 'back',
      events: ['ESC'],
      label: 'cancel',
    })
    const edge = next.edges.find((e) => e.id === id)!
    expect(edge.kind).toBe('back')
    expect(edge.events).toEqual(['ESC'])
    expect(edge.label).toBe('cancel')
    expect(next).not.toBe(doc)
    expect(doc.edges).toHaveLength(beforeLen)
  })
})

describe('updateEdge', () => {
  test('patch merge keeps id stable and does not auto-change kind', () => {
    const doc = baseDoc()
    const target = doc.edges[0]
    const next = updateEdge(doc, target.id, {
      from: doc.nodes[0].id,
      to: doc.nodes[0].id,
      label: 'loop',
    })
    const updated = next.edges.find((e) => e.id === target.id)!
    expect(updated.id).toBe(target.id)
    expect(updated.from).toBe(updated.to)
    expect(updated.label).toBe('loop')
    // kind left untouched even though from === to now
    expect(updated.kind).toBe(target.kind)
    expect(target.label).not.toBe('loop')
  })
})

describe('removeEdge', () => {
  test('removes only the targeted edge, immutably', () => {
    const doc = baseDoc()
    const target = doc.edges[0]
    const next = removeEdge(doc, target.id)
    expect(next.edges.find((e) => e.id === target.id)).toBeUndefined()
    expect(next.nodes).toBe(doc.nodes)
    expect(doc.edges).toHaveLength(1)
    expect(next).not.toBe(doc)
  })
})
