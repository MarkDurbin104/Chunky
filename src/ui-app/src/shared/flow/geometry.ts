// shared/flow/geometry.ts — pure geometry helpers shared by the SVG
// projection and the validator, so both reason about the SAME boxes and the
// SAME clamped endpoints. No framework imports.

import type { FlowDoc, FlowEdge, FlowNode } from './model'
import { LABEL_STYLE, nodeSize } from './style'

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
}

/** Axis-aligned box for a node from pos + (defaulted) size. transient nodes
 * are not drawn, so they are excluded from the drawn-box set. */
export function nodeBox(n: FlowNode): Box {
  const s = nodeSize(n.role, n.size)
  return { id: n.id, x: n.pos.x, y: n.pos.y, w: s.w, h: s.h }
}

export function drawnBoxes(doc: FlowDoc): Box[] {
  return doc.nodes.filter((n) => n.role !== 'transient').map(nodeBox)
}

export function boxCenter(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/**
 * Clamp a ray from the center of `b` towards `toward` onto the box border.
 * Returns the point where the center→toward line exits the box rectangle.
 */
export function clampToBorder(b: Box, toward: Pt): Pt {
  const c = boxCenter(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return { x: b.x + b.w, y: c.y }
  const hw = b.w / 2
  const hh = b.h / 2
  // scale so the larger axis just reaches the border
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx)
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: c.x + dx * s, y: c.y + dy * s }
}

/** The two endpoints of a forward/back edge.
 *
 * When the boxes FACE each other we return a STRAIGHT axis-aligned connector that
 * enters the facing SIDES at a shared coordinate, instead of the centre-to-centre
 * clamp (which would be diagonal and meet the corners):
 *
 *  • vertical spans overlap AND one box is entirely left/right of the other →
 *    HORIZONTAL connector: exit the right border of the left box and the left
 *    border of the right box at a SHARED y inside the overlap band.
 *  • horizontal spans overlap AND one box is entirely above/below the other →
 *    VERTICAL connector: exit the bottom/top borders at a SHARED x.
 *
 * Only genuinely diagonal arrangements (no span overlap on either axis) fall back
 * to the centre-ray clamp. */
export function edgeEndpoints(from: Box, to: Box): { a: Pt; b: Pt } {
  const ca = boxCenter(from)
  const cb = boxCenter(to)

  // overlap of the two boxes' spans on each axis
  const vLo = Math.max(from.y, to.y)
  const vHi = Math.min(from.y + from.h, to.y + to.h)
  const hLo = Math.max(from.x, to.x)
  const hHi = Math.min(from.x + from.w, to.x + to.w)
  const vOverlap = vHi - vLo //   shared vertical band (sides face)
  const hOverlap = hHi - hLo //   shared horizontal band (top/bottom face)

  const horizSeparated = from.x + from.w <= to.x || to.x + to.w <= from.x
  const vertSeparated = from.y + from.h <= to.y || to.y + to.h <= from.y

  // Prefer the axis with the larger facing band so a near-square arrangement
  // picks the dominant facing direction deterministically.
  const canHorizontal = vOverlap > 0 && horizSeparated
  const canVertical = hOverlap > 0 && vertSeparated

  if (canHorizontal && (!canVertical || vOverlap >= hOverlap)) {
    const y = (vLo + vHi) / 2 // shared y in the overlap band, on both sides
    const leftIsFrom = from.x + from.w <= to.x
    const a: Pt = leftIsFrom ? { x: from.x + from.w, y } : { x: from.x, y }
    const b: Pt = leftIsFrom ? { x: to.x, y } : { x: to.x + to.w, y }
    return { a, b }
  }
  if (canVertical) {
    const x = (hLo + hHi) / 2 // shared x in the overlap band, on both faces
    const topIsFrom = from.y + from.h <= to.y
    const a: Pt = topIsFrom ? { x, y: from.y + from.h } : { x, y: from.y }
    const b: Pt = topIsFrom ? { x, y: to.y } : { x, y: to.y + to.h }
    return { a, b }
  }

  // genuinely diagonal — clamp each centre-ray to its border
  return {
    a: clampToBorder(from, cb),
    b: clampToBorder(to, ca),
  }
}

/** A self-loop arc anchored on the right side of the box; returns sample pts
 * (start, apex, end) used for both rendering and validation. */
export function selfLoopPoints(b: Box): { start: Pt; apex: Pt; end: Pt } {
  const x = b.x + b.w
  const yTop = b.y + b.h * 0.32
  const yBot = b.y + b.h * 0.68
  return {
    start: { x, y: yTop },
    apex: { x: x + 36, y: b.y + b.h / 2 },
    end: { x, y: yBot },
  }
}

// ---- Liang–Barsky segment vs axis-aligned rect intersection ----
export function segHitsRect(p1: Pt, p2: Pt, r: Box): boolean {
  let t0 = 0
  let t1 = 1
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const p = [-dx, dx, -dy, dy]
  const q = [p1.x - r.x, r.x + r.w - p1.x, p1.y - r.y, r.y + r.h - p1.y]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return t0 < t1
}

/** Distance helper: is point `p` on/near the border of box `n` within tol. */
export function onBorder(p: Pt, n: Box, tol: number): boolean {
  const insideExp =
    p.x >= n.x - tol &&
    p.x <= n.x + n.w + tol &&
    p.y >= n.y - tol &&
    p.y <= n.y + n.h + tol
  if (!insideExp) return false
  const dB = Math.min(
    Math.abs(p.x - n.x),
    Math.abs(p.x - (n.x + n.w)),
    Math.abs(p.y - n.y),
    Math.abs(p.y - (n.y + n.h)),
  )
  const deepInside =
    p.x > n.x + tol &&
    p.x < n.x + n.w - tol &&
    p.y > n.y + tol &&
    p.y < n.y + n.h - tol
  return dB <= tol || deepInside
}

// Routing margin: how far OUTSIDE a box the orthogonal channels run. Must be
// larger than the validator's R2 SHRINK (5px) so a channel segment grazing a
// box's inflated edge still clears the box the validator actually tests, and
// large enough to read as a real gap in the diagram.
const ROUTE_MARGIN = 16

/** Blockers shrunk by R2's SHRINK (5px) — the exact rectangles the validator
 * tests a segment against. A route is "R2-clean" iff no segment crosses any of
 * these (segments touching their OWN endpoint box are exempt by the caller). */
function shrunkBlocker(n: Box): Box {
  return { id: n.id, x: n.x + 5, y: n.y + 5, w: n.w - 10, h: n.h - 10 }
}

