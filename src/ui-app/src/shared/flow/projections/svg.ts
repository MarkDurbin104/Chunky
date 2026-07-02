// shared/flow/projections/svg.ts — FlowDoc -> house-style SVG string.
//
// Pure function. Renders rounded role-coloured boxes at node pos/size, solid
// arrows for forward/self and dashed ("6 5") for back, an arrow marker, edge
// labels with white backing, an auto-built bottom legend, and a viewBox fit to
// the content bbox + 26px margin. All geometry/colour constants come from
// style.ts (the single source of truth) so the SVG and the validator agree.

import type { FlowDoc, FlowNode } from '../model'
import {
  ROLE_STYLE,
  NODE_RX,
  EDGE_STYLE,
  LABEL_STYLE,
  SPACING,
  LEGEND,
} from '../style'
import {
  boxCenter,
  contentBBox,
  drawnBoxes,
  edgeLabelPos,
  nodeBox,
  routedEdge,
  selfLoopPoints,
  type Box,
  type Pt,
} from '../geometry'

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const r2 = (n: number): number => Math.round(n * 100) / 100

function labelWidth(text: string, size: number): number {
  return text.length * size * LABEL_STYLE.glyphAdvance
}

function renderNode(n: FlowNode): string {
  const st = ROLE_STYLE[n.role]
  const b = nodeBox(n)
  const c = boxCenter(b)
  const parts: string[] = []

  if (n.role === 'start' && st.circleRadius) {
    parts.push(
      `<circle cx="${r2(c.x)}" cy="${r2(c.y)}" r="${st.circleRadius}" ` +
        `fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.strokeWidth}" />`,
    )
  } else {
    parts.push(
      `<rect x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(
        b.h,
      )}" rx="${NODE_RX}" ry="${NODE_RX}" ` +
        `fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.strokeWidth}" />`,
    )
  }

  const hasSub = !!n.subtitle
  const titleY = hasSub ? c.y - 2 : c.y + st.titleSize * 0.35
  parts.push(
    `<text x="${r2(c.x)}" y="${r2(titleY)}" text-anchor="middle" ` +
      `font-family="${LABEL_STYLE.fontFamily}" font-size="${st.titleSize}" ` +
      `fill="${st.titleColor}" font-weight="600">${esc(n.label)}</text>`,
  )
  if (hasSub) {
    parts.push(
      `<text x="${r2(c.x)}" y="${r2(c.y + st.subtitleSize + 1)}" text-anchor="middle" ` +
        `font-family="${LABEL_STYLE.fontFamily}" font-size="${st.subtitleSize}" ` +
        `fill="${st.subtitleColor}">${esc(n.subtitle!)}</text>`,
    )
  }
  if (n.tabs && n.tabs.length) {
    parts.push(
      `<text x="${r2(b.x)}" y="${r2(b.y - 6)}" text-anchor="start" ` +
        `font-family="${LABEL_STYLE.fontFamily}" font-size="11" ` +
        `fill="${st.subtitleColor}">tabs: ${esc(n.tabs.join(' · '))}</text>`,
    )
  }
  return parts.join('\n  ')
}

function labelMarkup(text: string, mid: Pt): string {
  if (!text) return ''
  const w = labelWidth(text, LABEL_STYLE.size)
  const bx = mid.x - w / 2 - LABEL_STYLE.backingPadX
  const by = mid.y - LABEL_STYLE.size / 2 - LABEL_STYLE.backingPadY
  const bw = w + LABEL_STYLE.backingPadX * 2
  const bh = LABEL_STYLE.size + LABEL_STYLE.backingPadY * 2
  return (
    `<rect x="${r2(bx)}" y="${r2(by)}" width="${r2(bw)}" height="${r2(
      bh,
    )}" fill="${LABEL_STYLE.backing}" opacity="0.92" />\n  ` +
    `<text x="${r2(mid.x)}" y="${r2(mid.y + LABEL_STYLE.size * 0.35)}" text-anchor="middle" ` +
    `font-family="${LABEL_STYLE.fontFamily}" font-size="${LABEL_STYLE.size}" ` +
    `fill="${LABEL_STYLE.color}">${esc(text)}</text>`
  )
}

