// File extraction helpers for the requirement-capture path.
// Runs entirely in the renderer; no IPC round-trip required, except for
// legacy Office files (.doc / .xls / .ppt) which round-trip to the
// host-side `office_convert_legacy` bridge command (Word/Excel/PowerPoint
// COM via PowerShell) and then recurse through the OOXML pipeline.
//
// Heavy parsers (pdfjs-dist, mammoth, jszip, fast-xml-parser) are imported
// dynamically so a failure loading them only affects the file being
// processed — not the whole page.
//
// Supported types:
//   - .pdf                  → text via pdfjs-dist
//   - .docx                 → text via mammoth raw-text
//   - .pptx                 → text via jszip + fast-xml-parser over OOXML
//   - .xlsx                 → cell text via jszip + sharedStrings + sheet XML
//   - .doc / .xls / .ppt    → host converts to OOXML via Office COM, then routed as above
//   - .svg                  → embedded as inline image; <text> elements lifted as text
//   - .png .jpg .jpeg .gif .webp → embedded as inline image
//   - everything else       → read as UTF-8 text (markdown, txt, json-ld, …)

import { bridge } from '../bridge/client'

export type ExtractedImage = {
  /** Human-friendly name used as caption (e.g. `image1.png`, `page-3`). */
  name: string
  mimeType: string
  /** `data:` URL ready for an `<img>` src or BlockNote image block. */
  dataUrl: string
}

/**
 * One run of inline text with optional bold/italic/etc styling. Block-level
 * chunks carry an `inline` array so consumers can build BlockNote
 * `InlineContent[]` (paragraphs with mixed styles) rather than collapsing
 * the whole paragraph to a plain string. The plain `text` field on each
 * chunk is preserved for callers that don't care about styling — it's the
 * same content joined into one string.
 */
export interface StyledRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
}

/** Heading level. BlockNote's default schema supports 1-3; deeper headings
 *  in the source are clamped to 3 by the walker so they still render as a
 *  visible structural break rather than collapsing to a paragraph. */
export type HeadingLevel = 1 | 2 | 3

/**
 * Discriminated tagged-union for an interleaved page of content. Lets the UI
 * splice text and images into BlockNote blocks in the source's natural
 * reading order rather than dumping all text first and all images last.
 *
 * `inline` carries styled runs (bold / italic / underline / strike / code).
 * `text` is the plain-text join — kept so callers that just want a flat
 * text dump don't have to walk the runs themselves.
 */
export type ContentChunk =
  | { kind: 'heading'; level: HeadingLevel; text: string; inline: StyledRun[] }
  | { kind: 'paragraph'; text: string; inline: StyledRun[] }
  | { kind: 'bulletListItem'; text: string; inline: StyledRun[] }
  | { kind: 'numberedListItem'; text: string; inline: StyledRun[] }
  | { kind: 'image'; image: ExtractedImage }
  /** A rectangular grid that renders as a BlockNote `table` block.
   *  Used by the XLSX and CSV extractors so spreadsheets keep their
   *  row/column structure instead of being flattened to text. Cells
   *  carry plain strings (no inline styling) — XLSX/CSV don't ship
   *  rich text per cell at our extraction level. */
  | { kind: 'table'; rows: string[][] }

/** Build a single plain run from a string — convenience for sources that
 *  don't track styling (PDF page text, PPTX text runs, plain text files). */
export function plainRun(text: string): StyledRun[] {
  return text.length > 0 ? [{ text }] : []
}

/**
 * Convert a `kind: 'table'` chunk into a BlockNote table block.
 * BlockNote v0.50's `tableContent` accepts plain-string cells (or
 * full inline-content arrays); plain strings are sufficient for
 * XLSX/CSV which carry no per-cell rich text at our extraction level.
 */
export function tableChunkToBlock(rows: string[][]) {
  return {
    type: 'table' as const,
    content: {
      type: 'tableContent' as const,
      rows: rows.map((r) => ({ cells: r.slice() })),
    },
  }
}

/**
 * Convert a styled-run array into the BlockNote `content` shape:
 *  - If there's a single unstyled run, returns the bare string (BlockNote
 *    accepts `content: string` as shorthand for one unstyled paragraph).
 *  - Otherwise returns an array of `{ type: 'text', text, styles }` items
 *    that BlockNote treats as `InlineContent[]`.
 *
 * Kept editor-agnostic on the type — consumers cast the result to the
 * BlockNote `PartialBlock['content']` they're building.
 */
export function runsToBlockContent(
  runs: StyledRun[],
):
  | string
  | Array<{
      type: 'text'
      text: string
      styles: Record<string, true>
    }> {
  const allUnstyled =
    runs.length > 0 &&
    runs.every(
      (r) => !r.bold && !r.italic && !r.underline && !r.strike && !r.code,
    )
  if (allUnstyled) return runs.map((r) => r.text).join('')
  return runs.map((r) => {
    const styles: Record<string, true> = {}
    if (r.bold) styles.bold = true
    if (r.italic) styles.italic = true
    if (r.underline) styles.underline = true
    if (r.strike) styles.strike = true
    if (r.code) styles.code = true
    return { type: 'text' as const, text: r.text, styles }
  })
}

export interface ExtractedTypography {
  /** Default body-paragraph font name (e.g. "Calibri"). */
  bodyFont?: string
  /** Heading-style font name (often a Light variant). */
  headingFont?: string
}

export type ProcessedTextFile = {
  kind: 'text'
  filename: string
  mimeType: string
  text: string
  pageCount?: number
  /** Embedded or rendered images extracted from the source document. */
  images?: ExtractedImage[]
  /** Interleaved content: text and images in their natural reading order. */
  chunks?: ContentChunk[]
  /** Font names pulled from the source file's style metadata when the
   *  format is rich enough to carry them (DOCX `word/styles.xml`,
   *  PPTX `ppt/theme/*.xml`). Plain-text formats omit this. Reference
   *  ingestion stashes these on `jsonld.structureTemplate.typography`
   *  so Epic / Document seeding can apply the same font to new
   *  authoring without asking an LLM to guess from plain text. */
  typography?: ExtractedTypography
}

export type ProcessedImageFile = {
  kind: 'image'
  filename: string
  mimeType: string
  dataUrl: string
  /** SVGs may carry <text> nodes worth indexing alongside the visual. */
  embeddedText?: string
}

export type ProcessedFile = ProcessedTextFile | ProcessedImageFile

const IMAGE_EXTENSIONS = new Set([
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
])

const IMAGE_MIME_PREFIX = 'image/'

export async function processFile(file: File): Promise<ProcessedFile> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mime = (file.type || '').toLowerCase()

  // Sniff the first bytes to dispatch by content rather than filename, which
  // catches mislabelled files and stops .doc/.bin junk reaching the text path.
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const isZip = head[0] === 0x50 && head[1] === 0x4b // "PK"
  const isPdf =
    head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 // "%PDF"
  const isOleCompound =
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0

  if (
    isPdf ||
    ext === 'pdf' ||
    mime === 'application/pdf'
  ) {
    return extractPdf(file)
  }
  if (
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return extractDocx(file)
  }
  if (
    ext === 'pptx' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return extractPptx(file)
  }
  if (
    ext === 'xlsx' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return extractXlsx(file)
  }
  // CSV: route to its own extractor so it renders as a BlockNote table
  // block. Browsers report CSV as `text/csv` (or sometimes
  // `application/csv` / `application/vnd.ms-excel`); accept all three.
  if (
    ext === 'csv' ||
    mime === 'text/csv' ||
    mime === 'application/csv' ||
    mime === 'application/vnd.ms-excel'
  ) {
    return extractCsv(file)
  }
  // Unknown ZIP: peek inside the archive to disambiguate between docx, pptx,
  // xlsx and "some other zip" so dropping a content-typed-as-empty file
  // still routes correctly.
  if (isZip && ext === '') {
    const sniffed = await sniffOoxmlKind(file)
    if (sniffed === 'docx') return extractDocx(file)
    if (sniffed === 'pptx') return extractPptx(file)
    if (sniffed === 'xlsx') return extractXlsx(file)
  }
  // Outlook .msg — OLE compound, parsed in-renderer via @kenjiuno/msgreader
  // (no Outlook COM round-trip). Sub-detection happens inside extractMsg
  // so we route by ext / mime up front.
  if (
    ext === 'msg' ||
    mime === 'application/vnd.ms-outlook' ||
    mime === 'application/x-outlook-msg'
  ) {
    return extractMsg(file)
  }
  // Legacy Office (Word/Excel/PowerPoint 97–2003 binary). OLE2 magic is
  // the universal signal but doesn't tell us which Office app — we use
  // the file extension to pick. If the extension is missing, fall back
  // to "save as" rather than guess; the user knows what they dropped.
  if (
    ext === 'doc' ||
    ext === 'xls' ||
    ext === 'ppt' ||
    (isOleCompound && (ext === 'doc' || ext === 'xls' || ext === 'ppt'))
  ) {
    const legacy = ext as 'doc' | 'xls' | 'ppt'
    return await convertLegacyOffice(file, legacy)
  }
  if (isOleCompound) {
    throw new Error(
      `${file.name} looks like a legacy Office file but the extension is ` +
        'missing. Rename it to .doc / .xls / .ppt and re-attach so the host can ' +
        'route it to the right Office app for conversion.',
    )
  }
  if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith(IMAGE_MIME_PREFIX)) {
    return processImage(file, ext, mime)
  }

  // Treat as text only if we're confident it's text. Otherwise refuse.
  const sample = await file.slice(0, 4096).arrayBuffer()
  if (looksBinary(new Uint8Array(sample))) {
    throw new Error(
      `Could not detect a supported format for ${file.name}. ` +
        'Supported: PDF, DOCX, PPTX, XLSX, MD, TXT, SVG, PNG, JPG, GIF, WebP.',
    )
  }
  const text = await file.text()
  // Markdown — parse into structured chunks so headings, lists and inline
  // bold/italic/code/strike survive the trip into BlockNote. Plain .txt
  // and other text formats fall through with no chunks (consumers split
  // them into paragraphs themselves).
  const isMarkdown =
    ext === 'md' ||
    ext === 'markdown' ||
    ext === 'mdown' ||
    mime === 'text/markdown' ||
    mime === 'text/x-markdown'
  if (isMarkdown) {
    return {
      kind: 'text',
      filename: file.name,
      mimeType: mime || 'text/markdown',
      text,
      chunks: parseMarkdownToChunks(text),
    }
  }
  return { kind: 'text', filename: file.name, mimeType: mime || 'text/plain', text }
}