/** Does segment p1→p2 cross any shrunk blocker? */
function crossesAny(p1: Pt, p2: Pt, blockers: Box[]): boolean {
  for (const n of blockers) {
    const r = shrunkBlocker(n)
    if (r.w > 0 && r.h > 0 && segHitsRect(p1, p2, r)) return true
  }
  return false
}

/** Pick the border point of `b` on the side facing `toward`, at the coordinate
 * of `toward` clamped to that side's span — so an orthogonal first/last segment
 * meets the box squarely. Falls back to the centre-ray clamp for diagonals. */
function borderAnchor(b: Box, toward: Pt): Pt {
  const c = boxCenter(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    // exit left/right face
    const x = dx >= 0 ? b.x + b.w : b.x
    const y = Math.min(Math.max(toward.y, b.y + 4), b.y + b.h - 4)
    return { x, y }
  }
  const y = dy >= 0 ? b.y + b.h : b.y
  const x = Math.min(Math.max(toward.x, b.x + 4), b.x + b.w - 4)
  return { x, y }
}

/** Drop consecutive duplicate points and collapse collinear runs (axis-aligned
 * or general) so the returned polyline carries no redundant vertices. */
function simplify(pts: Pt[]): Pt[] {
  const dedup: Pt[] = []
  for (const p of pts) {
    const last = dedup[dedup.length - 1]
    if (!last || Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.y - p.y) > 1e-6) {
      dedup.push(p)
    }
  }
  if (dedup.length <= 2) return dedup
  const out: Pt[] = [dedup[0]]
  for (let i = 1; i + 1 < dedup.length; i++) {
    const a = out[out.length - 1]
    const b = dedup[i]
    const c = dedup[i + 1]
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    if (Math.abs(cross) > 1e-6) out.push(b)
  }
  out.push(dedup[dedup.length - 1])
  return out
}

/** Sorted, de-duplicated numeric axis from a set of candidate coordinates. */
function axis(values: number[]): number[] {
  const uniq: number[] = []
  for (const v of [...values].sort((p, q) => p - q)) {
    if (uniq.length === 0 || Math.abs(uniq[uniq.length - 1] - v) > 1e-6) uniq.push(v)
  }
  return uniq
}

/**
 * Route a forward/back edge from box `from` to box `to` as a polyline that
 * AVOIDS every box except the two endpoint boxes. Deterministic.
 *
 *  1. STRAIGHT first: if the direct border-to-border segment clears every
 *     non-endpoint box (same SHRINK margin R2 uses) return the 2-point route —
 *     most edges stay straight, preserving the house style.
 *  2. Otherwise compute an ORTHOGONAL (Manhattan) route over a visibility grid
 *     built from each blocker's edges inflated by ROUTE_MARGIN, the endpoint
 *     anchors' coordinates, and the content bounds. A* over the grid (Dijkstra
 *     with a Manhattan heuristic) finds the shortest path that crosses no
 *     inflated box, penalising turns so the result favours few bends. Collinear
 *     / duplicate points are simplified before returning.
 *  3. Endpoints land ON the source/target borders (R1 stays green); the
 *     first/last segment is allowed to touch its own endpoint box.
 *  4. If no fully-clear orthogonal route exists, fall back to the straight
 *     segment (the validator may then flag it).
 *
 * Both the SVG projection and the validator call this, so they agree exactly.
 */
export function routeEdge(
  from: Box,
  to: Box,
  others: Box[],
): Pt[] {
  const { a, b } = edgeEndpoints(from, to)
  const blockers = others.filter((n) => n.id !== from.id && n.id !== to.id)

  // 1 — straight clamped centre-to-centre segment, if it clears all blockers.
  if (!crossesAny(a, b, blockers)) return [a, b]

  // 2 — orthogonal grid route. Anchor endpoints on the facing border so the
  // first/last leg meets the box squarely.
  const start = borderAnchor(from, boxCenter(to))
  const goal = borderAnchor(to, boxCenter(from))

  // Candidate grid coordinates: each blocker edge ± margin, the endpoint boxes'
  // edges ± margin, the anchors themselves, and an outer ring around everything.
  const allBoxes = [from, to, ...blockers]
  const xs: number[] = [start.x, goal.x]
  const ys: number[] = [start.y, goal.y]
  for (const n of allBoxes) {
    xs.push(n.x - ROUTE_MARGIN, n.x + n.w + ROUTE_MARGIN)
    ys.push(n.y - ROUTE_MARGIN, n.y + n.h + ROUTE_MARGIN)
  }
  const minX = Math.min(...xs) - ROUTE_MARGIN
  const maxX = Math.max(...xs) + ROUTE_MARGIN
  const minY = Math.min(...ys) - ROUTE_MARGIN
  const maxY = Math.max(...ys) + ROUTE_MARGIN
  xs.push(minX, maxX)
  ys.push(minY, maxY)

  const gx = axis(xs)
  const gy = axis(ys)
  const nx = gx.length
  const ny = gy.length

  const idx = (i: number, j: number) => j * nx + i
  const startI = gx.indexOf(start.x)
  const startJ = gy.indexOf(start.y)
  const goalI = gx.indexOf(goal.x)
  const goalJ = gy.indexOf(goal.y)

  // A node→node move is allowed iff its segment crosses no shrunk blocker.
  // Segments incident to start/goal are exempt from their OWN endpoint box: the
  // anchors sit on those borders, and crossesAny() already excludes from/to.
  const passable = (p1: Pt, p2: Pt) => !crossesAny(p1, p2, blockers)

  // Dijkstra/A* over the grid; cost = manhattan length + turn penalty. State is
  // (cell, incoming direction) so turns can be penalised deterministically.
  const TURN = 40 // px-equivalent penalty per bend (favours straighter routes)
  const dist = new Map<string, number>()
  const prev = new Map<string, { key: string; pt: Pt }>()
  const key = (i: number, j: number, dir: number) => `${i},${j},${dir}`
  // dir: 0 none, 1 horizontal, 2 vertical
  const h = (i: number, j: number) =>
    Math.abs(gx[i] - goal.x) + Math.abs(gy[j] - goal.y)

  type QN = { i: number; j: number; dir: number; g: number; f: number; k: string }
  const open: QN[] = []
  const push = (qn: QN) => {
    // binary insert keeps the frontier ordered without a heap dependency
    let lo = 0
    let hi = open.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (open[mid].f < qn.f) lo = mid + 1
      else hi = mid
    }
    open.splice(lo, 0, qn)
  }

  const sk = key(startI, startJ, 0)
  dist.set(sk, 0)
  push({ i: startI, j: startJ, dir: 0, g: 0, f: h(startI, startJ), k: sk })

  let goalKey: string | null = null
  const dirs = [
    { di: 1, dj: 0, d: 1 },
    { di: -1, dj: 0, d: 1 },
    { di: 0, dj: 1, d: 2 },
    { di: 0, dj: -1, d: 2 },
  ]

  while (open.length) {
    const cur = open.shift()!
    if (cur.g > (dist.get(cur.k) ?? Infinity)) continue
    if (cur.i === goalI && cur.j === goalJ) {
      goalKey = cur.k
      break
    }
    const p1: Pt = { x: gx[cur.i], y: gy[cur.j] }
    for (const { di, dj, d } of dirs) {
      const ni = cur.i + di
      const nj = cur.j + dj
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue
      const p2: Pt = { x: gx[ni], y: gy[nj] }
      if (!passable(p1, p2)) continue
      const step = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y)
      const turn = cur.dir !== 0 && cur.dir !== d ? TURN : 0
      const ng = cur.g + step + turn
      const nk = key(ni, nj, d)
      if (ng < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, ng)
        prev.set(nk, { key: cur.k, pt: p1 })
        push({ i: ni, j: nj, dir: d, g: ng, f: ng + h(ni, nj), k: nk })
      }
    }
  }

  if (goalKey !== null) {
    const path: Pt[] = [goal]
    let k: string | undefined = goalKey
    while (k && k !== sk) {
      const p = prev.get(k)
      if (!p) break
      path.push(p.pt)
      k = p.key
    }
    path.reverse()
    return simplify(path)
  }

  // 4 — no clear orthogonal route: keep the straight segment (R2 may flag it).
  return [a, b]
}