function renderEdges(doc: FlowDoc, boxes: Box[]): string {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const out: string[] = []
  for (const e of doc.edges) {
    const from = byId.get(e.from)
    if (!from) continue
    const dash = e.kind === 'back' ? EDGE_STYLE.backDash : EDGE_STYLE.forwardDash
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : ''

    if (e.kind === 'self') {
      const sl = selfLoopPoints(from)
      const d = `M ${r2(sl.start.x)} ${r2(sl.start.y)} Q ${r2(
        sl.apex.x + 18,
      )} ${r2(sl.apex.y)} ${r2(sl.end.x)} ${r2(sl.end.y)}`
      out.push(
        `<path d="${d}" fill="none" stroke="${EDGE_STYLE.stroke}" ` +
          `stroke-width="${EDGE_STYLE.strokeWidth}"${dashAttr} ` +
          `marker-end="url(#${EDGE_STYLE.markerId})" />`,
      )
      if (e.label) out.push(labelMarkup(e.label, edgeLabelPos(doc, e)))
      continue
    }

    const to = byId.get(e.to)
    if (!to) continue
    const pts = routedEdge(doc, e, boxes)
    if (pts.length === 2) {
      const [a, b] = pts
      out.push(
        `<line x1="${r2(a.x)}" y1="${r2(a.y)}" x2="${r2(b.x)}" y2="${r2(b.y)}" ` +
          `stroke="${EDGE_STYLE.stroke}" stroke-width="${EDGE_STYLE.strokeWidth}"${dashAttr} ` +
          `marker-end="url(#${EDGE_STYLE.markerId})" />`,
      )
    } else {
      const ptsStr = pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' ')
      out.push(
        `<polyline points="${ptsStr}" fill="none" ` +
          `stroke="${EDGE_STYLE.stroke}" stroke-width="${EDGE_STYLE.strokeWidth}"${dashAttr} ` +
          `marker-end="url(#${EDGE_STYLE.markerId})" />`,
      )
    }
    if (e.label) {
      out.push(labelMarkup(e.label, edgeLabelPos(doc, e)))
    }
  }
  return out.join('\n  ')
}

function legendUsesBack(doc: FlowDoc): boolean {
  return doc.edges.some((e) => e.kind === 'back')
}

function renderLegend(
  doc: FlowDoc,
  topY: number,
  leftX: number,
): { svg: string; bottom: number } {
  const rows: Array<{ dash: string; text: string }> = [
    { dash: EDGE_STYLE.forwardDash, text: LEGEND.forwardText },
  ]
  if (legendUsesBack(doc)) {
    rows.push({ dash: EDGE_STYLE.backDash, text: LEGEND.backText })
  }
  for (const note of doc.legendNotes ?? []) {
    rows.push({ dash: '', text: note })
  }
  const out: string[] = []
  let y = topY
  for (const row of rows) {
    const dashAttr = row.dash ? ` stroke-dasharray="${row.dash}"` : ''
    out.push(
      `<line x1="${r2(leftX)}" y1="${r2(y)}" x2="${r2(
        leftX + LEGEND.sampleLen,
      )}" y2="${r2(y)}" stroke="${EDGE_STYLE.stroke}" ` +
        `stroke-width="${EDGE_STYLE.strokeWidth}"${dashAttr} marker-end="url(#${EDGE_STYLE.markerId})" />`,
    )
    out.push(
      `<text x="${r2(leftX + LEGEND.sampleLen + 10)}" y="${r2(
        y + LEGEND.textSize * 0.35,
      )}" text-anchor="start" font-family="${LABEL_STYLE.fontFamily}" ` +
        `font-size="${LEGEND.textSize}" fill="${LEGEND.textColor}">${esc(row.text)}</text>`,
    )
    y += LEGEND.lineHeight
  }
  return { svg: out.join('\n  '), bottom: y }
}

export function toSvg(doc: FlowDoc): string {
  const boxes = drawnBoxes(doc)
  const bbox = contentBBox(doc)
  const m = SPACING.margin

  // legend parked clear below all content
  const legendTop = bbox.maxY + LEGEND.gapAboveContent
  const { svg: legendSvg, bottom: legendBottom } = renderLegend(
    doc,
    legendTop,
    bbox.minX,
  )

  const minX = bbox.minX - m
  const minY = bbox.minY - m
  const maxX = bbox.maxX + m
  const maxY = legendBottom + m
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)

  const marker =
    `<marker id="${EDGE_STYLE.markerId}" viewBox="0 0 10 10" refX="9" refY="5" ` +
    `markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${EDGE_STYLE.stroke}" /></marker>`

  const nodeSvg = boxes
    .map((b) => doc.nodes.find((n) => n.id === b.id)!)
    .map(renderNode)
    .join('\n  ')
  const edgeSvg = renderEdges(doc, boxes)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(minX)} ${r2(
      minY,
    )} ${r2(width)} ${r2(height)}" width="${r2(width)}" height="${r2(height)}">`,
    `  <defs>${marker}</defs>`,
    `  <rect x="${r2(minX)}" y="${r2(minY)}" width="${r2(width)}" height="${r2(
      height,
    )}" fill="#ffffff" />`,
    `  ${edgeSvg}`,
    `  ${nodeSvg}`,
    `  ${legendSvg}`,
    `</svg>`,
  ].join('\n')
}
