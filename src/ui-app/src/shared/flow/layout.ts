// shared/flow/layout.ts — deterministic layered top-to-bottom auto-layout.
//
// BFS rank from the start node; each rank is a horizontal row; siblings spread
// across columns. Honours the style.ts rank gap (>=120) and column gap (>=60).
// transient nodes are not drawn but still take part in ranking so edges through
// them place sensibly; they are parked off to the side at their rank.

import type { FlowDoc, FlowEdge, FlowNode } from './model'
import { LABEL_STYLE, SPACING } from './style'
import { drawnBoxes, labelRect, nodeBox, type Box } from './geometry'

export function autoLayout(doc: FlowDoc): FlowDoc {
  if (doc.nodes.length === 0) return doc

  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const order = new Map(doc.nodes.map((n, i) => [n.id, i]))

  // Ranking uses ALL non-self edges (kind is a RENDER concern, not a topology
  // one): a back edge still tells us its target belongs earlier in the flow and
  // its source later. We then break cycles deterministically (by document edge
  // order) so longest-path ranking terminates.
  const directed: Array<{ from: string; to: string }> = []
  for (const e of doc.edges) {
    if (e.from === e.to) continue
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    directed.push({ from: e.from, to: e.to })
  }

  // Break cycles: a DFS that drops any edge closing a back-arc in the current
  // traversal (so the remaining graph is a DAG). Deterministic node visit order.
  const adj = new Map<string, string[]>()
  for (const n of doc.nodes) adj.set(n.id, [])
  for (const d of directed) adj.get(d.from)!.push(d.to)

  const dagAdj = new Map<string, string[]>()
  for (const n of doc.nodes) dagAdj.set(n.id, [])
  const state = new Map<string, 0 | 1 | 2>() // 0 unseen, 1 on-stack, 2 done
  const indeg = new Map<string, number>()
  for (const n of doc.nodes) indeg.set(n.id, 0)
  const dfs = (id: string) => {
    state.set(id, 1)
    for (const to of adj.get(id) ?? []) {
      const st = state.get(to) ?? 0
      if (st === 1) continue // back-arc -> drop from the DAG (keeps it acyclic)
      dagAdj.get(id)!.push(to)
      indeg.set(to, (indeg.get(to) ?? 0) + 1)
      if (st === 0) dfs(to)
    }
    state.set(id, 2)
  }
  // start DFS from start nodes first, then remaining in document order
  const dfsRoots = [
    ...doc.nodes.filter((n) => n.role === 'start').map((n) => n.id),
    ...doc.nodes.map((n) => n.id),
  ]
  for (const id of dfsRoots) if ((state.get(id) ?? 0) === 0) dfs(id)

  // Longest-path layering over the DAG (Kahn topological order).
  const rank = new Map<string, number>()
  for (const n of doc.nodes) rank.set(n.id, 0)
  const ready: string[] = doc.nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort((a, b) => order.get(a)! - order.get(b)!)
  const deg = new Map(indeg)
  while (ready.length) {
    const id = ready.shift()!
    const r = rank.get(id)!
    for (const to of dagAdj.get(id) ?? []) {
      if (r + 1 > rank.get(to)!) rank.set(to, r + 1)
      deg.set(to, deg.get(to)! - 1)
      if (deg.get(to)! === 0) {
        ready.push(to)
        ready.sort((a, b) => order.get(a)! - order.get(b)!)
      }
    }
  }

  // group node ids by rank, preserving document order for determinism
  const ranks = new Map<number, string[]>()
  for (const n of doc.nodes) {
    const r = rank.get(n.id)!
    const arr = ranks.get(r) ?? []
    arr.push(n.id)
    ranks.set(r, arr)
  }

  // widths per rank to lay out columns; compute row height from tallest node
  const maxWidth = Math.max(...doc.nodes.map((n) => nodeBox(n).w))
  const colStride = maxWidth + SPACING.colGap
  const rowStride = (() => {
    const maxH = Math.max(...doc.nodes.map((n) => nodeBox(n).h))
    return maxH + SPACING.rankGap
  })()

  const placed: FlowNode[] = doc.nodes.map((n) => ({
    ...n,
    pos: { ...n.pos },
  }))
  const placedById = new Map(placed.map((n) => [n.id, n]))

  const sortedRanks = [...ranks.keys()].sort((a, b) => a - b)
  // widest rank determines centering reference
  const widestCount = Math.max(...[...ranks.values()].map((a) => a.length))
  const totalWidth = widestCount * colStride

  for (const r of sortedRanks) {
    const ids = ranks.get(r)!
    const rowWidth = ids.length * colStride
    const startX = (totalWidth - rowWidth) / 2
    ids.forEach((id, i) => {
      const node = placedById.get(id)!
      const b = nodeBox(node)
      const cellLeft = startX + i * colStride
      // center each node within its column cell
      node.pos = {
        x: Math.round(cellLeft + (colStride - b.w) / 2),
        y: r * rowStride,
      }
    })
  }

  return declashLabels({ ...doc, nodes: placed })
}

// ── Label de-clash ──────────────────────────────────────────────────────────
//
// Assign edge.labelOffset so no two VISIBLE edge-label boxes overlap and no
// label box overlaps a node box. Uses geometry.labelRect for every box so the
// result is consistent with the R3 validator. Deterministic (no Math.random /
// Date) and idempotent: running it twice yields the same doc.