// ─── Global lane separation ──────────────────────────────────────────────────
//
// routeEdge is PER-edge: where several edges happen to run along the same column
// (same x) or row (same y) their orthogonal segments land exactly on top of one
// another and read as a single line. routeAllEdges() base-routes every non-self
// edge with routeEdge, then SEPARATES overlapping collinear interior runs onto
// parallel "tracks" (like PCB traces). Crossings are fine; overlaying is not.
//
// Terminal points (the first/last vertex, which sit on the source/target border)
// are never moved, so R1 stays green. Each lane shift is safety-checked against
// the SHRUNK blockers the validator tests, so R2 stays 0. Deterministic.

const LANE_GAP = 7 //   px between parallel tracks in a shared channel
const LANE_TOL = 2 //   px: collinear coords within this share a channel
const LANE_MIN_OVERLAP = 4 // px: spans must overlap by more than this to clash

interface Seg {
  edgeId: string //   which edge this segment belongs to
  ptsIndex: number // which polyline in the working set
  i: number //        segment is pts[i] -> pts[i+1]
  axis: 'v' | 'h' //  vertical (constant x) or horizontal (constant y)
  coord: number //    the constant coordinate (x for v, y for h)
  lo: number //       span start along the free axis
  hi: number //       span end along the free axis
  movableLo: boolean // start corner may move (not a terminal border point)
  movableHi: boolean // end corner may move
  routeLen: number //  vertex count of the whole route this segment belongs to
}

/** Axis-aligned interior segments of a polyline that are eligible for laning.
 * A corner is "movable" iff it is NOT a terminal vertex (terminals sit on a node
 * border and must stay put to keep R1). */
function axisSegments(edgeId: string, ptsIndex: number, pts: Pt[]): Seg[] {
  const segs: Seg[] = []
  const n = pts.length
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = Math.abs(a.x - b.x)
    const dy = Math.abs(a.y - b.y)
    let ax: 'v' | 'h' | null = null
    if (dx <= 1e-6 && dy > 1e-6) ax = 'v'
    else if (dy <= 1e-6 && dx > 1e-6) ax = 'h'
    if (!ax) continue
    const coord = ax === 'v' ? a.x : a.y
    const s0 = ax === 'v' ? a.y : a.x
    const s1 = ax === 'v' ? b.y : b.x
    const lo = Math.min(s0, s1)
    const hi = Math.max(s0, s1)
    // terminal vertices are pts[0] and pts[n-1]: never movable
    const startTerminal = i === 0
    const endTerminal = i + 1 === n - 1
    segs.push({
      edgeId,
      ptsIndex,
      i,
      axis: ax,
      coord,
      lo,
      hi,
      movableLo: !startTerminal,
      movableHi: !endTerminal,
      routeLen: n,
    })
  }
  return segs
}

/** True if two 1-D spans overlap by more than LANE_MIN_OVERLAP. */
function spansOverlap(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return Math.min(aHi, bHi) - Math.max(aLo, bLo) > LANE_MIN_OVERLAP
}

/** Group segments of one axis into channels of mutually-overlapping collinear
 * runs. Two segments share a channel iff same axis, |coord| within LANE_TOL, and
 * spans overlap. Transitive closure via union-find keeps the grouping stable. */
