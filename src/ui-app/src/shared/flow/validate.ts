// shared/flow/validate.ts — the live linter / pre-publish gate, operating on
// the FlowDoc (NOT on rendered files). Ports validate-flow-svg.mjs geometry
// rules R1–R4 and validate-doc.mjs coverage/Gherkin-structure rules D2/D4.
//
// Geometry is computed from the laid-out nodes via the SAME geometry helpers
// the SVG projection uses, so a doc that renders correctly validates clean.

import type { FlowDoc } from './model'
import { LEGEND } from './style'
import {
  contentBBox,
  drawnBoxes,
  labelRect,
  onBorder,
  routedEdge,
  segHitsRect,
  selfLoopPoints,
  type Box,
} from './geometry'
import { toGherkin } from './projections/gherkin'

const TOL = 11 //    px: how close an endpoint must be to a node border (R1)
const SHRINK = 5 //  px: shrink boxes before through-test (ignore grazes) (R2)
const LABEL_PAD = 6 // px: only a clash when labels truly overlap (R3)

export type Severity = 'error' | 'warn'

export interface Issue {
  rule: string
  severity: Severity
  message: string
  nodeId?: string
  edgeId?: string
}

export interface ValidationResult {
  ok: boolean
  issues: Issue[]
}

function labelsOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w - LABEL_PAD &&
    a.x + a.w - LABEL_PAD > b.x &&
    a.y < b.y + b.h - LABEL_PAD &&
    a.y + a.h - LABEL_PAD > b.y
  )
}

/** A label rect overlaps a drawn node box (used by R3 so a label dragged onto a
 * box is flagged). Plain AABB intersection — no padding so a graze still trips. */
function rectOverlapsBox(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function checkGeometry(doc: FlowDoc, issues: Issue[]): void {
  const boxes = drawnBoxes(doc)
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const labels: Array<{ rect: Box; edgeId: string }> = []

  for (const e of doc.edges) {
    const from = byId.get(e.from)
    if (!from) continue

    if (e.kind === 'self') {
      // self-loop endpoints anchor on the box border by construction; only its
      // label participates in clash detection.
      if (e.label) {
        labels.push({ rect: labelRect(doc, e), edgeId: e.id })
      }
      continue
    }

    const to = byId.get(e.to)
    if (!to) continue
    const pts = routedEdge(doc, e, boxes)
    const a = pts[0]
    const b = pts[pts.length - 1]

    // R1 — both endpoints must terminate on a node border
    if (!boxes.some((n) => onBorder(a, n, TOL))) {
      issues.push({
        rule: 'R1',
        severity: 'error',
        message: `edge endpoint floats at (${Math.round(a.x)},${Math.round(a.y)})`,
        edgeId: e.id,
      })
    }
    if (!boxes.some((n) => onBorder(b, n, TOL))) {
      issues.push({
        rule: 'R1',
        severity: 'error',
        message: `edge endpoint floats at (${Math.round(b.x)},${Math.round(b.y)})`,
        edgeId: e.id,
      })
    }

    // R2 — no routed segment passes through a non-endpoint box
    for (const n of boxes) {
      const r: Box = {
        id: n.id,
        x: n.x + SHRINK,
        y: n.y + SHRINK,
        w: n.w - 2 * SHRINK,
        h: n.h - 2 * SHRINK,
      }
      if (r.w <= 0 || r.h <= 0) continue
      for (let i = 0; i + 1 < pts.length; i++) {
        const s1 = pts[i]
        const s2 = pts[i + 1]
        // a segment is allowed to touch the box it terminates on
        if (onBorder(s1, n, TOL) || onBorder(s2, n, TOL)) continue
        if (segHitsRect(s1, s2, r)) {
          issues.push({
            rule: 'R2',
            severity: 'error',
            message: `edge passes through box "${n.id}"`,
            edgeId: e.id,
            nodeId: n.id,
          })
          break
        }
      }
    }

    if (e.label) {
      // label sits at its drawn position (anchor + manual offset), matching the
      // SVG projection and the interactive canvas
      labels.push({ rect: labelRect(doc, e), edgeId: e.id })
    }
  }

  // R3 — no two edge labels clash, and no label overlaps a drawn box. (Node
  // titles/subtitles live inside boxes and are intentionally NOT counted as
  // labels — the same exemption the .mjs validator makes; but an edge label
  // dragged on top of a box obscures it, so that is flagged.)
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (labelsOverlap(labels[i].rect, labels[j].rect)) {
        issues.push({
          rule: 'R3',
          severity: 'warn',
          message: `edge labels overlap`,
          edgeId: labels[i].edgeId,
        })
      }
    }
  }
  for (const lbl of labels) {
    for (const n of boxes) {
      if (rectOverlapsBox(lbl.rect, n)) {
        issues.push({
          rule: 'R3',
          severity: 'warn',
          message: `edge label overlaps box "${n.id}"`,
          edgeId: lbl.edgeId,
          nodeId: n.id,
        })
        break
      }
    }
  }

  // R4 — the legend must sit clear below all content. We mirror the projection:
  // legendTop = content bottom + gapAboveContent. Clear iff gap >= 10px.
  if (boxes.length) {
    const bbox = contentBBox(doc)
    const legendTop = bbox.maxY + LEGEND.gapAboveContent
    const contentBottom = (() => {
      let max = bbox.maxY
      for (const e of doc.edges) {
        const from = byId.get(e.from)
        if (!from) continue
        if (e.kind === 'self') {
          max = Math.max(max, selfLoopPoints(from).end.y)
          continue
        }
        const to = byId.get(e.to)
        if (!to) continue
        for (const p of routedEdge(doc, e, boxes)) {
          max = Math.max(max, p.y)
        }
      }
      return max
    })()
    if (legendTop < contentBottom + 10) {
      issues.push({
        rule: 'R4',
        severity: 'error',
        message: 'legend not clear of diagram content',
      })
    }
  }
}