const LABEL_H = LABEL_STYLE.size + 2 * LABEL_STYLE.backingPadY
const STEP = LABEL_H + 4 //          generic outward search step (~px)
const SELF_PITCH = LABEL_H + 6 //    fixed vertical pitch for stacked self labels
const MAX_RING = 14 //               cap the outward search

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** The label box for `edge` evaluated with a TRIAL offset (does not mutate). */
function rectAt(doc: FlowDoc, edge: FlowEdge, off: { dx: number; dy: number }): Box {
  return labelRect(doc, { ...edge, labelOffset: off })
}

/** Deterministic candidate offsets, expanding outward: vertical first (up then
 * down at each ring), then horizontal, then the diagonals. Always begins at
 * {0,0} so an edge that already clears stays put. */
function candidateOffsets(): Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [{ dx: 0, dy: 0 }]
  for (let k = 1; k <= MAX_RING; k++) {
    const d = k * STEP
    out.push({ dx: 0, dy: -d })
    out.push({ dx: 0, dy: d })
    out.push({ dx: -d, dy: 0 })
    out.push({ dx: d, dy: 0 })
    out.push({ dx: -d, dy: -d })
    out.push({ dx: d, dy: -d })
    out.push({ dx: -d, dy: d })
    out.push({ dx: d, dy: d })
  }
  return out
}

export function declashLabels(doc: FlowDoc): FlowDoc {
  const labelled = doc.edges.filter((e) => e.label && e.label.length > 0)
  if (labelled.length === 0) return doc

  const nodeBoxes = drawnBoxes(doc)
  // Boxes already claimed by placed labels; seed with manually-offset edges so
  // those stay fixed and everything else routes around them.
  const placed: Box[] = []
  const newOffsets = new Map<string, { dx: number; dy: number }>()

  // Edges whose labelOffset is already set are treated as fixed/placed first.
  const indexOf = new Map(doc.edges.map((e, i) => [e.id, i]))
  const fixed = labelled
    .filter((e) => e.labelOffset)
    .sort((a, b) => indexOf.get(a.id)! - indexOf.get(b.id)!)
  for (const e of fixed) placed.push(labelRect(doc, e))

  // Group the remaining self-edges by their node so we can stack them with a
  // fixed pitch beside the box rather than relying on the generic search.
  const free = labelled
    .filter((e) => !e.labelOffset)
    .sort((a, b) => indexOf.get(a.id)! - indexOf.get(b.id)!)

  const selfByNode = new Map<string, FlowEdge[]>()
  for (const e of free) {
    if (e.kind === 'self') {
      const arr = selfByNode.get(e.from) ?? []
      arr.push(e)
      selfByNode.set(e.from, arr)
    }
  }

  const handledSelf = new Set<string>()

  const clears = (rect: Box): boolean =>
    !placed.some((p) => boxesOverlap(rect, p)) &&
    !nodeBoxes.some((n) => boxesOverlap(rect, n))

  // Score for the least-bad fallback: total overlap area against placed labels
  // and nodes (smaller is better).
  const badness = (rect: Box): number => {
    let area = 0
    for (const p of [...placed, ...nodeBoxes]) {
      const ox = Math.max(0, Math.min(rect.x + rect.w, p.x + p.w) - Math.max(rect.x, p.x))
      const oy = Math.max(0, Math.min(rect.y + rect.h, p.y + p.h) - Math.max(rect.y, p.y))
      area += ox * oy
    }
    return area
  }

  const placeWithOffset = (e: FlowEdge, off: { dx: number; dy: number }) => {
    const rect = rectAt(doc, e, off)
    placed.push(rect)
    if (off.dx !== 0 || off.dy !== 0) newOffsets.set(e.id, off)
  }

  const cands = candidateOffsets()

  for (const e of free) {
    if (e.kind === 'self' && handledSelf.has(e.id)) continue

    // SPECIAL CASE: a node with several self-edges. Stack their labels with a
    // fixed vertical pitch, centred on the anchor, so the 5-self case spreads
    // cleanly. Single self-edges fall through to the generic search.
    if (e.kind === 'self') {
      const group = selfByNode.get(e.from)!
      if (group.length > 1) {
        const n = group.length
        group.forEach((se, i) => {
          handledSelf.add(se.id)
          // centre the stack on the anchor: offsets …,-pitch,0,+pitch,…
          const dy = Math.round((i - (n - 1) / 2) * SELF_PITCH)
          let off = { dx: 0, dy }
          // if that slot still collides, nudge it out generically
          if (!clears(rectAt(doc, se, off))) {
            let best = off
            let bestBad = badness(rectAt(doc, se, off))
            for (const c of cands) {
              const trial = { dx: c.dx, dy: dy + c.dy }
              const r = rectAt(doc, se, trial)
              if (clears(r)) {
                best = trial
                bestBad = -1
                break
              }
              const bad = badness(r)
              if (bad < bestBad) {
                bestBad = bad
                best = trial
              }
            }
            off = best
          }
          placeWithOffset(se, off)
        })
        continue
      }
    }

    // Generic: start at {0,0}; first candidate offset that clears wins. If none
    // clears within the cap, keep the least-bad.
    let chosen = { dx: 0, dy: 0 }
    let chosenBad = Infinity
    let cleared = false
    for (const c of cands) {
      const r = rectAt(doc, e, c)
      if (clears(r)) {
        chosen = c
        cleared = true
        break
      }
      const bad = badness(r)
      if (bad < chosenBad) {
        chosenBad = bad
        chosen = c
      }
    }
    void cleared
    placeWithOffset(e, chosen)
  }

  if (newOffsets.size === 0) return doc
  return {
    ...doc,
    edges: doc.edges.map((e) => {
      const off = newOffsets.get(e.id)
      return off ? { ...e, labelOffset: off } : e
    }),
  }
}