function channelsFor(segs: Seg[]): Seg[][] {
  const parent = segs.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]
      const b = segs[j]
      if (a.axis !== b.axis) continue
      if (Math.abs(a.coord - b.coord) > LANE_TOL) continue
      if (!spansOverlap(a.lo, a.hi, b.lo, b.hi)) continue
      union(i, j)
    }
  }
  const groups = new Map<number, Seg[]>()
  for (let i = 0; i < segs.length; i++) {
    const r = find(i)
    const arr = groups.get(r) ?? []
    arr.push(segs[i])
    groups.set(r, arr)
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

/** A segment can be laned either by SHIFTING (both corners movable -> slides as a
 * rigid parallel track, neighbouring stubs lengthen) or by SPLITTING (a whole
 * 2-point straight route, both corners terminal -> we jog its middle onto a lane
 * while the two border endpoints stay put). Single-fixed-corner interior runs are
 * NOT laneable: shifting them would bend them into a diagonal. */
function laneable(seg: Seg): boolean {
  if (seg.movableLo && seg.movableHi) return true // shiftable interior run
  if (seg.routeLen === 2) return true //              splittable straight route
  if (seg.movableLo !== seg.movableHi) return true // one fixed corner -> stub-jog
  return false
}

/** Replace a 2-point straight route [a,b] with a 4-point jogged route whose
 * middle run sits on the lane (constant coord shifted by delta), keeping the two
 * terminal border points a,b exactly where routeEdge put them so R1 holds. The
 * two short jog stubs at each end carry the run out to the lane and back. */
function splitStraight(pts: Pt[], seg: Seg, delta: number): Pt[] {
  const a = pts[0]
  const b = pts[1]
  if (seg.axis === 'v') {
    const x = a.x + delta
    return [
      { x: a.x, y: a.y },
      { x, y: a.y },
      { x, y: b.y },
      { x: b.x, y: b.y },
    ]
  }
  const y = a.y + delta
  return [
    { x: a.x, y: a.y },
    { x: a.x, y },
    { x: b.x, y },
    { x: b.x, y: b.y },
  ]
}

/** Apply a constant-coordinate shift to a lane-able segment in a working
 * polyline, sliding BOTH its (movable) corner points so the segment stays
 * axis-aligned and the polyline stays connected. Does NOT mutate `pts`. */
function shiftSegment(pts: Pt[], seg: Seg, delta: number): Pt[] {
  const next = pts.map((p) => ({ x: p.x, y: p.y }))
  const a = next[seg.i]
  const b = next[seg.i + 1]
  if (seg.axis === 'v') {
    a.x += delta
    b.x += delta
  } else {
    a.y += delta
    b.y += delta
  }
  return next
}

/** Shift a segment that has exactly ONE movable corner (the other is a terminal
 * border point that must stay put). The movable corner slides by delta; a short
 * perpendicular STUB is inserted at the fixed corner so the terminal keeps its
 * coordinate while the long run moves onto its lane. The neighbour segment at the
 * movable corner is perpendicular to this one, so sliding that corner only grows
 * /shrinks it — the polyline stays orthogonal. Does NOT mutate `pts`. */
function shiftSegmentStub(pts: Pt[], seg: Seg, delta: number): Pt[] {
  const next = pts.map((p) => ({ x: p.x, y: p.y }))
  const i = seg.i
  const movableIsLo = seg.movableLo // pts[i] movable, pts[i+1] terminal
  if (seg.axis === 'h') {
    if (movableIsLo) {
      // pts[i] moves, pts[i+1] fixed -> run at y+delta, stub down to pts[i+1]
      const run = next[i].y + delta
      next[i].y = run
      const fixed = next[i + 1]
      next.splice(i + 1, 0, { x: fixed.x, y: run })
    } else {
      // pts[i] fixed, pts[i+1] moves
      const run = next[i + 1].y + delta
      next[i + 1].y = run
      const fixed = next[i]
      next.splice(i + 1, 0, { x: fixed.x, y: run })
    }
  } else {
    if (movableIsLo) {
      const run = next[i].x + delta
      next[i].x = run
      const fixed = next[i + 1]
      next.splice(i + 1, 0, { x: run, y: fixed.y })
    } else {
      const run = next[i + 1].x + delta
      next[i + 1].x = run
      const fixed = next[i]
      next.splice(i + 1, 0, { x: run, y: fixed.y })
    }
  }
  return next
}

/** Is a whole polyline R2-clean? Mirrors validate.ts exactly: every segment is
 * tested against every box's SHRUNK rect, but a segment touching that box's
 * border (within TOL) is exempt (it terminates on it). Used to verify a trial
 * lane shift keeps R2 = 0 before committing. */
function polylineR2Clean(pts: Pt[], boxes: Box[]): boolean {
  for (const n of boxes) {
    const r = shrunkBlocker(n)
    if (r.w <= 0 || r.h <= 0) continue
    for (let i = 0; i + 1 < pts.length; i++) {
      const s1 = pts[i]
      const s2 = pts[i + 1]
      if (onBorder(s1, n, 11) || onBorder(s2, n, 11)) continue
      if (segHitsRect(s1, s2, r)) return false
    }
  }
  return true
}

interface LaneRoute {
  edge: { id: string }
}

/**
 * The perpendicular ("offset-axis") coordinate that says WHICH SIDE of the
 * channel a segment's route feeds in / leaves from. For a vertical channel
 * segment (constant x) the offset axis is x; for a horizontal one it is y.
 *
 * We look at the vertices the route attaches to this segment with: the vertex
 * BEFORE it (pts[i-1], which feeds the lo/hi corner) and the vertex AFTER it
 * (pts[i+2], which leaves the other corner). Their perpendicular coordinate is
 * the direction the trace bends off towards. A segment whose neighbours sit to
 * the LEFT (smaller x) should claim the left track and one whose neighbours sit
 * to the RIGHT the right track — sorting by this keeps an edge entering from the
 * top on the top track and removes swap-and-swap-back weaves. When a corner is a
 * terminal (no neighbour vertex) we fall back to the route's FAR endpoint, so a
 * 2-point straight still orders by where it ultimately goes. Pure & deterministic.
 */
function feedCoord(pts: Pt[], seg: Seg): number {
  const perp = (p: Pt) => (seg.axis === 'v' ? p.x : p.y)
  const i = seg.i
  const before = i - 1 >= 0 ? pts[i - 1] : undefined
  const after = i + 2 < pts.length ? pts[i + 2] : undefined
  const vals: number[] = []
  if (before) vals.push(perp(before))
  if (after) vals.push(perp(after))
  if (vals.length === 0) {
    // both corners terminal (a jogged straight before splitting): use the far
    // endpoint's perpendicular coordinate so direction-of-travel still orders it.
    const far = perp(pts[pts.length - 1])
    const near = perp(pts[0])
    return (far + near) / 2
  }
  let sum = 0
  for (const v of vals) sum += v
  return sum / vals.length
}

/**
 * ONE lane-separation pass over the working polylines. Re-collects the lane-able
 * axis-aligned segments from the CURRENT geometry, buckets them into channels of
 * mutually-overlapping collinear runs, and assigns each channel's members to
 * distinct parallel tracks. Mutates `work` in place; returns true iff it moved at
 * least one segment (so the caller can iterate to a fixpoint).
 *
 * Allocation: each segment claims the nearest FREE offset on a centred ladder
 * {0,+g,-g,+2g,-2g,…} that keeps the WHOLE polyline R2-clean. A claim is recorded
 * only once it actually commits, so an R2-blocked segment hops to the next free
 * track instead of collapsing onto a neighbour's lane. Within a channel, segments
 * are committed HIGHEST-segment-index first per route so a split/stub insertion
 * (which lengthens the polyline at i+1) never invalidates a lower-indexed segment
 * of the SAME route processed later. Deterministic.
 */
/** Lane-ordering strategy. 'feed' (default) is the crossing-aware ordering that
 * sorts each channel's tracks by where each route feeds in/out so traces don't
 * weave; 'edgeIndex' is the legacy arbitrary order (by polyline index) kept ONLY
 * so a test can measure crossings BEFORE vs AFTER the improvement. */
export type LaneOrder = 'feed' | 'edgeIndex'

function lanePass(
  work: Pt[][],
  routes: LaneRoute[],
  boxes: Box[],
  laneOrder: LaneOrder = 'feed',
): boolean {
  const allSegs: Seg[] = []
  routes.forEach((r, idx) => {
    for (const s of axisSegments(r.edge.id, idx, work[idx])) {
      if (laneable(s)) allSegs.push(s)
    }
  })
  const channels = channelsFor(allSegs)
  let moved = false

  const applyShift = (seg: Seg, d: number): Pt[] | null => {
    const bothMovable = seg.movableLo && seg.movableHi
    const isSplit = !bothMovable && seg.routeLen === 2
    const isStub = !bothMovable && seg.routeLen > 2 && seg.movableLo !== seg.movableHi
    const cur = work[seg.ptsIndex]
    const trial = isSplit
      ? splitStraight(cur, seg, d)
      : isStub
        ? shiftSegmentStub(cur, seg, d)
        : shiftSegment(cur, seg, d)
    return polylineR2Clean(trial, boxes) ? trial : null
  }

  for (const channel of channels) {
    const n = channel.length
    // symmetric offset ladder, large enough for n lanes plus blocked-hop headroom
    const ladder: number[] = [0]
    for (let k = 1; k <= n + 4; k++) ladder.push(k * LANE_GAP, -k * LANE_GAP)
    // preferred lane per segment from the channel's centred spread. CROSSING-AWARE
    // ordering: sort the channel's tracks by WHERE each segment's route enters and
    // leaves the channel along the PERPENDICULAR (offset) axis, so an edge feeding
    // the channel from the low side keeps the low track and one feeding from the
    // high side keeps the high track — this removes swap-and-swap-back weaves that
    // an arbitrary edge-index order produces. Ties fall back to ptsIndex/i so the
    // preference stays deterministic.
    const prefByPts = new Map<string, number>()
    const feedKey = (seg: Seg): number => feedCoord(work[seg.ptsIndex], seg)
    const prefOrder = [...channel].sort((a, b) => {
      if (laneOrder === 'feed') {
        const fa = feedKey(a)
        const fb = feedKey(b)
        if (Math.abs(fa - fb) > 1e-6) return fa - fb
      }
      if (a.ptsIndex !== b.ptsIndex) return a.ptsIndex - b.ptsIndex
      return a.i - b.i
    })
    prefOrder.forEach((seg, k) =>
      prefByPts.set(`${seg.ptsIndex}:${seg.i}`, (k - (n - 1) / 2) * LANE_GAP),
    )
    // FEASIBLE offsets per segment: a non-zero offset is feasible only if the
    // trial shift keeps the route R2-clean; offset 0 is always feasible (the base
    // geometry is already R2-clean as routed/fanned). We pre-screen so the commit
    // order can put the MOST-CONSTRAINED segments (fewest feasible tracks) first,
    // and so a segment never silently starves onto a neighbour's lane: a packing
    // exists iff each segment finds a distinct feasible track. Deterministic.
    const feasible = new Map<string, Set<number>>()
    for (const seg of channel) {
      const set = new Set<number>([0])
      for (const d of ladder) {
        if (Math.abs(d) < 1e-6) continue
        if (applyShift(seg, d)) set.add(d)
      }
      feasible.set(`${seg.ptsIndex}:${seg.i}`, set)
    }
    // Commit order: most-constrained first (fewest feasible tracks), then the
    // feed-coord preference rank, then per-route higher segment index first so a
    // stub/split insertion (which lengthens the polyline at i+1) never invalidates
    // a lower-indexed segment of the SAME route processed later.
    const rankByPts = new Map<string, number>()
    prefOrder.forEach((seg, k) => rankByPts.set(`${seg.ptsIndex}:${seg.i}`, k))
    const ordered = [...channel].sort((a, b) => {
      const ka = `${a.ptsIndex}:${a.i}`
      const kb = `${b.ptsIndex}:${b.i}`
      const fa = feasible.get(ka)!.size
      const fb = feasible.get(kb)!.size
      if (fa !== fb) return fa - fb
      if (a.ptsIndex === b.ptsIndex) return b.i - a.i
      return (rankByPts.get(ka) ?? 0) - (rankByPts.get(kb) ?? 0)
    })
    const claimed: number[] = []
    for (const seg of ordered) {
      const k = `${seg.ptsIndex}:${seg.i}`
      const preferred = prefByPts.get(k) ?? 0
      // re-screen feasibility against the CURRENT geometry: a sibling's committed
      // stub/split may have changed this route's points if same ptsIndex.
      const cand = [...feasible.get(k)!]
        .filter((c) => claimed.every((q) => Math.abs(q - c) > LANE_GAP - 1))
        .sort((a, b) => {
          const da = Math.abs(a - preferred)
          const db = Math.abs(b - preferred)
          return da !== db ? da - db : a - b
        })
      for (const d of cand) {
        if (Math.abs(d) < 1e-6) {
          claimed.push(0)
          break
        }
        const trial = applyShift(seg, d)
        if (trial) {
          work[seg.ptsIndex] = trial
          claimed.push(d)
          moved = true
          break
        }
      }
    }
  }
  return moved
}

/**
 * Base-route every non-self edge with routeEdge, then lane-separate overlapping
 * collinear interior segments onto parallel tracks. Returns edge id -> polyline.
 * Memoized by FlowDoc identity so the SVG projection, the interactive canvas and
 * the validator (which share one doc per render) compute it once.
 *
 * Self edges are NOT included — they keep their selfLoopPoints arc elsewhere.
 */
const laneCache = new WeakMap<FlowDoc, Map<string, Pt[]>>()

type Side = 'L' | 'R' | 'T' | 'B'

/** Which border of box `b` the (terminal) point `p` lies on. Picks the nearest
 * face; ties resolve L<R<T<B for determinism. Used by the fan-out pass. */
function sideOf(p: Pt, b: Box): Side {
  const dL = Math.abs(p.x - b.x)
  const dR = Math.abs(p.x - (b.x + b.w))
  const dT = Math.abs(p.y - b.y)
  const dB = Math.abs(p.y - (b.y + b.h))
  const m = Math.min(dL, dR, dT, dB)
  if (m === dL) return 'L'
  if (m === dR) return 'R'
  if (m === dT) return 'T'
  return 'B'
}

const isVerticalSide = (s: Side) => s === 'L' || s === 'R'

/**
 * Distribute the endpoints of edges that enter/leave the SAME box on the SAME
 * side so their first/last legs don't stack on one identical border coordinate
 * (the dominant overlap source after side-entry anchoring funnels many edges to
 * one face). For each (box, side) group with >1 endpoint we spread the terminal
 * coordinate along that face on a fixed pitch, centred on the face midpoint, and
 * shift the ADJACENT vertex by the same amount so the entering/leaving leg stays
 * perpendicular to the face. A 2-point straight (both ends terminal) is jogged
 * into a 4-point route first so each end can move independently. Terminals stay
 * ON the border (R1), and each rewrite is R2-safety-checked before committing.
 * Deterministic: groups and slots derive from the doc's edge order only.
 */
const FAN_PITCH = 16 // px between fanned endpoints on a shared face

function fanOutEndpoints(
  work: Pt[][],
  ends: Array<{ ptsIndex: number; box: Box; terminal: 'a' | 'b' }>,
  boxes: Box[],
  laneOrder: LaneOrder = 'feed',
): void {
  // bucket endpoints by (box id, side)
  const groups = new Map<string, typeof ends>()
  for (const e of ends) {
    const pts = work[e.ptsIndex]
    if (pts.length < 2) continue
    const p = e.terminal === 'a' ? pts[0] : pts[pts.length - 1]
    const side = sideOf(p, e.box)
    const k = `${e.box.id}|${side}`
    const arr = groups.get(k) ?? []
    arr.push(e)
    groups.set(k, arr)
  }

  for (const [k, arr] of groups) {
    if (arr.length < 2) continue
    const side = k.slice(k.indexOf('|') + 1) as Side
    const box = arr[0].box
    const vertical = isVerticalSide(side)
    // free-axis centre of the face and the usable half-span (keep a 6px inset so
    // the terminal stays comfortably on the border, R1 TOL 11).
    const centre = vertical ? box.y + box.h / 2 : box.x + box.w / 2
    const half = (vertical ? box.h : box.w) / 2 - 6
    // CROSSING-AWARE slot order: lay the endpoints out along the face in the order
    // of WHERE EACH EDGE IS GOING — the perpendicular (slot-axis) coordinate of its
    // OPPOSITE endpoint. So the edge whose far end is highest takes the highest slot
    // on this face too, and edges keep a consistent transverse order at BOTH ends —
    // which is exactly what stops two edges between the same two boxes from weaving
    // (crossing then crossing back). Ties fall back to ptsIndex/terminal so the
    // order stays fully deterministic.
    const farKey = (e: (typeof arr)[number]): number => {
      const pts = work[e.ptsIndex]
      const far = e.terminal === 'a' ? pts[pts.length - 1] : pts[0]
      return vertical ? far.y : far.x
    }
    const ordered = [...arr].sort((p, q) => {
      if (laneOrder === 'feed') {
        const fp = farKey(p)
        const fq = farKey(q)
        if (Math.abs(fp - fq) > 1e-6) return fp - fq
      }
      if (p.ptsIndex !== q.ptsIndex) return p.ptsIndex - q.ptsIndex
      return p.terminal < q.terminal ? -1 : 1
    })
    const n = ordered.length
    // shrink the pitch so ALL slots fit inside the usable face span (otherwise a
    // crowded face clamps several edges to the same border coordinate, re-stacking
    // their legs). Keep >=2px so distinct edges still separate.
    const pitch = n > 1 ? Math.max(2, Math.min(FAN_PITCH, (2 * half) / (n - 1))) : FAN_PITCH
    ordered.forEach((e, slot) => {
      let pos = centre + (slot - (n - 1) / 2) * pitch
      // clamp inside the face span so the endpoint stays on the border
      pos = Math.min(Math.max(pos, centre - half), centre + half)
      const pts = work[e.ptsIndex]
      const isStraight = pts.length === 2
      let trial: Pt[]
      if (isStraight) {
        // jog the straight so THIS end can move along the face independently:
        // a vertical face wants a horizontal first leg; a horizontal face a
        // vertical one. Insert one bend a short way off the face.
        const a = pts[0]
        const b = pts[1]
        if (e.terminal === 'a') {
          if (vertical) {
            // move a.y to pos; leg a -> (a.x±stub, pos) horizontal, then to b
            const stub = side === 'R' ? a.x + FAN_PITCH : a.x - FAN_PITCH
            trial = simplify([{ x: a.x, y: pos }, { x: stub, y: pos }, { x: stub, y: b.y }, b])
          } else {
            const stub = side === 'B' ? a.y + FAN_PITCH : a.y - FAN_PITCH
            trial = simplify([{ x: pos, y: a.y }, { x: pos, y: stub }, { x: b.x, y: stub }, b])
          }
        } else {
          if (vertical) {
            const stub = side === 'R' ? b.x + FAN_PITCH : b.x - FAN_PITCH
            trial = simplify([a, { x: stub, y: a.y }, { x: stub, y: pos }, { x: b.x, y: pos }])
          } else {
            const stub = side === 'B' ? b.y + FAN_PITCH : b.y - FAN_PITCH
            trial = simplify([a, { x: a.x, y: stub }, { x: pos, y: stub }, { x: pos, y: b.y }])
          }
        }
      } else {
        // orthogonal route: slide the terminal AND its neighbour along the face
        // axis so the perpendicular first/last leg is preserved.
        const next = pts.map((p) => ({ x: p.x, y: p.y }))
        const ti = e.terminal === 'a' ? 0 : next.length - 1
        const ni = e.terminal === 'a' ? 1 : next.length - 2
        if (vertical) {
          const dy = pos - next[ti].y
          next[ti].y += dy
          next[ni].y += dy
        } else {
          const dx = pos - next[ti].x
          next[ti].x += dx
          next[ni].x += dx
        }
        trial = simplify(next)
      }
      if (polylineR2Clean(trial, boxes)) work[e.ptsIndex] = trial
    })
  }
}

// ─── Crossing analysis & double-crossing elimination ────────────────────────
//
// A PROPER crossing is one horizontal segment and one vertical segment from
// DIFFERENT routes whose interiors intersect (a true X, not a shared endpoint and
// not a collinear overlap). Two routes that cross MORE THAN ONCE weave (cross then
// cross back); at least one such crossing is redundant. We detect those pairs and
// try to remove the redundancy by SWAPPING the two routes' lane offsets inside a
// channel they share — only when the swap lowers the total crossing count and
// keeps every route R2-clean (no overlap reintroduced). Deterministic, bounded.

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

/** Number of PROPER crossings between two polylines (interior H×V intersections). */
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

/**
 * DOUBLE-CROSSING ELIMINATION. For each pair of routes that cross MORE THAN ONCE
 * (a weave: cross then cross back) try a small set of deterministic lane moves on
 * the two routes' lane-able interior segments and commit the first that strictly
 * lowers THIS pair's crossing count WITHOUT raising the global total and WITHOUT
 * breaking R2:
 *
 *   • SWAP  — for a same-axis segment of each route, exchange their coordinates so
 *             the two traces trade tracks (undoes the classic parallel-track weave);
 *   • SHIFT — move just ONE route's segment onto the OTHER's coordinate (or by a
 *             small ladder of offsets) so it stops re-crossing.
 *
 * Segments need not be collinear/in one channel — any lane-able interior run of
 * either route is a lever. Iterates to a bounded fixpoint. Deterministic.
 */
function eliminateDoubleCrossings(work: Pt[][], routes: LaneRoute[], boxes: Box[]): boolean {
  let changedEver = false
  const laneSegsOf = (idx: number): Seg[] =>
    axisSegments(routes[idx].edge.id, idx, work[idx]).filter(laneable)

  for (let iter = 0; iter < 8; iter++) {
    // candidate pairs that currently weave, in a deterministic (index) order.
    const candidates: Array<[number, number]> = []
    for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        if (crossingsBetween(work[i], work[j]) > 1) candidates.push([i, j])
      }
    }
    let changed = false
    for (const [i, j] of candidates) {
      const beforePair = crossingsBetween(work[i], work[j])
      if (beforePair <= 1) continue // already fixed by an earlier move this pass
      const beforeTotal = globalCrossings(work)
      const beforeOverlap = globalOverlap(work)
      const segsI = laneSegsOf(i)
      const segsJ = laneSegsOf(j)

      type Move = { ia: number; ta: Pt[]; ib?: number; tb?: Pt[] }
      const moves: Move[] = []
      // SWAP same-axis segment coords between the two routes.
      for (const si of segsI) {
        for (const sj of segsJ) {
          if (si.axis !== sj.axis) continue
          const dij = sj.coord - si.coord
          if (Math.abs(dij) < 1e-6) continue
          const ta = mirrorSeg(work[i], si, dij)
          const tb = mirrorSeg(work[j], sj, -dij)
          if (ta && tb) moves.push({ ia: i, ta, ib: j, tb })
          // SHIFT just one of them onto the other's coordinate.
          if (ta) moves.push({ ia: i, ta })
          const tb2 = mirrorSeg(work[j], sj, -dij)
          if (tb2) moves.push({ ia: j, ta: tb2 })
        }
      }
      // SHIFT a single segment by a small symmetric ladder (helps when the partner
      // has no matching-axis lever, e.g. crossing a long straight).
      for (const seg of [...segsI.map((s) => [i, s] as const), ...segsJ.map((s) => [j, s] as const)]) {
        const [ridx, s] = seg
        for (let k = 1; k <= 3; k++) {
          for (const d of [k * LANE_GAP, -k * LANE_GAP]) {
            const t = mirrorSeg(work[ridx], s, d)
            if (t) moves.push({ ia: ridx, ta: t })
          }
        }
      }

      for (const m of moves) {
        if (!polylineR2Clean(m.ta, boxes)) continue
        if (m.tb && !polylineR2Clean(m.tb, boxes)) continue
        const trial = work.map((w, idx) =>
          idx === m.ia ? m.ta : m.ib !== undefined && idx === m.ib ? m.tb! : w,
        )
        const afterPair = crossingsBetween(trial[i], trial[j])
        if (afterPair >= beforePair) continue
        const afterTotal = globalCrossings(trial)
        if (afterTotal > beforeTotal) continue
        const afterOverlap = globalOverlap(trial)
        if (afterOverlap > beforeOverlap) continue
        work[m.ia] = m.ta
        if (m.ib !== undefined) work[m.ib] = m.tb!
        changed = true
        changedEver = true
        break
      }
    }
    if (!changed) break
  }
  return changedEver
}