/**
 * Lightweight markdown → ContentChunk parser. Handles the structural
 * forms users hit most often when dropping `.md` files into a collection:
 *
 *   - `#`, `##`, `###` ... headings (clamped to 1-3 like the HTML walker)
 *   - bullet (`- `, `* `, `+ `) and numbered (`1. `) list items
 *   - `**bold**`, `__bold__`, `*italic*`, `_italic_`,
 *     `~~strike~~`, `` `code` `` inline runs
 *   - blank-line separated paragraphs
 *
 * Deliberately not a full CommonMark parser — no fenced code blocks,
 * tables, footnotes, link rendering, or images yet. The previous code
 * dumped the entire markdown source in as a single text blob, so this
 * is a strict upgrade.
 */
export function parseMarkdownToChunks(md: string): ContentChunk[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const chunks: ContentChunk[] = []
  let paraBuf: string[] = []

  const flushParagraph = () => {
    if (paraBuf.length === 0) return
    const joined = paraBuf.join(' ').replace(/\s+/g, ' ').trim()
    if (joined.length > 0) {
      chunks.push({
        kind: 'paragraph',
        text: joined,
        inline: parseInlineMarkdown(joined),
      })
    }
    paraBuf = []
  }

  // GitHub-Flavored Markdown table parser. Looks for a run of pipe-
  // delimited lines, drops the `|---|---|` separator row, and emits a
  // single `kind: 'table'` chunk so the BlockNote conversion path can
  // turn it into a proper table block.
  const isTableLine = (s: string) =>
    /^\s*\|/.test(s) && s.trim().endsWith('|')
  const isTableSeparator = (s: string) =>
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s)
  const splitTableRow = (s: string): string[] => {
    const trimmed = s.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split('|').map((c) => c.trim())
  }

  let i = 0
  for (; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    if (isTableLine(line)) {
      // Confirm it's a table by checking the next line looks like a
      // separator (we treat the first row as the header). If not, fall
      // through so a literal `| something |` line just becomes a
      // paragraph.
      const next = lines[i + 1]?.replace(/\s+$/, '') ?? ''
      if (isTableSeparator(next)) {
        flushParagraph()
        const rows: string[][] = [splitTableRow(line)]
        i += 2 // skip header + separator
        while (i < lines.length && isTableLine(lines[i])) {
          rows.push(splitTableRow(lines[i]))
          i++
        }
        i-- // outer loop will re-increment
        chunks.push({ kind: 'table', rows })
        continue
      }
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      const raw = heading[1].length
      const level = (raw <= 1 ? 1 : raw === 2 ? 2 : 3) as HeadingLevel
      const text = heading[2].trim()
      if (text.length > 0) {
        chunks.push({
          kind: 'heading',
          level,
          text,
          inline: parseInlineMarkdown(text),
        })
      }
      continue
    }
    // Standalone image line: `![alt](url)` — emit a `kind: 'image'`
    // chunk so the BlockNote converter renders a proper image block.
    // Only matches when the image is the whole line (Confluence pages
    // typically place each image on its own paragraph).
    const imageOnly = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/)
    if (imageOnly) {
      flushParagraph()
      const alt = imageOnly[1].trim() || 'image'
      const url = imageOnly[2].trim()
      // Infer mime from data: URL prefix if present, else fall back to png.
      let mimeType = 'image/png'
      const m = url.match(/^data:([^;]+);/)
      if (m) mimeType = m[1]
      chunks.push({
        kind: 'image',
        image: { name: alt, mimeType, dataUrl: url },
      })
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      flushParagraph()
      const text = bullet[1].trim()
      if (text.length > 0) {
        chunks.push({
          kind: 'bulletListItem',
          text,
          inline: parseInlineMarkdown(text),
        })
      }
      continue
    }
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/)
    if (numbered) {
      flushParagraph()
      const text = numbered[1].trim()
      if (text.length > 0) {
        chunks.push({
          kind: 'numberedListItem',
          text,
          inline: parseInlineMarkdown(text),
        })
      }
      continue
    }
    paraBuf.push(line.trim())
  }
  flushParagraph()
  return chunks
}

/** Inline markdown styling. Splits the input by paired markers and emits
 *  `StyledRun[]`. Order matters: code is processed first so its contents
 *  don't get re-parsed for emphasis. */
