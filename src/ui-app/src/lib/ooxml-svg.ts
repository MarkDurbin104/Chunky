// PPTX DrawingML → SVG converter.
//
// PowerPoint slides carry their visual content as DrawingML primitives
// (rectangles, ellipses, lines, connectors, text boxes) under
// `<p:sp>` / `<p:cxnSp>` elements inside `ppt/slides/slideN.xml`.
// Mammoth doesn't see PPTX at all and our existing PPTX walker only
// captures `<a:t>` run text, so all the geometry — every callout
// box, every arrow, every diagram — is dropped.
//
// This module converts a parsed slide XML tree into a single SVG
// string that preserves: shape position and size, preset geometry
// (rectangle, rounded rect, ellipse, triangle, line, connector),
// solid fills, solid strokes with width, and the shape's text
// positioned inside its bounding box. SVG is a portable open
// format that the BlockNote editor renders inline via an `<img>`
// data URL.
//
// Out of scope (any of these silently fall back to a stroked
// rectangle so the user at least sees *something* is there):
//   - custom geometry (`<a:custGeom>` paths)
//   - gradient / pattern / picture fills
//   - charts (`<p:graphicFrame>` with a chart reference — separate
//     parse pass needed)
//   - SmartArt diagrams (`ppt/diagrams/*.xml`)
//   - theme-color resolution (`<a:schemeClr>` — we resolve only
//     `<a:srgbClr val="RRGGBB">`)
//   - 3D effects, shadows, glow
//
// Coordinate system: PPTX uses EMU (914400 EMU = 1 inch). We keep
// EMU as the SVG `viewBox` units so position math is lossless;
// rendering at any DPI just rescales the viewBox to pixels.

/** Slide dimensions in EMU. Default is 10"×7.5". */
export interface SlideSize {
  cx: number
  cy: number
}

/** Standard PowerPoint default slide size (16:9 was added later;
 *  presentations.xml carries the real value when not default). */
export const DEFAULT_SLIDE_SIZE: SlideSize = { cx: 9144000, cy: 6858000 }

interface Xfrm {
  x: number
  y: number
  cx: number
  cy: number
}

interface Shape {
  xfrm: Xfrm
  preset: string | null
  fill: string | null
  stroke: string | null
  strokeWidthEmu: number | null
  text: string
  isConnector: boolean
  flipH: boolean
  flipV: boolean
}

/**
 * Convert a parsed slide XML tree (the same shape `fast-xml-parser`
 * produces with `ignoreAttributes:false, attributeNamePrefix:'@_'`)
 * into an SVG string. Returns `null` when the slide has no shapes
 * worth rendering (everything that survived has no geometry).
 */
export function slideToSvg(slideTree: unknown, size: SlideSize): string | null {
  const shapes: Shape[] = []
  collectShapes(slideTree, shapes)
  // Filter out shapes that wholly lack geometry — those would render
  // as a 0×0 invisible blip.
  const usable = shapes.filter(
    (s) => s.xfrm.cx > 0 && s.xfrm.cy > 0,
  )
  if (usable.length === 0) return null

  const w = Math.max(1, size.cx)
  const h = Math.max(1, size.cy)
  const body = usable.map(renderShape).join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">`,
    `<rect width="${w}" height="${h}" fill="white"/>`,
    body,
    `</svg>`,
  ].join('\n')
}

/** Encode a string for direct embedding in an SVG data URL. Base64
 *  avoids URL-encoding the angle brackets, quotes, and ampersands
 *  that DrawingML colour comments and shape text routinely contain. */