/** Total proper crossings across the whole working set (each pair counted once). */
function globalCrossings(work: Pt[][]): number {
  let c = 0
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) c += crossingsBetween(work[i], work[j])
  }
  return c
}

/** Collinear-overlap pairs across the working set — the SAME metric the overlap
 * test uses (different edges, same axis, coord within LANE_TOL, spans overlap by
 * more than LANE_MIN_OVERLAP). The crossing-elimination pass must never raise this,
 * so undoing a weave can't quietly re-stack two traces on one line. */
function globalOverlap(work: Pt[][]): number {
  const segs: Array<{ pi: number; ax: 'v' | 'h'; coord: number; lo: number; hi: number }> = []
  work.forEach((pts, pi) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const dx = Math.abs(a.x - b.x)
      const dy = Math.abs(a.y - b.y)
      if (dx <= 1e-6 && dy > 1e-6) {
        segs.push({ pi, ax: 'v', coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
      } else if (dy <= 1e-6 && dx > 1e-6) {
        segs.push({ pi, ax: 'h', coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
      }
    }
  })
  let c = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]
      const b = segs[j]
      if (a.pi === b.pi) continue
      if (a.ax !== b.ax) continue
      if (Math.abs(a.coord - b.coord) > LANE_TOL) continue
      if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > LANE_MIN_OVERLAP) c++
    }
  }
  return c
}