function parseInlineMarkdown(text: string): StyledRun[] {
  type Mark = keyof Pick<
    StyledRun,
    'bold' | 'italic' | 'underline' | 'strike' | 'code'
  >
  const splitByMarker = (
    runs: StyledRun[],
    re: RegExp,
    style: Mark,
  ): StyledRun[] => {
    const next: StyledRun[] = []
    for (const run of runs) {
      // Don't re-parse inside an already-styled run for the same flag,
      // or inside a code run (literal contents).
      if (run[style] || run.code) {
        next.push(run)
        continue
      }
      const parts = run.text.split(re)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part === undefined || part === '') continue
        if (i % 2 === 0) {
          next.push({ ...run, text: part })
        } else {
          next.push({ ...run, text: part, [style]: true })
        }
      }
    }
    return next
  }

  let runs: StyledRun[] = [{ text }]
  // Code first — literal contents.
  runs = splitByMarker(runs, /`([^`\n]+)`/g, 'code')
  // Bold (** or __) before italic so `**foo**` doesn't get eaten as italic.
  runs = splitByMarker(runs, /\*\*([^*\n]+)\*\*/g, 'bold')
  runs = splitByMarker(runs, /__([^_\n]+)__/g, 'bold')
  // Strike.
  runs = splitByMarker(runs, /~~([^~\n]+)~~/g, 'strike')
  // Italic — single * or _.
  runs = splitByMarker(runs, /\*([^*\n]+)\*/g, 'italic')
  runs = splitByMarker(runs, /_([^_\n]+)_/g, 'italic')
  return runs.filter((r) => r.text.length > 0)
}

// A heuristic: presence of NUL bytes or a high ratio of non-printable
// bytes is a reliable "this is binary, not text" signal.
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0) return true
    // Allow tab, LF, CR, and printable ASCII; everything else counts.
    if (b !== 9 && b !== 10 && b !== 13 && (b < 32 || b > 126)) {
      nonPrintable++
    }
  }
  return nonPrintable / bytes.length > 0.3
}

// Backwards-compatible alias for the old text-only API. Returns an
// ExtractedFile-shaped object for non-image inputs and `null` for images.
export async function extractTextFromFile(file: File): Promise<ProcessedTextFile> {
  const result = await processFile(file)
  if (result.kind === 'text') return result
  // Promote SVG embedded text into the text-only contract for callers that
  // didn't ask about images.
  return {
    kind: 'text',
    filename: result.filename,
    mimeType: result.mimeType,
    text: result.embeddedText ?? '',
  }
}

/**
 * Outlook .msg — OLE compound documents with the email subject, headers,
 * body (plain or HTML), and embedded attachments. Parsed in-renderer via
 * `@kenjiuno/msgreader` so we don't need to round-trip to host-side
 * Outlook COM (which would require the user to have Outlook installed).
 *
 * Output shape:
 *   - h1 with the subject
 *   - paragraphs for the From / To / Date metadata block
 *   - a "Body" h2, then either the parsed HTML body (preserves heading
 *     levels, lists, bold/italic via `htmlBodyToChunks`) or split-paragraph
 *     plain text fallback
 *   - an "Attachments" h2, then either an inline image chunk per
 *     image-mime attachment or a paragraph naming each non-image
 *     attachment
 */
async function extractMsg(file: File): Promise<ProcessedTextFile> {
  const mod = await import('@kenjiuno/msgreader')
  const MsgReader =
    (mod as { default?: typeof mod }).default ??
    (mod as unknown as new (buffer: ArrayBuffer) => unknown)

  const buffer = await file.arrayBuffer()
  const Ctor = MsgReader as unknown as new (buffer: ArrayBuffer) => {
    getFileData: () => MsgFieldsData
  }
  const data = new Ctor(buffer).getFileData()

  const chunks: ContentChunk[] = []
  const images: ExtractedImage[] = []

  if (data.subject && data.subject.trim()) {
    const t = data.subject.trim()
    chunks.push({ kind: 'heading', level: 1, text: t, inline: plainRun(t) })
  }

  const metaLines: string[] = []
  if (data.senderName || data.senderEmail) {
    const sender = [
      data.senderName ?? '',
      data.senderEmail ? `<${data.senderEmail}>` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
    if (sender) metaLines.push(`From: ${sender}`)
  }
  if (Array.isArray(data.recipients) && data.recipients.length > 0) {
    const recipients = data.recipients
      .map((r) => {
        const name = r.name ?? ''
        const addr = r.smtpAddress ?? ''
        return [name, addr ? `<${addr}>` : ''].filter(Boolean).join(' ').trim()
      })
      .filter(Boolean)
      .join('; ')
    if (recipients) metaLines.push(`To: ${recipients}`)
  }
  const date =
    data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime
  if (date) metaLines.push(`Date: ${date}`)
  for (const line of metaLines) {
    chunks.push({ kind: 'paragraph', text: line, inline: plainRun(line) })
  }

  const hasBody =
    (data.bodyHtml && data.bodyHtml.trim()) || (data.body && data.body.trim())
  if (hasBody) {
    chunks.push({ kind: 'heading', level: 2, text: 'Body', inline: plainRun('Body') })
    if (data.bodyHtml && data.bodyHtml.trim()) {
      try {
        const doc = await parseDocument(data.bodyHtml, 'text/html')
        const htmlChunks = htmlBodyToChunks(doc.body)
        chunks.push(...htmlChunks)
      } catch {
        // HTML parse failure — fall back to plain text body if present.
        if (data.body && data.body.trim()) {
          for (const p of splitIntoParagraphs(data.body)) {
            chunks.push({ kind: 'paragraph', text: p, inline: plainRun(p) })
          }
        }
      }
    } else if (data.body) {
      for (const p of splitIntoParagraphs(data.body)) {
        chunks.push({ kind: 'paragraph', text: p, inline: plainRun(p) })
      }
    }
  }

  if (Array.isArray(data.attachments) && data.attachments.length > 0) {
    chunks.push({
      kind: 'heading',
      level: 2,
      text: 'Attachments',
      inline: plainRun('Attachments'),
    })
    for (const att of data.attachments) {
      const filename = att.fileName ?? att.name ?? `attachment-${chunks.length}`
      const mime = (att.attachMimeTag ?? guessMimeFromExt(att.extension ?? '')).trim()
      if (mime.startsWith('image/') && att.content && att.content.length > 0) {
        const dataUrl = `data:${mime};base64,${uint8ToBase64(att.content)}`
        const image: ExtractedImage = { name: filename, mimeType: mime, dataUrl }
        chunks.push({ kind: 'image', image })
        images.push(image)
      } else {
        const line = mime
          ? `Attachment: ${filename} (${mime})`
          : `Attachment: ${filename}`
        chunks.push({ kind: 'paragraph', text: line, inline: plainRun(line) })
      }
    }
  }

  const text = chunks
    .filter((c) => c.kind !== 'image')
    .map((c) => (c as { text: string }).text)
    .join('\n\n')

  return {
    kind: 'text',
    filename: file.name,
    mimeType: 'application/vnd.ms-outlook',
    text,
    images,
    chunks,
  }
}

/**
 * Subset of `@kenjiuno/msgreader`'s FieldsData that we actually consume.
 * Kept as a local interface so we don't lock the whole library shape into
 * our type surface — the upstream library exports many properties we
 * don't read.
 */
interface MsgFieldsData {
  subject?: string
  senderName?: string
  senderEmail?: string
  body?: string
  bodyHtml?: string
  messageDeliveryTime?: string
  clientSubmitTime?: string
  creationTime?: string
  recipients?: Array<{ name?: string; smtpAddress?: string }>
  attachments?: Array<{
    fileName?: string
    name?: string
    extension?: string
    attachMimeTag?: string
    content?: Uint8Array
  }>
}

/** Base64-encode a Uint8Array (small enough for an email attachment;
 *  for very large blobs we'd want a chunked approach). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length))
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

function guessMimeFromExt(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '')
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    msg: 'application/vnd.ms-outlook',
  }
  return map[e] ?? ''
}

/**
 * Worker-safe canvas factory for pdfjs. pdfjs's default
 * `DOMCanvasFactory` calls `document.createElement('canvas')` for the
 * scratch canvases it needs during a page render (image scaling, soft
 * masks, patterns). That throws inside a Web Worker because `document`
 * doesn't exist (we stub it for pdfjs's startup, but the stub's
 * createElement returns a real `OffscreenCanvas` only by accident) —
 * the safer move is to override the factory entirely.
 *
 * pdfjs 4.x's `getDocument` accepts a `CanvasFactory` *class* (capital
 * C) which it `new`s with `{ ownerDocument }`. We provide a class
 * exposing the trio `create` / `reset` / `destroy` it relies on. The
 * `canvasFactory` (lowercase) option for passing a pre-built instance
 * varies by minor version; the class path is the stable contract.
 */
type WorkerCanvas = HTMLCanvasElement | OffscreenCanvas
type WorkerCanvasCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
class WorkerSafeCanvasFactory {
  create(width: number, height: number): { canvas: WorkerCanvas; context: WorkerCanvasCtx } {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h)
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      return { canvas, context }
    }
    // Main-thread fallback (no OffscreenCanvas — old jsdom, tests).
    if (typeof document !== 'undefined' && typeof (document as { createElement?: unknown }).createElement === 'function') {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const context = canvas.getContext('2d')! as CanvasRenderingContext2D
      return { canvas, context }
    }
    throw new Error('no canvas implementation available')
  }
  reset(
    canvasAndContext: { canvas: WorkerCanvas; context: WorkerCanvasCtx },
    width: number,
    height: number,
  ): void {
    canvasAndContext.canvas.width = Math.max(1, width | 0)
    canvasAndContext.canvas.height = Math.max(1, height | 0)
  }
  destroy(canvasAndContext: { canvas: WorkerCanvas; context: WorkerCanvasCtx }): void {
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
  }
}

/**
 * Walk a PDF page's operator list and return one bbox per embedded
 * raster image (image XObject), in canvas pixel coordinates.
 *
 * PDF images are drawn by `paintImageXObject` after the CTM has been
 * set so the image fills the unit square `[0,0]–[1,1]` in user space.
 * We replay that CTM ourselves — tracking `save` / `restore` / `transform`
 * ops — then compose with the viewport transform to land in canvas
 * pixels. The four transformed unit-square corners give us an
 * axis-aligned bounding rect on the rendered page; we crop the
 * already-rendered page canvas to that rect to produce a per-image
 * data URL.
 *
 * Vector graphics (paths drawn directly with line/curve ops) don't
 * generate image XObjects and are intentionally NOT captured by this
 * path — the user explicitly asked for the *raster images on each
 * page* to come in separately, not the full page bitmap.
 */
type Affine2D = [number, number, number, number, number, number]
async function extractPdfPageImageBboxes(
  pdfjs: { OPS: Record<string, number> },
  page: {
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>
  },
  viewport: { transform: number[]; width: number; height: number },
): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const opList = await page.getOperatorList()
  const OPS = pdfjs.OPS
  const out: { x: number; y: number; w: number; h: number }[] = []

  const mMul = (a: Affine2D, b: Affine2D): Affine2D => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
  const mApply = (m: Affine2D, x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]

  const vt = viewport.transform as unknown as Affine2D
  let m: Affine2D = [1, 0, 0, 1, 0, 0]
  const stack: Affine2D[] = []

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]
    const args = opList.argsArray[i]
    if (fn === OPS.save) {
      stack.push([...m] as Affine2D)
    } else if (fn === OPS.restore) {
      const prev = stack.pop()
      if (prev) m = prev
    } else if (fn === OPS.transform) {
      m = mMul(m, args as Affine2D)
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      const total = mMul(vt, m)
      const corners: [number, number][] = [
        mApply(total, 0, 0),
        mApply(total, 1, 0),
        mApply(total, 0, 1),
        mApply(total, 1, 1),
      ]
      const xs = corners.map(([cx]) => cx)
      const ys = corners.map(([, cy]) => cy)
      const left = Math.max(0, Math.floor(Math.min(...xs)))
      const right = Math.min(viewport.width, Math.ceil(Math.max(...xs)))
      const top = Math.max(0, Math.floor(Math.min(...ys)))
      const bottom = Math.min(viewport.height, Math.ceil(Math.max(...ys)))
      const w = right - left
      const h = bottom - top
      // Skip thumbnail-sized images (bullet glyphs, watermarks, logos
      // in headers). 24×24 keeps icons out while still catching the
      // smallest legitimate screenshots.
      if (w < 24 || h < 24) continue
      out.push({ x: left, y: top, w, h })
    }
  }
  return out
}

/** Crop a sub-rect of a worker-safe canvas and encode it as a JPEG / PNG data URL. */
async function cropCanvasToDataUrl(
  source: HTMLCanvasElement | OffscreenCanvas,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  mime: string,
  quality?: number,
): Promise<string> {
  const { ctx, toDataUrl } = makeCanvas2d(sw, sh)
  if (!ctx) throw new Error('no canvas implementation for crop')
  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh)
  return toDataUrl(mime, quality)
}

async function extractPdf(file: File): Promise<ProcessedTextFile> {
  // pdfjs is designed for the main thread; it reaches for `document`
  // (specifically the FontLoader constructor's
  // `ownerDocument = globalThis.document` default) immediately on
  // import / getDocument. In a Web Worker `document` is undefined and
  // pdfjs throws `ReferenceError: document is not defined` before any
  // option we'd pass can take effect. We stub a minimal `document`
  // surface so pdfjs's checks pass; the only methods it ends up
  // calling are routed through our CanvasFactory below, so the stub
  // never has to actually do DOM work.
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
    // Minimal `document` surface so pdfjs's FontLoader and vite's HMR
    // client (which gets injected into every worker module in dev)
    // don't crash. None of these methods need to do real DOM work in
    // the worker — vite's HMR is a no-op here, pdfjs's font/canvas
    // calls get routed through our CanvasFactory below.
    const noopElement = (): HTMLElement => ({
      style: {},
      setAttribute: () => {},
      removeAttribute: () => {},
      appendChild: () => {},
      removeChild: () => {},
      insertBefore: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getAttribute: () => null,
      classList: { add: () => {}, remove: () => {}, contains: () => false },
    }) as unknown as HTMLElement
    ;(globalThis as Record<string, unknown>).document = {
      fonts: { ready: Promise.resolve(), forEach: () => {}, add: () => {} },
      createElement: (tag: string) => {
        if (tag === 'canvas' && typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement
        }
        return noopElement()
      },
      createElementNS: () => noopElement(),
      createTextNode: () => ({ nodeValue: '' }),
      querySelector: () => null,
      querySelectorAll: () => [] as unknown as NodeListOf<Element>,
      getElementById: () => null,
      getElementsByTagName: () => [] as unknown as HTMLCollectionOf<Element>,
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: noopElement(),
      head: noopElement(),
      body: noopElement(),
    }
  }

  const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default
  ;(pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerUrl

  const buffer = await file.arrayBuffer()
  // cMaps and standard fonts are copied into the vite `public/` dir at
  // setup time so they're served as static assets in dev and bundled
  // for production. Without these, pdfjs renders standard-font glyphs
  // as tofu boxes — the visible symptom that started this fix.
  const docOpts = {
    data: new Uint8Array(buffer),
    cMapUrl: '/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs-standard-fonts/',
    // CanvasFactory is the CLASS pdfjs `new`s; pass the class itself,
    // not an instance.
    CanvasFactory: WorkerSafeCanvasFactory,
    // Tell pdfjs not to try to use the document-level FontFace API
    // (it's not available in workers anyway). With this set, pdfjs
    // renders standard fonts via the bytes from standardFontDataUrl
    // and won't try to inject @font-face rules.
    disableFontFace: true,
    useSystemFonts: false,
  }
  const doc = await pdfjs.getDocument(docOpts as Parameters<typeof pdfjs.getDocument>[0]).promise
  const pageCount = doc.numPages

  // Backstop against pathological PDFs (every page held as a JPEG data
  // URL in memory until the draft commits). At scale 1.0 / quality 0.78
  // a typical screenshot-heavy page is ~50–150 KB, so 2000 pages tops
  // out around 100–300 MB of transient renderer memory — sustainable
  // on a desktop and effectively "render every page" for any realistic
  // how-to / reference PDF.
  const MAX_RENDERED_PAGES = 2000
  const renderUpTo = Math.min(pageCount, MAX_RENDERED_PAGES)

  const pages: string[] = []
  const images: ExtractedImage[] = []
  const chunks: ContentChunk[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item: unknown) => {
        if (item && typeof item === 'object' && 'str' in item) {
          return (item as { str: string }).str
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
    pages.push(pageText)

    // Per-page heading
    chunks.push({
      kind: 'heading',
      level: 1,
      text: `Page ${i}`,
      inline: plainRun(`Page ${i}`),
    })
    // Per-page text — split paragraphs by blank lines, fall back to one
    // paragraph if there's no blank-line splitting.
    const paras = splitIntoParagraphs(pageText)
    if (paras.length > 0) {
      for (const p of paras) {
        chunks.push({ kind: 'paragraph', text: p, inline: plainRun(p) })
      }
    } else if (pageText.trim().length > 0) {
      const t = pageText.trim()
      chunks.push({ kind: 'paragraph', text: t, inline: plainRun(t) })
    }

    if (i <= renderUpTo) {
      try {
        // Render scale: PDF user space is 1/72-inch units. Scale 4
        // (= 288 DPI) is print-quality — screenshots inside a how-to
        // PDF have the headroom for the user to zoom the cropped
        // image without blur even on a 4K display. Per-page transient
        // memory rises with the square of scale; we only ever hold one
        // render canvas at a time (it's freed before the next page is
        // rendered) and each crop is JPEG-encoded so the persisted
        // draft size scales much more gently than the render canvas.
        const RENDER_SCALE = 4.0
        const viewport = page.getViewport({ scale: RENDER_SCALE })
        const { ctx } = makeCanvas2d(viewport.width, viewport.height)
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise
          const pageCanvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas
          const bboxes = await extractPdfPageImageBboxes(pdfjs, page, viewport)
          let imgIdx = 0
          for (const bbox of bboxes) {
            try {
              // Pad the crop by a couple of canvas pixels so antialiased
              // edges of the original image aren't shaved off at the
              // bbox boundary. Clamped to the canvas extents.
              const PAD = 2
              const sx = Math.max(0, bbox.x - PAD)
              const sy = Math.max(0, bbox.y - PAD)
              const sw = Math.min(viewport.width - sx, bbox.w + PAD * 2)
              const sh = Math.min(viewport.height - sy, bbox.h + PAD * 2)
              const dataUrl = await cropCanvasToDataUrl(
                pageCanvas,
                sx,
                sy,
                sw,
                sh,
                'image/jpeg',
                0.88,
              )
              imgIdx += 1
              const image: ExtractedImage = {
                name: `page-${i}-image-${imgIdx}`,
                mimeType: 'image/jpeg',
                dataUrl,
              }
              images.push(image)
              chunks.push({ kind: 'image', image })
            } catch (err) {
              console.warn(`PDF page ${i} image ${imgIdx + 1} crop failed:`, err)
            }
          }
        }
      } catch (err) {
        console.warn(`PDF page ${i} render failed:`, err)
      }
    }
  }
  return {
    kind: 'text',
    filename: file.name,
    mimeType: 'application/pdf',
    text: pages.join('\n\n'),
    pageCount,
    images,
    chunks,
  }
}

async function extractDocx(file: File): Promise<ProcessedTextFile> {
  const mammothModule = await import('mammoth')
  const mammoth = (mammothModule as { default?: typeof mammothModule }).default
    ?? mammothModule
  const buffer = await file.arrayBuffer()

  // convertToHtml with images.dataUri preserves the *position* of each image
  // inline in the output HTML, so we can walk the DOM to produce
  // text-then-image-then-text chunks in source order — like PDF and PPTX
  // already do — instead of dumping all images at the end.
  type MammothApi = {
    convertToHtml: (
      input: { arrayBuffer: ArrayBuffer },
      opts?: { convertImage?: unknown },
    ) => Promise<{ value: string }>
    images?: { dataUri?: unknown }
  }
  const m = mammoth as unknown as MammothApi
  const html = await m.convertToHtml(
    { arrayBuffer: buffer },
    { convertImage: m.images?.dataUri },
  )

  const doc = await parseDocument(html.value, 'text/html')
  const chunks = htmlBodyToChunks(doc.body)
  const images = chunks
    .filter((c): c is { kind: 'image'; image: ExtractedImage } => c.kind === 'image')
    .map((c) => c.image)
  // Plain-text body for FTS (no markup, no data URLs).
  const text = chunks
    .filter((c) => c.kind !== 'image')
    .map((c) => (c as { text: string }).text)
    .join('\n\n')

  // Parse the .docx ZIP a second time to pull font defaults out of
  // `word/styles.xml`. Mammoth doesn't surface this — its HTML drops
  // all font information — so we read the raw style XML ourselves.
  // Failure is non-fatal: a Reference without typography just falls
  // back to the app default font.
  const typography = await extractDocxTypography(buffer)

  return {
    kind: 'text',
    filename: file.name,
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    text,
    images,
    chunks,
    ...(typography ? { typography } : {}),
  }
}

/**
 * Pull body + heading font names from `word/styles.xml` inside the
 * .docx ZIP. Returns `null` when the ZIP doesn't contain the style
 * file or neither font can be inferred.
 *
 * - **bodyFont**: `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="…"/>`.
 *   Word writes the document-default run font here.
 * - **headingFont**: looks for `<w:style w:styleId="Heading1">` first,
 *   then any "Heading*" style, and reads its `<w:rPr><w:rFonts>`.
 *   Falls back to `bodyFont` when no heading style has its own font
 *   (common in templates that share a single font).
 */
async function extractDocxTypography(
  buffer: ArrayBuffer,
): Promise<ExtractedTypography | null> {
  try {
    const JSZipModule = await import('jszip')
    const JSZip =
      (JSZipModule as { default?: typeof JSZipModule }).default ?? JSZipModule
    const zip = await JSZip.loadAsync(buffer)
    const stylesFile = zip.files['word/styles.xml']
    if (!stylesFile) return null
    const xml = await stylesFile.async('string')

    // Pull the document-default run font.
    const bodyMatch = xml.match(
      /<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:rFonts\b([^>]*)/i,
    )
    const bodyFont = extractAsciiFont(bodyMatch?.[1])

    // Pull a heading font from the most likely style ids.
    const headingFont =
      readStyleFont(xml, 'Heading1') ??
      readStyleFont(xml, 'Heading2') ??
      readStyleFont(xml, 'Heading') ??
      null

    const out: ExtractedTypography = {}
    if (bodyFont) out.bodyFont = bodyFont
    if (headingFont) out.headingFont = headingFont
    return Object.keys(out).length > 0 ? out : null
  } catch (e) {
    console.warn('[extract-docx] typography parse failed', e)
    return null
  }
}

function readStyleFont(stylesXml: string, styleId: string): string | null {
  const re = new RegExp(
    `<w:style\\b[^>]*\\bw:styleId="${styleId}"[\\s\\S]*?</w:style>`,
    'i',
  )
  const m = stylesXml.match(re)
  if (!m) return null
  const rFontsMatch = m[0].match(/<w:rFonts\b([^>]*)/i)
  return extractAsciiFont(rFontsMatch?.[1])
}

function extractAsciiFont(attrBlob: string | undefined): string | null {
  if (!attrBlob) return null
  // Prefer `w:ascii` (default Latin script); fall back to `w:cs` and
  // `w:hAnsi` which Word also fills in for non-default scripts.
  const ascii = attrBlob.match(/\bw:ascii="([^"]+)"/i)?.[1]
  const hAnsi = attrBlob.match(/\bw:hAnsi="([^"]+)"/i)?.[1]
  const cs = attrBlob.match(/\bw:cs="([^"]+)"/i)?.[1]
  const candidate = ascii || hAnsi || cs
  if (!candidate) return null
  const trimmed = candidate.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Inline-style flags accumulated while we recurse into nested
 *  `<strong>`, `<em>`, `<u>`, `<s>`, `<code>` etc. */
interface InlineStyleStack {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
}

/** Map a list of styled runs to a single plain string for the chunk's
 *  back-compat `text` field (callers that don't care about styling). */
function runsToPlainText(runs: StyledRun[]): string {
  return runs
    .map((r) => r.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Append text to the trailing run if its styles match, otherwise push a
 *  new run. Keeps the run list compact when consecutive text nodes share
 *  the same style — important so BlockNote doesn't render a wall of
 *  unstyled-but-fragmented spans. */
function pushRun(
  buffer: StyledRun[],
  text: string,
  s: InlineStyleStack,
): void {
  if (text.length === 0) return
  const styles: Partial<StyledRun> = {}
  if (s.bold) styles.bold = true
  if (s.italic) styles.italic = true
  if (s.underline) styles.underline = true
  if (s.strike) styles.strike = true
  if (s.code) styles.code = true
  const last = buffer[buffer.length - 1]
  if (
    last &&
    Boolean(last.bold) === Boolean(styles.bold) &&
    Boolean(last.italic) === Boolean(styles.italic) &&
    Boolean(last.underline) === Boolean(styles.underline) &&
    Boolean(last.strike) === Boolean(styles.strike) &&
    Boolean(last.code) === Boolean(styles.code)
  ) {
    last.text += text
    return
  }
  buffer.push({ text, ...styles })
}

/**
 * Walk an HTML body element and emit ContentChunks in document order,
 * preserving heading level (h1-h6 → 1/2/3 clamped), inline bold / italic
 * / underline / strike / code styling, and bullet / numbered list items.
 *
 * Block-level elements flush the current run buffer; inline elements push
 * a styled run with the current style stack. Images get their own chunk.
 */
function htmlBodyToChunks(body: HTMLElement): ContentChunk[] {
  const chunks: ContentChunk[] = []
  let runBuffer: StyledRun[] = []
  const styleStack: InlineStyleStack = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
  }
  // Track the current list-item kind: 'ul' = bullet, 'ol' = numbered,
  // null = no list.
  type ListKind = 'ul' | 'ol' | null
  let currentList: ListKind = null

  const flushAs = (
    kind: 'paragraph' | 'bulletListItem' | 'numberedListItem',
  ) => {
    if (runBuffer.length === 0) return
    const text = runsToPlainText(runBuffer)
    if (text.length === 0) {
      runBuffer = []
      return
    }
    chunks.push({ kind, text, inline: runBuffer })
    runBuffer = []
  }

  const flushAsParagraph = () => flushAs('paragraph')

  const visit = (node: Node) => {
    // Use the numeric DOM node type constants directly rather than
    // `Node.TEXT_NODE` / `Node.ELEMENT_NODE`. The static `Node`
    // constants live on `globalThis.Node` (window-scoped), which is
    // `undefined` in Web Workers — and that's where this walker runs
    // when the extract pipeline is invoked through the worker client.
    // The numeric values (TEXT_NODE=3, ELEMENT_NODE=1) are part of
    // the DOM Living Standard and work everywhere.
    if (node.nodeType === 3) {
      pushRun(runBuffer, node.textContent ?? '', styleStack)
      return
    }
    if (node.nodeType !== 1) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    // Heading h1-h6 — clamp to BlockNote's level 1-3.
    const headingMatch = tag.match(/^h([1-6])$/)
    if (headingMatch) {
      flushAsParagraph()
      const raw = parseInt(headingMatch[1] ?? '1', 10)
      const level = (raw <= 1 ? 1 : raw === 2 ? 2 : 3) as HeadingLevel
      const headingRuns: StyledRun[] = []
      const swap = runBuffer
      runBuffer = headingRuns
      for (const child of Array.from(el.childNodes)) visit(child)
      runBuffer = swap
      const text = runsToPlainText(headingRuns)
      if (text.length > 0) {
        chunks.push({ kind: 'heading', level, text, inline: headingRuns })
      }
      return
    }

    if (tag === 'img') {
      flushAsParagraph()
      const src = el.getAttribute('src') ?? ''
      if (!src) return
      const mime = src.match(/^data:([^;]+)/)?.[1] ?? 'image/png'
      const rawAlt = el.getAttribute('alt')?.trim() ?? ''
      // Drop the auto-generated Word alt-text patterns ("A screenshot
      // of a computer Description automatically generated", "AI-
      // generated content may be incorrect", etc.) at import time —
      // they're noise under the image and the user complained that
      // they appear before OCR has a chance to replace them. Empty
      // alt becomes a sequential placeholder; OCR fills it in later.
      const looksBoilerplate = (t: string): boolean => {
        const n = t.replace(/\s+/g, ' ').trim()
        if (n.length === 0) return true
        if (/^(A|An) (screenshot|picture|photo|image|diagram|drawing|graphic|chart|map|illustration|icon)\b/i.test(n)) return true
        if (/Description automatically generated\.?$/i.test(n)) return true
        if (/^AI[- ]generated content may be incorrect\.?$/i.test(n)) return true
        return false
      }
      const alt = looksBoilerplate(rawAlt) ? '' : rawAlt
      chunks.push({
        kind: 'image',
        image: {
          name: alt.length > 0 ? alt : `image-${chunks.length + 1}`,
          mimeType: mime,
          dataUrl: src,
        },
      })
      return
    }

    // Lists — recurse with currentList set so child <li>s emit the
    // right chunk kind. Nesting inside another list is flattened to the
    // innermost kind (BlockNote v0.50 doesn't render nested-list block
    // structure natively in our schema; treating as flat is the smaller
    // visible loss vs collapsing to paragraphs).
    if (tag === 'ul' || tag === 'ol') {
      flushAsParagraph()
      const prev = currentList
      currentList = tag === 'ol' ? 'ol' : 'ul'
      for (const child of Array.from(el.childNodes)) visit(child)
      currentList = prev
      return
    }

    // List item — flush as the current list kind. If we're outside a
    // list (malformed HTML), default to bullet.
    if (tag === 'li') {
      flushAsParagraph()
      for (const child of Array.from(el.childNodes)) visit(child)
      flushAs(
        currentList === 'ol' ? 'numberedListItem' : 'bulletListItem',
      )
      return
    }

    // Tables — emit as a `table` chunk so BlockNote renders an
    // actual table block instead of one paragraph per cell.
    // Mammoth (.docx) and html-extracted PPTX slides both ship
    // tables as standard `<table><tr><td>` markup; thead/tbody
    // wrappers are walked transparently. Cell text is flattened to
    // a plain string (no inline styling) to match the existing
    // table-chunk contract used by XLSX / CSV.
    if (tag === 'table') {
      flushAsParagraph()
      const rows: string[][] = []
      const cellSelectors = ['th', 'td']
      // Inline plain-text collector for a cell. Walks the cell's
      // DOM directly — does NOT recurse through `visit`, because
      // `visit` would emit nested paragraphs / list items as
      // sibling chunks of the table (the cell's content would leak
      // out *next to* the table instead of staying *inside* it).
      // Block-level descendants (`<p>`, `<li>`, `<div>`, etc.) get
      // joined with single newlines so multi-paragraph cells still
      // read sensibly when BlockNote renders them.
      const BLOCK_TAGS = new Set([
        'p', 'div', 'br', 'li', 'ul', 'ol', 'pre', 'blockquote',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      ])
      const collectCellText = (cell: HTMLElement): string => {
        const parts: string[] = []
        const cur: string[] = []
        const flushPart = () => {
          const t = cur.join('').replace(/\s+/g, ' ').trim()
          if (t.length > 0) parts.push(t)
          cur.length = 0
        }
        const walk = (n: Node): void => {
          if (n.nodeType === 3) {
            cur.push(n.textContent ?? '')
            return
          }
          if (n.nodeType !== 1) return
          const tagName = (n as HTMLElement).tagName.toLowerCase()
          if (tagName === 'br') {
            flushPart()
            return
          }
          if (BLOCK_TAGS.has(tagName)) {
            flushPart()
            for (const c of Array.from(n.childNodes)) walk(c)
            flushPart()
            return
          }
          // Inline element (span, a, strong, em, …) — descend
          // without breaking the current text segment.
          for (const c of Array.from(n.childNodes)) walk(c)
        }
        walk(cell)
        flushPart()
        return parts.join('\n')
      }
      const tableRows: HTMLElement[] = Array.from(
        el.querySelectorAll('tr'),
      ) as HTMLElement[]
      for (const tr of tableRows) {
        const cells = Array.from(tr.children).filter((c) =>
          cellSelectors.includes((c as HTMLElement).tagName.toLowerCase()),
        ) as HTMLElement[]
        if (cells.length === 0) continue
        rows.push(cells.map(collectCellText))
      }
      if (rows.length > 0) {
        // Pad short rows with empty strings so every row has the
        // same column count — BlockNote's table block rejects
        // ragged grids.
        const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
        for (const r of rows) {
          while (r.length < cols) r.push('')
        }
        chunks.push({ kind: 'table', rows })
      }
      return
    }

    // Other block-level structural elements flush as paragraph.
    if (
      tag === 'p' ||
      tag === 'div' ||
      tag === 'blockquote' ||
      tag === 'pre' ||
      tag === 'tr' ||
      tag === 'td' ||
      tag === 'br'
    ) {
      flushAsParagraph()
      for (const child of Array.from(el.childNodes)) visit(child)
      flushAsParagraph()
      return
    }

    // Inline styling tags — toggle the corresponding flag for the
    // duration of this subtree, then restore.
    let toggled: keyof InlineStyleStack | null = null
    if (tag === 'strong' || tag === 'b') toggled = 'bold'
    else if (tag === 'em' || tag === 'i') toggled = 'italic'
    else if (tag === 'u') toggled = 'underline'
    else if (tag === 's' || tag === 'strike' || tag === 'del') toggled = 'strike'
    else if (tag === 'code' || tag === 'kbd' || tag === 'samp') toggled = 'code'

    if (toggled !== null) {
      const prev = styleStack[toggled]
      styleStack[toggled] = true
      for (const child of Array.from(el.childNodes)) visit(child)
      styleStack[toggled] = prev
      return
    }

    // Other inline (span, a, font, …) — pass through.
    for (const child of Array.from(el.childNodes)) visit(child)
  }

  for (const child of Array.from(body.childNodes)) visit(child)
  flushAsParagraph()
  return chunks
}

/**
 * Pull body + heading font names from PPTX `ppt/theme/themeN.xml`.
 *   - `<a:fontScheme>` carries `<a:majorFont><a:latin typeface="…"/>`
 *     (headings) and `<a:minorFont><a:latin typeface="…"/>` (body).
 *   - Multiple theme files exist; theme1 is the default. We read it
 *     first and fall through to the others until we find typefaces.
 */
async function extractPptxTypography(
  zip: { files: Record<string, { async: (kind: 'string') => Promise<string> }> },
): Promise<ExtractedTypography | null> {
  try {
    const themePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/theme\/theme\d+\.xml$/i.test(p))
      .sort()
    for (const path of themePaths) {
      const xml = await zip.files[path].async('string')
      const major = xml.match(
        /<a:majorFont>[\s\S]*?<a:latin\b[^>]*\btypeface="([^"]+)"/i,
      )?.[1]
      const minor = xml.match(
        /<a:minorFont>[\s\S]*?<a:latin\b[^>]*\btypeface="([^"]+)"/i,
      )?.[1]
      const out: ExtractedTypography = {}
      if (minor && minor.trim()) out.bodyFont = minor.trim()
      if (major && major.trim()) out.headingFont = major.trim()
      if (Object.keys(out).length > 0) return out
    }
    return null
  } catch (e) {
    console.warn('[extract-pptx] typography parse failed', e)
    return null
  }
}

async function extractPptx(file: File): Promise<ProcessedTextFile> {
  // PPTX is OOXML: a ZIP whose `ppt/slides/slide{N}.xml` contain text runs in
  // `<a:t>` nodes. The office connector documents this; we replicate the
  // same approach in-renderer with jszip + fast-xml-parser so we don't need
  // a Node-only mammoth-equivalent for slides.
  const JSZipModule = await import('jszip')
  const JSZip = (JSZipModule as { default?: typeof JSZipModule }).default ?? JSZipModule
  const { XMLParser } = await import('fast-xml-parser')
  // Drawing-layer converter: walks `<p:sp>` / `<p:cxnSp>` shapes
  // and emits one SVG per slide so PowerPoint's vector drawings
  // survive the import.
  const ooxmlSvg = await import('./ooxml-svg')

  const buffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buffer)
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    // Numeric sort by the trailing slide number so output matches deck order.
    .sort((a, b) => {
      const an = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10)
      const bn = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10)
      return an - bn
    })

  const parser = new XMLParser({
    ignoreAttributes: true,
    preserveOrder: false,
    parseTagValue: false,
    trimValues: false,
  })
  // Second parser instance that PRESERVES attributes — needed by
  // the DrawingML → SVG converter to read `<a:off x= y=>`,
  // `<a:ext cx= cy=>`, `<a:prstGeom prst=>`, `<a:srgbClr val=>`
  // etc. We can't reuse the text parser because it strips
  // attributes by design (cleaner text walking).
  const attrParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })

  // Read the presentation-level slide size so the SVG viewBox is
  // correct. Defaults to 10"×7.5" (the standard 4:3 layout) when
  // `presentation.xml` is missing or malformed.
  let slideSize = ooxmlSvg.DEFAULT_SLIDE_SIZE
  const presFile = zip.files['ppt/presentation.xml']
  if (presFile) {
    try {
      const presXml = await presFile.async('string')
      const presTree = attrParser.parse(presXml) as {
        ['p:presentation']?: { ['p:sldSz']?: { '@_cx'?: string; '@_cy'?: string } }
      }
      const sldSz = presTree?.['p:presentation']?.['p:sldSz']
      const cx = parseInt(sldSz?.['@_cx'] ?? '', 10)
      const cy = parseInt(sldSz?.['@_cy'] ?? '', 10)
      if (Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0) {
        slideSize = { cx, cy }
      }
    } catch {
      /* keep default */
    }
  }

  // Build a per-slide map of media references via the slide's rels file.
  // `_rels/slide{N}.xml.rels` lists every embedded asset; image entries point
  // back into `ppt/media/`. This lets us output each slide's images right
  // beside its text rather than dumping all media at the end.
  const relsParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
  })
  async function imagesForSlide(slidePath: string): Promise<string[]> {
    const slideName = slidePath.split('/').pop() ?? ''
    const relsPath = `ppt/slides/_rels/${slideName}.rels`
    const relsFile = zip.files[relsPath]
    if (!relsFile) return []
    try {
      const xml = await relsFile.async('string')
      const tree = relsParser.parse(xml)
      const rels = tree?.Relationships?.Relationship
      const list = Array.isArray(rels) ? rels : rels ? [rels] : []
      const out: string[] = []
      for (const rel of list) {
        const target = (rel as Record<string, unknown>)['@_Target'] as string | undefined
        if (target && target.includes('media/')) {
          // Targets are like `../media/image1.png`. Normalise to ZIP path.
          const normalised = target.replace(/^\.\.\//, 'ppt/')
          out.push(normalised)
        }
      }
      return out
    } catch {
      return []
    }
  }

  // Build a map mediaPath → ExtractedImage so per-slide lookups are cheap.
  const allMedia = await extractMediaFromZipObj(zip, 'ppt/media/')
  const mediaIndex = new Map<string, ExtractedImage>()
  for (const m of allMedia) {
    mediaIndex.set(`ppt/media/${m.name}`, m)
  }

  const slides: string[] = []
  const chunks: ContentChunk[] = []
  let pageCount = 0
  for (const slidePath of slidePaths) {
    const xml = await zip.files[slidePath].async('string')
    const tree = parser.parse(xml)
    pageCount++

    chunks.push({
      kind: 'heading',
      level: 1,
      text: `Slide ${pageCount}`,
      inline: plainRun(`Slide ${pageCount}`),
    })

    // Pull tables out first so they render as proper BlockNote
    // table blocks. The flat-text pass below uses skipTables=true
    // so cell content doesn't double up as a paragraph.
    const tables = findTablesInOoxml(tree)
    const texts: string[] = []
    walkForTextNodesImpl(tree, texts, /*skipTables=*/ true)

    if (texts.length > 0) {
      const slideText = texts.join(' ').replace(/\s+/g, ' ').trim()
      slides.push(`Slide ${pageCount}\n${slideText}`)
      chunks.push({
        kind: 'paragraph',
        text: slideText,
        inline: plainRun(slideText),
      })
    } else {
      slides.push(`Slide ${pageCount}`)
    }
    for (const rows of tables) {
      chunks.push({ kind: 'table', rows })
      // Append a flat representation to the plain-text slide string
      // too, so FTS searches against the slide's text body still
      // surface table content (the slide-text accumulator skipped
      // the table cells above to avoid duplicate paragraphs).
      const flat = rows
        .map((r) => r.join(' · '))
        .join(' / ')
        .replace(/\s+/g, ' ')
        .trim()
      if (flat.length > 0) {
        const tail = slides.pop() ?? `Slide ${pageCount}`
        slides.push(`${tail}\n${flat}`)
      }
    }

    // Vector-drawings → SVG. Re-parse the slide XML with
    // attributes preserved so the converter can read shape
    // geometry, fills, strokes, and text labels. Fall through
    // silently when there are no shapes worth rendering.
    try {
      const attrTree = attrParser.parse(xml)
      const svg = ooxmlSvg.slideToSvg(attrTree, slideSize)
      if (svg) {
        chunks.push({
          kind: 'image',
          image: {
            name: `Slide ${pageCount} drawings.svg`,
            mimeType: 'image/svg+xml',
            dataUrl: ooxmlSvg.svgToDataUrl(svg),
          },
        })
      }
    } catch (e) {
      console.warn(`[extract-pptx] svg convert failed for slide ${pageCount}:`, e)
    }

    // Append raster images that belong to this slide right under its
    // text + drawing. These are pictures the user actually placed on
    // the slide (`<p:pic>`), separate from the vector-shape layer.
    const slideImages = await imagesForSlide(slidePath)
    for (const mediaPath of slideImages) {
      const img = mediaIndex.get(mediaPath)
      if (img) chunks.push({ kind: 'image', image: img })
    }
  }

  // Pull notes too if present so we capture spoken content alongside slides.
  const notesPaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
    .sort()
  const notes: string[] = []
  for (const notePath of notesPaths) {
    const xml = await zip.files[notePath].async('string')
    const tree = parser.parse(xml)
    const texts: string[] = []
    walkForTextNodes(tree, texts)
    if (texts.length > 0) notes.push(texts.join(' ').replace(/\s+/g, ' ').trim())
  }

  const body = [
    slides.join('\n\n'),
    notes.length > 0 ? '\n\nSpeaker notes:\n' + notes.join('\n\n') : '',
  ]
    .join('')
    .trim()

  const typography = await extractPptxTypography(zip)
  return {
    kind: 'text',
    filename: file.name,
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    text: body,
    pageCount,
    images: allMedia,
    chunks,
    ...(typography ? { typography } : {}),
  }
}

async function extractXlsx(file: File): Promise<ProcessedTextFile> {
  // XLSX is OOXML: a ZIP whose `xl/sharedStrings.xml` is a global string
  // pool and each `xl/worksheets/sheet{N}.xml` references shared strings via
  // <c t="s"><v>idx</v></c>. We resolve the references so the indexed text
  // is the actual cell contents, not numeric pointers.
  const JSZipModule = await import('jszip')
  const JSZip = (JSZipModule as { default?: typeof JSZipModule }).default ?? JSZipModule
  const { XMLParser } = await import('fast-xml-parser')

  const buffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buffer)

  // Parse shared strings table.
  const sharedStrings: string[] = []
  const sharedFile = zip.file('xl/sharedStrings.xml')
  if (sharedFile) {
    const xml = await sharedFile.async('string')
    const parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: false,
    })
    const tree = parser.parse(xml)
    const sst = tree?.sst?.si
    const items = Array.isArray(sst) ? sst : sst ? [sst] : []
    for (const si of items) {
      const texts: string[] = []
      walkForTextNodes(si, texts)
      sharedStrings.push(texts.join(''))
    }
  }

  // Sheet names from workbook.xml so the indexed text is human-readable.
  const sheetNames: string[] = []
  const wbFile = zip.file('xl/workbook.xml')
  if (wbFile) {
    const xml = await wbFile.async('string')
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
    })
    const tree = parser.parse(xml)
    const sheets = tree?.workbook?.sheets?.sheet
    const list = Array.isArray(sheets) ? sheets : sheets ? [sheets] : []
    for (const s of list) {
      const name = (s as Record<string, unknown>)['@_name']
      if (typeof name === 'string') sheetNames.push(name)
    }
  }

  // Iterate sheets in numeric order. Sheet ordering in workbook.xml matches
  // the sheet1.xml/sheet2.xml ordering — index by position into the list.
  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const an = parseInt(a.match(/sheet(\d+)\.xml$/)?.[1] ?? '0', 10)
      const bn = parseInt(b.match(/sheet(\d+)\.xml$/)?.[1] ?? '0', 10)
      return an - bn
    })

  const sheetParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  })

  const flatText: string[] = []
  const chunks: ContentChunk[] = []
  let pageCount = 0
  for (const sheetPath of sheetPaths) {
    pageCount++
    const sheetName = sheetNames[pageCount - 1] ?? `Sheet ${pageCount}`
    const xml = await zip.files[sheetPath].async('string')
    const tree = sheetParser.parse(xml)
    const sheetData = tree?.worksheet?.sheetData
    const rows = sheetData?.row
    const rowList = Array.isArray(rows) ? rows : rows ? [rows] : []

    const rowsOut: string[][] = []
    for (const row of rowList) {
      const cells = (row as Record<string, unknown>).c
      const cellList = Array.isArray(cells) ? cells : cells ? [cells] : []
      const cellTexts: string[] = []
      for (const cell of cellList) {
        const c = cell as Record<string, unknown>
        const t = c['@_t'] as string | undefined
        const v = c.v
        if (t === 's' && v != null) {
          const idx = parseInt(String(v), 10)
          if (!Number.isNaN(idx) && idx >= 0 && idx < sharedStrings.length) {
            cellTexts.push(sharedStrings[idx])
          } else {
            cellTexts.push('')
          }
        } else if (t === 'inlineStr') {
          const isNode = c.is
          const texts: string[] = []
          walkForTextNodes(isNode, texts)
          cellTexts.push(texts.join(''))
        } else if (v != null) {
          cellTexts.push(String(v))
        } else {
          cellTexts.push('')
        }
      }
      // Keep all rows even if some cells are blank — losing them
      // misaligns columns. Drop only completely-empty rows.
      if (cellTexts.some((c) => c.length > 0)) {
        rowsOut.push(cellTexts)
      }
    }

    // One heading per sheet so the BlockNote outline + the attachment
    // toggle pane both show the sheet name; then the table itself.
    // Empty sheets get the heading only — useful breadcrumb for users
    // scanning a workbook with a placeholder tab.
    chunks.push({
      kind: 'heading',
      level: 2,
      text: sheetName,
      inline: plainRun(sheetName),
    })
    if (rowsOut.length > 0) {
      // BlockNote tables require every row to have the same column
      // count — pad short rows with empties.
      const maxCols = rowsOut.reduce((m, r) => Math.max(m, r.length), 0)
      const padded = rowsOut.map((r) =>
        r.length === maxCols ? r : [...r, ...new Array(maxCols - r.length).fill('')],
      )
      chunks.push({ kind: 'table', rows: padded })
      flatText.push(
        `Sheet: ${sheetName}\n${padded.map((r) => r.join('\t')).join('\n')}`,
      )
    } else {
      flatText.push(`Sheet: ${sheetName}`)
    }
  }

  // XLSX images live under `xl/media/`.
  const images = await extractMediaFromZipObj(zip, 'xl/media/')

  return {
    kind: 'text',
    filename: file.name,
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    text: flatText.join('\n\n').trim(),
    pageCount,
    images,
    chunks,
  }
}

/**
 * Parse a CSV file into one table block. Handles RFC-4180-style quoted
 * fields with embedded commas, quotes (doubled `""`), and CRLF/LF row
 * endings. No external dep — the format is small enough that a
 * focused parser is cheaper than dragging in `papaparse`.
 */
async function extractCsv(file: File): Promise<ProcessedTextFile> {
  const text = await file.text()
  const rows = parseCsv(text)
  const chunks: ContentChunk[] = []
  if (rows.length > 0) {
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0)
    const padded = rows.map((r) =>
      r.length === maxCols ? r : [...r, ...new Array(maxCols - r.length).fill('')],
    )
    chunks.push({ kind: 'table', rows: padded })
  }
  return {
    kind: 'text',
    filename: file.name,
    mimeType: 'text/csv',
    text: rows.map((r) => r.join('\t')).join('\n'),
    chunks,
  }
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r') {
      // swallow; handled by \n
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  // Trailing field/row if file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // Drop trailing fully-empty rows (common from CRLF-terminated files).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.length === 0)) {
    rows.pop()
  }
  return rows
}

// Open a ZIP and pull every file under `mediaDir` as a data URL.
async function extractMediaFromZip(
  file: File,
  mediaDir: string,
): Promise<ExtractedImage[]> {
  try {
    const JSZipModule = await import('jszip')
    const JSZip = (JSZipModule as { default?: typeof JSZipModule }).default ?? JSZipModule
    const buffer = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(buffer)
    return extractMediaFromZipObj(zip, mediaDir)
  } catch {
    return []
  }
}

// Same as above but accepts an already-loaded JSZip instance — saves a
// re-read when the caller is already inside the ZIP for text extraction.
async function extractMediaFromZipObj(
  zip: { files: Record<string, unknown> } & {
    file: (path: string) => unknown
  },
  mediaDir: string,
): Promise<ExtractedImage[]> {
  const out: ExtractedImage[] = []
  const entries = Object.keys(zip.files).filter(
    (p) => p.startsWith(mediaDir) && !p.endsWith('/'),
  )
  for (const path of entries) {
    const entry = (zip.files as Record<string, { async: (kind: string) => Promise<unknown>; name: string }>)[path]
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = mimeForExt(ext)
    if (!mimeType) continue
    try {
      const blob = (await entry.async('blob')) as Blob
      const dataUrl = await blobToDataUrl(blob)
      out.push({
        name: path.substring(path.lastIndexOf('/') + 1),
        mimeType,
        dataUrl,
      })
    } catch (err) {
      console.warn(`Failed to read ZIP image ${path}:`, err)
    }
  }
  return out
}

function mimeForExt(ext: string): string | null {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
    case 'jfif':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'svg':
      return 'image/svg+xml'
    case 'tif':
    case 'tiff':
      // TIFF is not natively renderable in <img>; skip rather than embed
      // something that won't display.
      return null
    case 'emf':
    case 'wmf':
      // Windows Metafile / Enhanced Metafile — vector formats unsupported
      // by browsers. Skip rather than embed a broken image.
      return null
    default:
      return null
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

// Walk a parsed-XML tree and collect any `a:t` (OOXML text-run) text content.
function walkForTextNodes(node: unknown, out: string[]): void {
  walkForTextNodesImpl(node, out, /*skipTables=*/ false)
}

/**
 * Slide-level table extractor. Walks a PPTX slide tree (parsed from
 * `ppt/slides/slideN.xml`), finds every `a:tbl` element, and emits
 * a `string[][]` row matrix per table. Cell text is the joined run
 * text inside each cell's `a:tc`.
 *
 * Why not just rely on `walkForTextNodes`: that walker concatenates
 * every `a:t` into a single flat list, so a 3×3 table prints as one
 * paragraph of "header1 header2 header3 row1col1 row1col2 …" with
 * no structure. Pulling tables out separately so they render as
 * BlockNote `table` blocks preserves the grid the user sees in
 * PowerPoint.
 *
 * Used together with `walkForTextNodes(skipTables=true)` so the
 * table cells don't also leak into the flat slide-text paragraph.
 */
function findTablesInOoxml(node: unknown): string[][][] {
  const tables: string[][][] = []
  const visit = (n: unknown): void => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const v of n) visit(v)
      return
    }
    const obj = n as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'a:tbl' || key === 'tbl') {
        const tblNodes = Array.isArray(value) ? value : [value]
        for (const tblNode of tblNodes) {
          const rows = extractTableRows(tblNode)
          if (rows.length > 0) tables.push(rows)
        }
        // Don't recurse into the table — `findTablesInOoxml` doesn't
        // care about nested tables (rare in PPTX), and avoiding the
        // recursion keeps the table-text-collection scope tight.
        continue
      }
      visit(value)
    }
  }
  visit(node)
  return tables
}

function extractTableRows(tbl: unknown): string[][] {
  if (tbl == null || typeof tbl !== 'object') return []
  const rows: string[][] = []
  // a:tbl > a:tr > a:tc. fast-xml-parser unwraps single-element
  // collections to objects, so handle both shapes.
  const tblObj = tbl as Record<string, unknown>
  const trValue = tblObj['a:tr'] ?? tblObj['tr']
  const trs = Array.isArray(trValue) ? trValue : trValue ? [trValue] : []
  for (const tr of trs) {
    if (tr == null || typeof tr !== 'object') continue
    const trObj = tr as Record<string, unknown>
    const tcValue = trObj['a:tc'] ?? trObj['tc']
    const tcs = Array.isArray(tcValue) ? tcValue : tcValue ? [tcValue] : []
    const cells: string[] = []
    for (const tc of tcs) {
      const cellTexts: string[] = []
      walkForTextNodesImpl(tc, cellTexts, /*skipTables=*/ true)
      cells.push(cellTexts.join(' ').replace(/\s+/g, ' ').trim())
    }
    if (cells.length > 0) rows.push(cells)
  }
  // Pad short rows so the matrix is rectangular (BlockNote's table
  // block expects equal-length rows).
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  for (const r of rows) {
    while (r.length < cols) r.push('')
  }
  return rows
}

function walkForTextNodesImpl(
  node: unknown,
  out: string[],
  skipTables: boolean,
): void {
  if (node == null) return
  if (typeof node === 'string') {
    const t = node.trim()
    if (t.length > 0) out.push(t)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) walkForTextNodesImpl(v, out, skipTables)
    return
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      // Skip table subtrees so the slide's flat text doesn't double-
      // up the same content that a separate `findTablesInOoxml` pass
      // emitted as a table chunk.
      if (skipTables && (key === 'a:tbl' || key === 'tbl')) {
        continue
      }
      // OOXML namespaces: `a:t` is the run-text node we want. fast-xml-parser
      // strips the namespace prefix in some configs; accept both.
      if (key === 'a:t' || key === 't') {
        if (typeof value === 'string') {
          const tr = value.trim()
          if (tr.length > 0) out.push(tr)
        } else if (Array.isArray(value)) {
          for (const v of value) walkForTextNodesImpl(v, out, skipTables)
        } else {
          walkForTextNodesImpl(value, out, skipTables)
        }
      } else {
        walkForTextNodesImpl(value, out, skipTables)
      }
    }
  }
}

// Quick OOXML kind sniff: look at the central directory file names without
// fully unzipping content. Returns 'docx' / 'pptx' / 'xlsx' / null.
async function sniffOoxmlKind(file: File): Promise<'docx' | 'pptx' | 'xlsx' | null> {
  try {
    const JSZipModule = await import('jszip')
    const JSZip = (JSZipModule as { default?: typeof JSZipModule }).default ?? JSZipModule
    const buffer = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(buffer)
    const names = Object.keys(zip.files)
    if (names.includes('word/document.xml')) return 'docx'
    if (names.some((n) => n.startsWith('ppt/slides/'))) return 'pptx'
    if (names.includes('xl/workbook.xml')) return 'xlsx'
    return null
  } catch {
    return null
  }
}

async function processImage(
  file: File,
  ext: string,
  mime: string,
): Promise<ProcessedImageFile> {
  const dataUrl = await fileToDataUrl(file)
  const resolvedMime =
    mime || (ext === 'svg' ? 'image/svg+xml' : `image/${ext}`)

  let embeddedText: string | undefined
  if (ext === 'svg' || resolvedMime === 'image/svg+xml') {
    try {
      const xml = await file.text()
      const doc = await parseDocument(xml, 'image/svg+xml')
      // Browsers return a <parsererror> element rather than throwing on bad XML.
      const parseError = doc.getElementsByTagName('parsererror')[0]
      if (!parseError) {
        const textNodes = Array.from(doc.getElementsByTagName('text'))
        const texts = textNodes
          .map((node) => node.textContent?.trim() ?? '')
          .filter((t) => t.length > 0)
        if (texts.length > 0) embeddedText = texts.join('\n')
      }
    } catch {
      // Non-fatal: image still renders without extracted text.
    }
  }

  return {
    kind: 'image',
    filename: file.name,
    mimeType: resolvedMime,
    dataUrl,
    embeddedText,
  }
}

/**
 * Worker-safe 2D canvas factory. On the main thread we use a regular
 * `HTMLCanvasElement` and `toDataURL`; in a Worker (where `document`
 * doesn't exist) we use `OffscreenCanvas` + `convertToBlob` and then
 * read the blob as a data URL. Returned shape is identical on both
 * paths so the caller doesn't branch.
 *
 * Used only by `extractPdf` to render the per-page preview JPEG; if we
 * add other canvas-backed paths later they should share this helper.
 */
function makeCanvas2d(
  width: number,
  height: number,
): {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  toDataUrl: (mime: string, quality?: number) => Promise<string>
} {
  // Use `window` (not `document`) to detect the main thread, because
  // extractPdf stubs `globalThis.document` in workers so pdfjs's own
  // initialization survives. `window` stays undefined in workers
  // either way, so this remains the reliable signal.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    return {
      ctx,
      toDataUrl: async (mime, quality) => canvas.toDataURL(mime, quality),
    }
  }
  // Worker context — OffscreenCanvas. Standard since 2018, supported
  // everywhere Tauri's WebView2 runs.
  if (typeof OffscreenCanvas === 'undefined') {
    return {
      ctx: null,
      toDataUrl: async () => {
        throw new Error('no canvas implementation in this context')
      },
    }
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
  return {
    ctx,
    toDataUrl: async (mime, quality) => {
      const blob = await canvas.convertToBlob({ type: mime, quality })
      // Workers have FileReader so the same blob → dataURL trick works.
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () =>
          reject(reader.error ?? new Error('FileReader failed'))
        reader.readAsDataURL(blob)
      })
    },
  }
}

/**
 * Worker-safe DOM parser. `DOMParser` is `Window`-scoped (not
 * available in Web Workers, despite occasional confusion). When we
 * detect we're off the main thread we route through `linkedom`:
 *   - HTML uses `parseHTML`, which expects a complete document; we
 *     wrap fragment input (mammoth returns bare `<p>...`) so its
 *     body comes back populated.
 *   - SVG / XML uses `linkedom`'s `parseXML` and returns its
 *     `document` directly.
 * Returns the parsed document so callers can keep using
 * `getElementsByTagName` / `body` / `textContent` unchanged.
 */
async function parseDocument(
  input: string,
  type: 'text/html' | 'image/svg+xml',
): Promise<Document> {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(input, type)
  }
  const linkedom = (await import('linkedom')) as {
    parseHTML?: (s: string) => { document: Document }
    parseXML?: (s: string) => Document
  }
  if (type === 'text/html') {
    if (!linkedom.parseHTML) {
      throw new Error('linkedom.parseHTML missing')
    }
    // Mammoth/msgreader return HTML fragments. linkedom's parseHTML
    // only emits a populated `<body>` when handed a complete document;
    // wrap so the rest of the walker can read `doc.body.childNodes`
    // unchanged regardless of which path produced the input.
    const wrapped = /<html[\s>]/i.test(input)
      ? input
      : `<!DOCTYPE html><html><body>${input}</body></html>`
    return linkedom.parseHTML(wrapped).document
  }
  // type === 'image/svg+xml'
  if (!linkedom.parseXML) {
    throw new Error('linkedom.parseXML missing')
  }
  return linkedom.parseXML(input)
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

// Split extracted text into reasonable paragraphs for BlockNote insertion.
export function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
}

// === Legacy Office (.doc / .xls / .ppt) ===========================================
//
// The host's `office_convert_legacy` command drives Word / Excel /
// PowerPoint via COM (through PowerShell) and returns OOXML bytes. We
// recursively process the converted file so the existing DOCX / XLSX /
// PPTX pipelines do the actual content extraction — same chunks, same
// images, same in-place flow. `fileToDataUrl` above is reused.

function dataUrlToFile(
  dataUrl: string,
  filename: string,
  mimeType: string,
): File {
  const commaIdx = dataUrl.indexOf(',')
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], filename, { type: mimeType })
}

async function convertLegacyOffice(
  file: File,
  format: 'doc' | 'xls' | 'ppt',
): Promise<ProcessedFile> {
  let result
  try {
    const dataUrl = await fileToDataUrl(file)
    result = await bridge.officeConvertLegacy({
      dataUrl,
      filename: file.name,
      format,
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    const friendly = legacyFriendlyName(format)
    if (code === 'E_OFFICE_NOT_INSTALLED') {
      throw new Error(
        `${friendly} is not installed on this machine, so ${file.name} can't be ` +
          `converted automatically. Open the file in ${friendly} and use Save As ` +
          `to convert it to .${format}x, then drop the new file.`,
      )
    }
    if (code === 'E_OFFICE_TIMEOUT') {
      throw new Error(
        `Office took longer than 60 seconds to convert ${file.name}. ` +
          'The file may be very large or corrupt — try opening it in Office ' +
          'directly and saving as the modern format.',
      )
    }
    // E_OFFICE_CONVERT, E_OFFICE_PARSE, or anything else
    throw new Error(
      `Couldn't convert ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Recurse through processFile so the converted DOCX/XLSX/PPTX hits the
  // existing OOXML extractor — text + images + interleaved chunks all
  // come out of that pipeline already.
  const converted = dataUrlToFile(result.dataUrl, result.filename, result.mimeType)
  return processFile(converted)
}

function legacyFriendlyName(format: 'doc' | 'xls' | 'ppt'): string {
  if (format === 'doc') return 'Word'
  if (format === 'xls') return 'Excel'
  return 'PowerPoint'
}