function checkCoverage(doc: FlowDoc, issues: Issue[]): void {
  // D2 — every transition is covered. In Flow Studio each FlowEdge IS a
  // transition AND yields exactly one Gherkin scenario, so coverage is
  // structural: assert every edge references real nodes (no dangling edge can
  // silently drop a transition).
  const ids = new Set(doc.nodes.map((n) => n.id))
  for (const e of doc.edges) {
    if (!ids.has(e.from)) {
      issues.push({
        rule: 'D2',
        severity: 'error',
        message: `edge "${e.id}" references missing source node "${e.from}"`,
        edgeId: e.id,
      })
    }
    if (!ids.has(e.to)) {
      issues.push({
        rule: 'D2',
        severity: 'error',
        message: `edge "${e.id}" references missing target node "${e.to}"`,
        edgeId: e.id,
      })
    }
    // self edges must have from === to
    if (e.kind === 'self' && e.from !== e.to) {
      issues.push({
        rule: 'D2',
        severity: 'warn',
        message: `self edge "${e.id}" has from !== to`,
        edgeId: e.id,
      })
    }
  }
}

function checkGherkinStructure(doc: FlowDoc, issues: Issue[]): void {
  // D4 — generated Gherkin scenarios are well-formed: each has Given/When/Then;
  // a Scenario Outline must carry Examples. We parse the projection output.
  const gherkin = toGherkin(doc)
  const acIdx = gherkin.indexOf('### Feature:')
  if (acIdx < 0) {
    issues.push({
      rule: 'D4',
      severity: 'error',
      message: 'no Acceptance Criteria / Feature section generated',
    })
    return
  }
  const ac = gherkin.slice(acIdx)
  const parts = ac
    .split(/^(?=\*\*Scenario(?: Outline)?\*\*:)/m)
    .slice(1)
  for (const s of parts) {
    const m0 = /^\*\*Scenario(?: Outline)?\*\*:\s*(.+)/.exec(s)
    const title = (m0 ? m0[1] : '?').slice(0, 40).trim()
    const outline = /^\*\*Scenario Outline\*\*:/.test(s)
    // restrict to this scenario's body (up to the next scenario / group header)
    const body = s.split(/^####\s/m)[0].split(/^(?=\*\*Scenario)/m)[0]
    const hasG = /\*\*Given\*\*/.test(body)
    const hasW = /\*\*When\*\*/.test(body)
    const hasT = /\*\*Then\*\*/.test(body)
    if (!hasG || !hasW || !hasT) {
      issues.push({
        rule: 'D4',
        severity: 'error',
        message: `scenario "${title}" missing Given/When/Then`,
      })
    } else if (outline && !/\*\*Examples\*\*/.test(body)) {
      issues.push({
        rule: 'D4',
        severity: 'error',
        message: `scenario outline "${title}" has no Examples`,
      })
    }
  }
}

export function validateFlow(doc: FlowDoc): ValidationResult {
  const issues: Issue[] = []
  checkGeometry(doc, issues)
  checkCoverage(doc, issues)
  checkGherkinStructure(doc, issues)
  const ok = !issues.some((i) => i.severity === 'error')
  return { ok, issues }
}