/** Mirror (shift) a lane-able segment by delta on its constant axis, using the
 * same shift/split/stub machinery the lane pass uses so the route stays valid.
 * Returns null if the segment is not actually movable for that mode. */
function mirrorSeg(pts: Pt[], seg: Seg, delta: number): Pt[] | null {
  const bothMovable = seg.movableLo && seg.movableHi
  const isSplit = !bothMovable && seg.routeLen === 2
  const isStub = !bothMovable && seg.routeLen > 2 && seg.movableLo !== seg.movableHi
  if (isSplit) return splitStraight(pts, seg, delta)
  if (isStub) return shiftSegmentStub(pts, seg, delta)
  if (bothMovable) return shiftSegment(pts, seg, delta)
  return null
}

export function routeAllEdges(doc: FlowDoc): Map<string, Pt[]> {
  const cached = laneCache.get(doc)
  if (cached) return cached
  const out = computeLanedRoutes(doc, 'feed')
  laneCache.set(doc, out)
  return out
}

/**
 * The lane-separation pipeline, parameterised by lane-ordering strategy. The
 * default 'feed' (crossing-aware) path is what production uses; 'edgeIndex' is
 * exposed only so a test can measure crossings BEFORE the improvement. NOT
 * memoized here — routeAllEdges owns the per-doc memo for the default path.
 */