export function svgToDataUrl(svg: string): string {
  // Use TextEncoder for proper UTF-8 → base64; many shapes carry
  // non-ASCII text (e.g. degree signs, em dashes from PowerPoint
  // smart-quotes), which `btoa` would mangle if given raw chars.
  const bytes = new TextEncoder().encode(svg)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/svg+xml;base64,${btoa(bin)}`
}

// ---------------- Walk and collect shapes ----------------

function collectShapes(node: unknown, out: Shape[]): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectShapes(v, out)
    return
  }
  const obj = node as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'p:sp' || key === 'sp') {
      const list = Array.isArray(value) ? value : [value]
      for (const sp of list) {
        const s = parseShape(sp, /*isConnector=*/ false)
        if (s) out.push(s)
      }
      continue
    }
    if (key === 'p:cxnSp' || key === 'cxnSp') {
      const list = Array.isArray(value) ? value : [value]
      for (const sp of list) {
        const s = parseShape(sp, /*isConnector=*/ true)
        if (s) out.push(s)
      }
      continue
    }
    // Group shapes: `<p:grpSp>` contains nested `<p:sp>` etc.
    // Recurse into everything else.
    collectShapes(value, out)
  }
}

function parseShape(sp: unknown, isConnector: boolean): Shape | null {
  if (sp == null || typeof sp !== 'object') return null
  const spObj = sp as Record<string, unknown>
  const spPr = pick(spObj, 'p:spPr', 'spPr') as Record<string, unknown> | null
  const xfrm = parseXfrm(spPr)
  if (!xfrm) return null

  // Preset geometry: `<a:prstGeom prst="rect">`.
  const prstGeom = pick(spPr ?? {}, 'a:prstGeom', 'prstGeom') as
    | Record<string, unknown>
    | null
  const preset = prstGeom ? (prstGeom['@_prst'] as string | undefined) ?? null : null

  // Fill: only handle solid color from srgbClr for now. Anything else
  // (gradient, theme color, pattern, picture) → null (no fill).
  const solidFill = pick(spPr ?? {}, 'a:solidFill', 'solidFill') as
    | Record<string, unknown>
    | null
  const fill = solidFill ? parseSrgb(solidFill) : null

  // Stroke: `<a:ln w="EMU"><a:solidFill>…</a:solidFill></a:ln>`.
  const ln = pick(spPr ?? {}, 'a:ln', 'ln') as Record<string, unknown> | null
  let stroke: string | null = null
  let strokeWidthEmu: number | null = null
  if (ln) {
    const lnSolid = pick(ln, 'a:solidFill', 'solidFill') as
      | Record<string, unknown>
      | null
    stroke = lnSolid ? parseSrgb(lnSolid) : null
    const w = parseInt((ln['@_w'] as string | undefined) ?? '', 10)
    strokeWidthEmu = Number.isFinite(w) ? w : null
  }

  // Text inside the shape (txBody → paragraphs → runs).
  const txBody = pick(spObj, 'p:txBody', 'txBody') as
    | Record<string, unknown>
    | null
  const text = txBody ? collectTextFromTxBody(txBody) : ''

  // Flip flags on xfrm: `<a:xfrm flipH="1" flipV="1">`.
  const xfrmRaw = (spPr ? pick(spPr, 'a:xfrm', 'xfrm') : null) as
    | Record<string, unknown>
    | null
  const flipH = xfrmRaw ? (xfrmRaw['@_flipH'] as string | undefined) === '1' : false
  const flipV = xfrmRaw ? (xfrmRaw['@_flipV'] as string | undefined) === '1' : false

  return {
    xfrm,
    preset,
    fill,
    stroke: stroke ?? (isConnector ? '#444' : null),
    strokeWidthEmu,
    text,
    isConnector,
    flipH,
    flipV,
  }
}

function parseXfrm(spPr: Record<string, unknown> | null): Xfrm | null {
  if (!spPr) return null
  const xfrm = pick(spPr, 'a:xfrm', 'xfrm') as Record<string, unknown> | null
  if (!xfrm) return null
  const off = pick(xfrm, 'a:off', 'off') as Record<string, unknown> | null
  const ext = pick(xfrm, 'a:ext', 'ext') as Record<string, unknown> | null
  const x = parseInt((off?.['@_x'] as string | undefined) ?? '0', 10)
  const y = parseInt((off?.['@_y'] as string | undefined) ?? '0', 10)
  const cx = parseInt((ext?.['@_cx'] as string | undefined) ?? '0', 10)
  const cy = parseInt((ext?.['@_cy'] as string | undefined) ?? '0', 10)
  if (![x, y, cx, cy].every((n) => Number.isFinite(n))) return null
  return { x, y, cx, cy }
}

function parseSrgb(node: Record<string, unknown>): string | null {
  const srgb = pick(node, 'a:srgbClr', 'srgbClr') as
    | Record<string, unknown>
    | null
  const val = srgb ? (srgb['@_val'] as string | undefined) : undefined
  if (val && /^[0-9a-fA-F]{6}$/.test(val)) return `#${val}`
  return null
}

function collectTextFromTxBody(txBody: Record<string, unknown>): string {
  // Walk for `a:t` text the same way our slide-text pass does.
  const out: string[] = []
  const visit = (n: unknown): void => {
    if (n == null) return
    if (typeof n === 'string') {
      const t = n.trim()
      if (t.length > 0) out.push(t)
      return
    }
    if (Array.isArray(n)) {
      for (const v of n) visit(v)
      return
    }
    if (typeof n !== 'object') return
    const obj = n as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'a:t' || key === 't') {
        if (typeof value === 'string') {
          const t = value.trim()
          if (t.length > 0) out.push(t)
        } else {
          visit(value)
        }
      } else {
        visit(value)
      }
    }
  }
  visit(txBody)
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] != null) return obj[k]
  }
  return null
}

// ---------------- Render ----------------

