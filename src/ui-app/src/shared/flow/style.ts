// shared/flow/style.ts — the §6 House Style, codified as typed constants.
//
// This is the SINGLE SOURCE OF TRUTH consumed by BOTH the SVG projection
// (projections/svg.ts) and the geometry validator (validate.ts). "Editor
// output" and "validator pass" are the same thing by construction, so the
// numbers below must never be duplicated/forked across those two modules.

import type { NodeRole } from './model'

export interface RoleStyle {
  fill: string
  stroke: string
  strokeWidth: number
  titleColor: string
  titleSize: number
  subtitleColor: string
  subtitleSize: number
  size: { w: number; h: number }
  /** start renders as a circle of this radius (size.w/h derived from it) */
  circleRadius?: number
}

// §6 palette / geometry table. Roles that share a row in the spec share values.
export const ROLE_STYLE: Record<NodeRole, RoleStyle> = {
  // Screen box | 210×58, rx 12, fill #dce9f9 stroke #4a90d9 1.6;
  //   title 15px #1f3864; subtitle 11.5px #2e5e8c
  screen: {
    fill: '#dce9f9',
    stroke: '#4a90d9',
    strokeWidth: 1.6,
    titleColor: '#1f3864',
    titleSize: 15,
    subtitleColor: '#2e5e8c',
    subtitleSize: 11.5,
    size: { w: 210, h: 58 },
  },
  // Sub-dialog | 170×52, fill #eef4fb stroke #7fb0e0 1.4
  subdialog: {
    fill: '#eef4fb',
    stroke: '#7fb0e0',
    strokeWidth: 1.4,
    titleColor: '#1f3864',
    titleSize: 15,
    subtitleColor: '#2e5e8c',
    subtitleSize: 11.5,
    size: { w: 170, h: 52 },
  },
  // Success terminal | fill #e2f0da stroke #5fa052; title #2e6b2e
  success: {
    fill: '#e2f0da',
    stroke: '#5fa052',
    strokeWidth: 1.6,
    titleColor: '#2e6b2e',
    titleSize: 15,
    subtitleColor: '#3f7a3f',
    subtitleSize: 11.5,
    size: { w: 190, h: 54 },
  },
  // Cancel / aux / Start | fill #efece4 stroke #b0a999; title #4d4d4d; Start = circle r28
  cancel: {
    fill: '#efece4',
    stroke: '#b0a999',
    strokeWidth: 1.6,
    titleColor: '#4d4d4d',
    titleSize: 15,
    subtitleColor: '#6b6660',
    subtitleSize: 11.5,
    size: { w: 170, h: 52 },
  },
  start: {
    fill: '#efece4',
    stroke: '#b0a999',
    strokeWidth: 1.6,
    titleColor: '#4d4d4d',
    titleSize: 13,
    subtitleColor: '#6b6660',
    subtitleSize: 11.5,
    circleRadius: 28,
    size: { w: 56, h: 56 }, // 2 * r28
  },
  // Error | fill #f6e6e0 stroke #cc7a52; title #8a4423
  error: {
    fill: '#f6e6e0',
    stroke: '#cc7a52',
    strokeWidth: 1.6,
    titleColor: '#8a4423',
    titleSize: 15,
    subtitleColor: '#a3573a',
    subtitleSize: 11.5,
    size: { w: 190, h: 54 },
  },
  // transient — folded into start/done in the diagram; never drawn.
  transient: {
    fill: '#efece4',
    stroke: '#b0a999',
    strokeWidth: 1.4,
    titleColor: '#4d4d4d',
    titleSize: 13,
    subtitleColor: '#6b6660',
    subtitleSize: 11.5,
    size: { w: 150, h: 46 },
  },
}

export const NODE_RX = 12 // rounded corner radius for boxes

// Edge | stroke #6b6b6b 1.6; forward solid, back dashed "6 5"; arrow marker
export const EDGE_STYLE = {
  stroke: '#6b6b6b',
  strokeWidth: 1.6,
  backDash: '6 5', // stroke-dasharray for back / ESC / cancel edges
  forwardDash: '', // solid
  markerId: 'flow-arrow',
} as const

// Label | 13px #595959; white backing; never overlaps a box or another label
export const LABEL_STYLE = {
  color: '#595959',
  size: 13,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  backing: '#ffffff', // white backing rect behind label text
  backingPadX: 3,
  backingPadY: 1,
  // approximate glyph advance as a fraction of font-size (matches the .mjs
  // validator's `txt.length * fs * 0.5` heuristic for clash detection)
  glyphAdvance: 0.5,
} as const

// Spacing | rank gap ≥120, column gap ≥60; canvas = content bbox + 26px margin
export const SPACING = {
  rankGap: 120, // vertical gap between layered ranks (>= 120)
  colGap: 60, //   horizontal gap between sibling columns (>= 60)
  margin: 26, //   canvas margin around content bbox
} as const

// Legend | bottom block: solid=forward, dashed=ESC/back, plus any notes; clear of content
export interface LegendSpec {
  gapAboveContent: number // vertical gap between content bottom and legend top
  lineHeight: number
  sampleLen: number // length of the sample line drawn for each legend row
  textSize: number
  textColor: string
  forwardText: string
  backText: string
}

export const LEGEND: LegendSpec = {
  gapAboveContent: 28,
  lineHeight: 22,
  sampleLen: 34,
  textSize: 13,
  textColor: '#595959',
  forwardText: 'forward / confirm (OK, SET)',
  backText: 'ESC / back / cancel',
}

export function roleStyle(role: NodeRole): RoleStyle {
  return ROLE_STYLE[role]
}

export function nodeSize(role: NodeRole, override?: { w: number; h: number }) {
  return override ?? ROLE_STYLE[role].size
}