export function computeLanedRoutes(doc: FlowDoc, laneOrder: LaneOrder): Map<string, Pt[]> {
  const boxes = drawnBoxes(doc)
  const byId = new Map(boxes.map((b) => [b.id, b]))

  // a — base routes (deterministic edge order).
  const routes: Array<{ edge: FlowEdge; pts: Pt[]; from: Box; to: Box }> = []
  for (const e of doc.edges) {
    if (e.kind === 'self') continue
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    routes.push({ edge: e, pts: routeEdge(from, to, boxes), from, to })
  }

  // Working polylines we will mutate as lanes are committed (deep-copied).
  const work: Pt[][] = routes.map((r) => r.pts.map((p) => ({ x: p.x, y: p.y })))

  // a2 — FAN OUT endpoints sharing a box face so their first/last legs spread
  // onto distinct border coordinates instead of stacking.
  const ends: Array<{ ptsIndex: number; box: Box; terminal: 'a' | 'b' }> = []
  routes.forEach((r, idx) => {
    ends.push({ ptsIndex: idx, box: r.from, terminal: 'a' })
    ends.push({ ptsIndex: idx, box: r.to, terminal: 'b' })
  })
  fanOutEndpoints(work, ends, boxes, laneOrder)

  // b — lane-separate overlapping collinear runs. Run the pass a few times: a
  // shift that moves a horizontal corridor lengthens the verticals feeding it,
  // which can create a NEW collinear overlap with another edge; re-collecting and
  // re-laning resolves such cascades. Iterate to a fixpoint (bounded) — each pass
  // only ever decreases overlap, so it converges deterministically.
  for (let pass = 0; pass < 4; pass++) {
    if (!lanePass(work, routes, boxes, laneOrder)) break
  }

  // b2 — DOUBLE-CROSSING ELIMINATION: swap lane assignments inside shared channels
  // to undo weaves (cross-then-cross-back) where doing so lowers the crossing count
  // without reintroducing overlap or an R2 violation. Skipped for the legacy order
  // so the BEFORE measurement reflects ordering alone.
  if (laneOrder === 'feed') {
    eliminateDoubleCrossings(work, routes, boxes)
  }

  // c — simplify and assemble the map.
  const out = new Map<string, Pt[]>()
  routes.forEach((r, idx) => {
    out.set(r.edge.id, simplify(work[idx]))
  })
  return out
}