function renderShape(s: Shape): string {
  const { x, y, cx, cy } = s.xfrm
  const fill = s.fill ?? 'none'
  const stroke = s.stroke ?? (s.fill ? 'none' : '#888')
  const strokeWidth = s.strokeWidthEmu ?? 12700 // 1pt default
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"`

  let body: string
  switch (s.preset) {
    case 'ellipse':
    case 'oval':
    case 'circle': {
      const rx = cx / 2
      const ry = cy / 2
      body = `<ellipse cx="${x + rx}" cy="${y + ry}" rx="${rx}" ry="${ry}" ${common}/>`
      break
    }
    case 'roundRect':
    case 'round1Rect':
    case 'round2SameRect':
    case 'round2DiagRect': {
      const r = Math.min(cx, cy) * 0.1
      body = `<rect x="${x}" y="${y}" width="${cx}" height="${cy}" rx="${r}" ry="${r}" ${common}/>`
      break
    }
    case 'triangle':
    case 'rtTriangle': {
      const pts =
        s.preset === 'rtTriangle'
          ? `${x},${y} ${x + cx},${y + cy} ${x},${y + cy}`
          : `${x + cx / 2},${y} ${x + cx},${y + cy} ${x},${y + cy}`
      body = `<polygon points="${pts}" ${common}/>`
      break
    }
    case 'line':
    case 'straightConnector1': {
      const x1 = s.flipH ? x + cx : x
      const y1 = s.flipV ? y + cy : y
      const x2 = s.flipH ? x : x + cx
      const y2 = s.flipV ? y : y + cy
      body = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke === 'none' ? '#444' : stroke}" stroke-width="${strokeWidth}"/>`
      break
    }
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': {
      body = renderArrow(s.preset, x, y, cx, cy, fill, stroke, strokeWidth)
      break
    }
    default: {
      // Unknown / custom geometry — fall back to a stroked rectangle
      // so the shape is still visible at the right position.
      body = `<rect x="${x}" y="${y}" width="${cx}" height="${cy}" fill="${fill === 'none' ? 'rgba(0,0,0,0.02)' : fill}" stroke="${stroke === 'none' ? '#888' : stroke}" stroke-width="${strokeWidth}"/>`
      break
    }
  }

  // Centered text label. Font size scales with shape height —
  // PowerPoint's default body text is ~18pt = 228600 EMU.
  let label = ''
  if (s.text.length > 0) {
    const fontSize = Math.max(100000, Math.min(cy * 0.4, 228600))
    label = `<text x="${x + cx / 2}" y="${y + cy / 2}" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central" fill="#111" font-family="Arial, sans-serif">${escapeXml(s.text)}</text>`
  }
  return body + label
}

function renderArrow(
  preset: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
): string {
  // Build the arrow polygon based on direction. The point sits at
  // 80% of the long axis; tail is half the short axis.
  const common = `fill="${fill === 'none' ? '#cce' : fill}" stroke="${stroke === 'none' ? '#446' : stroke}" stroke-width="${strokeWidth}"`
  let pts = ''
  switch (preset) {
    case 'rightArrow': {
      const tail = cy * 0.3
      const headStart = cx * 0.7
      pts = `
        ${x},${y + tail}
        ${x + headStart},${y + tail}
        ${x + headStart},${y}
        ${x + cx},${y + cy / 2}
        ${x + headStart},${y + cy}
        ${x + headStart},${y + cy - tail}
        ${x},${y + cy - tail}
      `
      break
    }
    case 'leftArrow': {
      const tail = cy * 0.3
      const headEnd = cx * 0.3
      pts = `
        ${x + cx},${y + tail}
        ${x + headEnd},${y + tail}
        ${x + headEnd},${y}
        ${x},${y + cy / 2}
        ${x + headEnd},${y + cy}
        ${x + headEnd},${y + cy - tail}
        ${x + cx},${y + cy - tail}
      `
      break
    }
    case 'upArrow': {
      const tail = cx * 0.3
      const headEnd = cy * 0.3
      pts = `
        ${x + tail},${y + cy}
        ${x + tail},${y + headEnd}
        ${x},${y + headEnd}
        ${x + cx / 2},${y}
        ${x + cx},${y + headEnd}
        ${x + cx - tail},${y + headEnd}
        ${x + cx - tail},${y + cy}
      `
      break
    }
    case 'downArrow':
    default: {
      const tail = cx * 0.3
      const headStart = cy * 0.7
      pts = `
        ${x + tail},${y}
        ${x + tail},${y + headStart}
        ${x},${y + headStart}
        ${x + cx / 2},${y + cy}
        ${x + cx},${y + headStart}
        ${x + cx - tail},${y + headStart}
        ${x + cx - tail},${y}
      `
      break
    }
  }
  return `<polygon points="${pts.replace(/\s+/g, ' ').trim()}" ${common}/>`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