/** The laned polyline for one non-self edge (looked up in routeAllEdges), or a
 * direct routeEdge fallback when the edge is absent from the laned map. The SVG
 * projection, the canvas, and the validator all call this so they agree. */
export function routedEdge(doc: FlowDoc, edge: FlowEdge, boxes: Box[]): Pt[] {
  const laned = routeAllEdges(doc).get(edge.id)
  if (laned) return laned
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  if (!from || !to) return []
  return routeEdge(from, to, boxes)
}

/** Midpoint of a polyline by its longest segment — places the label on the
 * longest visible run rather than averaging endpoints (which detours skew).
 * This is the single source of truth shared by the SVG projection, the
 * validator, and the interactive canvas. */
export function midpointOfPolyline(pts: Pt[]): Pt {
  if (pts.length <= 1) return pts[0] ?? { x: 0, y: 0 }
  let best = 0
  let bestLen = -1
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    if (len > bestLen) {
      bestLen = len
      best = i
    }
  }
  return {
    x: (pts[best].x + pts[best + 1].x) / 2,
    y: (pts[best].y + pts[best + 1].y) / 2,
  }
}

/** The DEFAULT (un-nudged) anchor for an edge's label: the self-loop label point
 * for self edges, else the midpoint of the longest routed segment. Returns
 * {x:0,y:0} when an endpoint node is missing (edge not drawn). One source of
 * truth for the SVG projection, the validator, and the canvas. */
export function edgeLabelAnchor(doc: FlowDoc, edge: FlowEdge): Pt {
  const boxes = drawnBoxes(doc)
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const from = byId.get(edge.from)
  if (!from) return { x: 0, y: 0 }
  if (edge.kind === 'self') {
    const sl = selfLoopPoints(from)
    return { x: sl.apex.x + 8, y: sl.apex.y }
  }
  const to = byId.get(edge.to)
  if (!to) return { x: 0, y: 0 }
  return midpointOfPolyline(routedEdge(doc, edge, boxes))
}

/** The label's drawn position = anchor + manual offset (edge.labelOffset). */
export function edgeLabelPos(doc: FlowDoc, edge: FlowEdge): Pt {
  const a = edgeLabelAnchor(doc, edge)
  const off = edge.labelOffset ?? { dx: 0, dy: 0 }
  return { x: a.x + off.dx, y: a.y + off.dy }
}

/**
 * The label's bounding box at its drawn position (edgeLabelPos), sized from
 * LABEL_STYLE. This is the SINGLE source of truth for label boxes shared by the
 * R3 validator and the de-clash layout pass, so de-clash and validation always
 * agree. The box is centred on the label position:
 *   width  = text.length * size * glyphAdvance + 2*backingPadX
 *   height = size + 2*backingPadY
 */
export function labelRect(doc: FlowDoc, edge: FlowEdge): Box {
  const mid = edgeLabelPos(doc, edge)
  const text = edge.label ?? ''
  const w =
    text.length * LABEL_STYLE.size * LABEL_STYLE.glyphAdvance +
    2 * LABEL_STYLE.backingPadX
  const h = LABEL_STYLE.size + 2 * LABEL_STYLE.backingPadY
  return { id: edge.id, x: mid.x - w / 2, y: mid.y - h / 2, w, h }
}

export interface ContentBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Bounding box of all drawn boxes + edge endpoints (pre-legend). */
export function contentBBox(doc: FlowDoc): ContentBBox {
  const boxes = drawnBoxes(doc)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const b of boxes) {
    grow(b.x, b.y)
    grow(b.x + b.w, b.y + b.h)
  }
  const byId = new Map(boxes.map((b) => [b.id, b]))
  for (const e of doc.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from) continue
    if (e.kind === 'self') {
      const sl = selfLoopPoints(from)
      grow(sl.apex.x, sl.apex.y)
      continue
    }
    if (!to) continue
    for (const p of routedEdge(doc, e, boxes)) grow(p.x, p.y)
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  return { minX, minY, maxX, maxY }
}
