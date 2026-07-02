// Background metadata extraction for saved nodes.
//
// After a user save (Reference, Collection, Document, Epic), we run a
// one-shot LLM extraction over the node's body and persist the result
// as `summary` + `keyPoints` fields on the node's jsonld. The chat
// agent's `list_references` / `list_collections_in_pi` tools surface
// those fields directly, so queries like "list all hardware references
// and extract each function" don't have to read every body.
//
// Fire-and-forget: callers don't await `summariseAndAttach`. If the
// extraction fails the node keeps whatever metadata it had before;
// next save tries again.

import { bridge } from '../bridge/client'
import { enqueueWorkTask } from './work-queue'

// ─── Structure template (LLM-driven) ────────────────────────────────
//
// Extracts the SECTION OUTLINE a new Epic should be seeded with when
// the user picks this reference. The LLM does the semantic filtering
// (drops Cover, TOC, Index, Glossary, etc.) and reports any
// confidently-inferred typography hints (body font, heading font,
// tone). Result lands on the reference's jsonld as
// `structureTemplate`; the home-page Epic-seed flow reads from there
// first and falls back to the regex-based walker only if absent.

const STRUCTURE_SYSTEM_PROMPT = `You analyse a REFERENCE DOCUMENT to extract the structural template that should seed a new Epic written in the same style. Return ONLY a single JSON object — no prose, no markdown fences, no commentary.

Schema:
{
  "sections": [
    {
      "level": 1,
      "title": "Section title",
      "purpose": "One sentence — what this section is FOR. What kind of content belongs here. Written so a new author reading it knows what to put in the section.",
      "styleHint": "Short shape spec for the section's body content — e.g. '3-5 bullet acceptance criteria, imperative tone' or '2-paragraph narrative, third person' or 'numbered requirements with shall-statements'."
    },
    ...
  ],
  "typography": { "bodyFont": "Calibri", "headingFont": "Calibri Light", "tone": "formal-technical" }
}

Rules:
- Sections array in source order, top to bottom
- INCLUDE every authored content section, even ones that look example-specific. Headings like "Happy flow", "Non-happy flow", "Edge cases", "Comments", "Open questions", "Acceptance criteria", "Risks" are PART OF THE TEMPLATE the author should reproduce — do not drop them.
- EXCLUDE front-matter chrome ONLY: cover, title page, table of contents / contents, index, glossary, acronyms, abbreviations, list of figures / tables, revision history, document control / history, copyright, preface, foreword, acknowledgements, bibliography. These are scaffolded separately and the template should not duplicate them.
- Do NOT drop a section just because its body is empty or short. If the heading exists in the source, it belongs in the output.
- level is 1 | 2 | 3 only (clamp deeper levels)
- title is the heading text, trimmed
- purpose is REQUIRED for every section. Look at the actual content under the heading in the source to write it; do NOT generalise from the title alone. Keep it to one sentence under 25 words.
- styleHint is REQUIRED for every section. Describe shape and tone briefly, the way you would brief a junior writer ("five short bullets, action verbs, no first-person"). Under 20 words.
- typography fields are optional; include each only if you can confidently infer it from the body text style. Omit the whole object if you can't infer any.
- tone (under typography) is a short label like "formal-technical", "concise-business", "narrative", "specification"
- Output JSON only. No code fences. No leading or trailing text.`

export interface ExtractedSection {
  level: 1 | 2 | 3
  title: string
  /** One-sentence description of what content belongs in this section.
   *  Used as ghost-text placeholder when seeding an Epic/Document from
   *  the reference, and threaded into slash-command prompts so the LLM
   *  writes section-appropriate content. Optional only for backwards
   *  compatibility with references analysed before purpose-extraction
   *  landed; new analyses always populate it. */
  purpose?: string
  /** Short body-shape spec ("3-5 bullets, imperative tone"). Same
   *  audience as `purpose` — author-facing placeholder + LLM prompt
   *  context. */
  styleHint?: string
}

interface ExtractedStructure {
  sections?: ExtractedSection[]
  typography?: {
    bodyFont?: string
    headingFont?: string
    tone?: string
  }
}

async function extractStructureFromBody(
  bodyText: string,
): Promise<ExtractedStructure | null> {
  if (!bodyText || bodyText.length < MIN_BODY_CHARS) return null
  const truncated =
    bodyText.length > MAX_BODY_CHARS
      ? `${bodyText.slice(0, MAX_BODY_CHARS)}\n\n[...truncated]`
      : bodyText
  try {
    const res = await bridge.llmQuery({
      use: 'summarise' as 'query',
      systemPrompt: STRUCTURE_SYSTEM_PROMPT,
      userPrompt: truncated,
      contextHits: [],
      options: { temperature: 0.2, maxTokens: 2000 },
    })
    const raw = res.markdown.trim()
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim()
    if (!cleaned.startsWith('{')) return null
    const parsed = JSON.parse(cleaned) as ExtractedStructure
    const out: ExtractedStructure = {}
    if (Array.isArray(parsed.sections)) {
      const clean: ExtractedSection[] = parsed.sections
        .filter(
          (s): s is Record<string, unknown> =>
            !!s &&
            typeof s === 'object' &&
            typeof (s as { title?: unknown }).title === 'string',
        )
        .map((s) => {
          const section: ExtractedSection = {
            level: (Math.max(1, Math.min(3, Number(s.level) || 1)) as 1 | 2 | 3),
            title: String(s.title).trim(),
          }
          const purposeRaw = s.purpose
          if (typeof purposeRaw === 'string' && purposeRaw.trim().length > 0) {
            section.purpose = purposeRaw.trim()
          }
          const styleRaw = s.styleHint
          if (typeof styleRaw === 'string' && styleRaw.trim().length > 0) {
            section.styleHint = styleRaw.trim()
          }
          return section
        })
        .filter((s) => s.title.length > 0)
      if (clean.length > 0) out.sections = clean
    }
    if (parsed.typography && typeof parsed.typography === 'object') {
      const t = parsed.typography as Record<string, unknown>
      const typ: ExtractedStructure['typography'] = {}
      if (typeof t.bodyFont === 'string' && t.bodyFont.trim()) {
        typ.bodyFont = t.bodyFont.trim()
      }
      if (typeof t.headingFont === 'string' && t.headingFont.trim()) {
        typ.headingFont = t.headingFont.trim()
      }
      if (typeof t.tone === 'string' && t.tone.trim()) {
        typ.tone = t.tone.trim()
      }
      if (Object.keys(typ).length > 0) out.typography = typ
    }
    return out.sections || out.typography ? out : null
  } catch (e) {
    console.warn('[structure-llm] extraction failed', e)
    return null
  }
}

/**
 * Run the LLM structure extractor against a reference's body and
 * persist the result on the reference's jsonld as `structureTemplate`.
 * Idempotent for the calling round: if the LLM returns nothing we
 * leave the prior template untouched (a stale template is better
 * than a missing one). Fire-and-forget — caller doesn't await.
 */
export async function extractStructureToReference(nodeId: string): Promise<void> {
  try {
    const node = await bridge.readNode(nodeId)
    const draft = node.draft
    if (!draft || !draft.bodyMd) return
    if (draft.type !== 'reference') return
    const bodyText = derivePlainText(draft.bodyMd)
    const template = await extractStructureFromBody(bodyText)
    if (!template) return

    let jsonldObj: Record<string, unknown> = {}
    if (draft.jsonld) {
      try {
        const v = JSON.parse(draft.jsonld)
        if (v && typeof v === 'object') jsonldObj = v as Record<string, unknown>
      } catch {
        /* fall through */
      }
    }
    // Merge the LLM result into any existing `structureTemplate`
    // rather than overwrite it. Typography is captured at file-
    // ingest time from the source's style XML (DOCX `word/styles.xml`,
    // PPTX theme) which is authoritative — the LLM only sees plain
    // text and can't reliably infer fonts. So: prefer the LLM's
    // typography ONLY when nothing was extracted at ingest.
    const priorTemplate =
      (jsonldObj.structureTemplate as Record<string, unknown> | undefined) ?? {}
    const priorTypography = (priorTemplate as { typography?: unknown }).typography
    jsonldObj.structureTemplate = {
      ...priorTemplate,
      ...(template.sections ? { sections: template.sections } : {}),
      ...(priorTypography
        ? { typography: priorTypography }
        : template.typography
          ? { typography: template.typography }
          : {}),
      extractedAtUtc: new Date().toISOString(),
    }
    await bridge.upsertDraftNode({
      id: nodeId,
      type: draft.type,
      title: draft.title ?? '',
      bodyMd: draft.bodyMd,
      jsonld: JSON.stringify(jsonldObj),
    })
  } catch (e) {
    console.warn('[structure-llm] attach failed', e)
  }
}

/**
 * Queue an LLM structure-template extraction on the background work
 * queue. Deduped by reference id so a flurry of saves on the same
 * reference collapses to one extraction. Use after reference saves
 * alongside `scheduleSummarise`.
 */
export function scheduleStructureExtraction(nodeId: string, title?: string): void {
  enqueueWorkTask({
    label: `Analyzing structure: ${title || nodeId.slice(0, 8)}`,
    dedupeKey: `structure:${nodeId}`,
    run: () => extractStructureToReference(nodeId),
  })
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured metadata from a document. Read the user's content and return ONLY a single JSON object — no prose, no markdown fences, no commentary.

Schema:
{
  "summary": "1-2 sentence plain-text summary of what this document is about",
  "keyPoints": ["concise bullet points capturing the main facts/items in the document, up to 12 entries"]
}

Rules:
- summary must be a single string, 1-2 sentences max
- keyPoints must be an array of plain strings (omit the field if the document is too thin to extract structure)
- Each keyPoint should be a complete short phrase, ideally including a label and a value where the document has them. Examples: "Function: AES-256 encryption", "Range: 0-100 m", "Power: 24V DC, 5A peak"
- For technical/hardware documents, prefer factual data points (specs, capabilities, functions) over narrative
- Output JSON only. No code fences. No explanation. No leading or trailing text.`

interface ExtractedMetadata {
  summary?: string
  keyPoints?: string[]
}

const MIN_BODY_CHARS = 200
const MAX_BODY_CHARS = 16000

/** Walk a BlockNote-shaped body and lift readable strings into a single
 *  plain-text blob the LLM can pattern-match against. Falls back to the
 *  raw input when JSON parsing fails (markdown / plain-text bodies). */
function derivePlainText(bodyMd: string): string {
  if (!bodyMd) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyMd)
  } catch {
    return bodyMd
  }
  const out: string[] = []
  const SKIP_KEYS = new Set(['id', 'url', 'previewWidth', 'name'])
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!v.startsWith('data:') && v.trim().length > 0) out.push(v)
      return
    }
    if (Array.isArray(v)) {
      v.forEach(visit)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SKIP_KEYS.has(k)) continue
        visit(val)
      }
    }
  }
  if (Array.isArray(parsed)) {
    parsed.forEach(visit)
  } else if (parsed && typeof parsed === 'object') {
    // Document/Reference wrapper shape: { name, category, blocks, ... }
    const wrapper = parsed as Record<string, unknown>
    if (Array.isArray(wrapper.blocks)) {
      wrapper.blocks.forEach(visit)
    } else {
      visit(parsed)
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function extractFromBody(bodyText: string): Promise<ExtractedMetadata | null> {
  if (!bodyText || bodyText.length < MIN_BODY_CHARS) return null
  const truncated =
    bodyText.length > MAX_BODY_CHARS
      ? `${bodyText.slice(0, MAX_BODY_CHARS)}\n\n[...truncated]`
      : bodyText
  try {
    const res = await bridge.llmQuery({
      // `summarise` is a non-`query` use-id, which means shell_bridge's
      // llm_query path skips the MCP wiring (we don't need graph access
      // for a single-doc extraction — the body is in the user prompt).
      use: 'summarise' as 'query',
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt: truncated,
      contextHits: [],
      options: { temperature: 0.2, maxTokens: 1500 },
    })
    const raw = res.markdown.trim()
    // Strip a code fence if the model wrapped output despite instructions.
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim()
    if (!cleaned.startsWith('{')) return null
    const parsed = JSON.parse(cleaned) as ExtractedMetadata
    const out: ExtractedMetadata = {}
    if (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0) {
      out.summary = parsed.summary.trim()
    }
    if (Array.isArray(parsed.keyPoints)) {
      const cleanPoints = parsed.keyPoints
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .slice(0, 12)
      if (cleanPoints.length > 0) out.keyPoints = cleanPoints
    }
    if (!out.summary && !out.keyPoints) return null
    return out
  } catch (e) {
    console.warn('[summarise] extraction failed', e)
    return null
  }
}

/**
 * Read a node, extract `summary` + `keyPoints` from its body via the LLM,
 * and write the metadata back into the node's `jsonld`. Other jsonld
 * fields (`piId`, `category`, `name`, etc.) are preserved verbatim.
 *
 * Callers should NOT `await` this — it runs after the user's save has
 * completed and the user has moved on. Failures are silent; next save
 * retries.
 */
/**
 * Background-queue wrapper around `summariseAndAttach`. Use this from
 * post-save fire-and-forget call sites: it shows the running task in
 * the bottom status bar and dedupes by node id so a flurry of saves
 * collapses to one extraction.
 */
export function scheduleSummarise(nodeId: string, title?: string): void {
  enqueueWorkTask({
    label: `Indexing ${title || nodeId.slice(0, 8)}`,
    dedupeKey: `summarise:${nodeId}`,
    run: () => summariseAndAttach(nodeId),
  })
}

export async function summariseAndAttach(nodeId: string): Promise<void> {
  try {
    const node = await bridge.readNode(nodeId)
    const draft = node.draft
    if (!draft || !draft.bodyMd) return
    const bodyText = derivePlainText(draft.bodyMd)
    const meta = await extractFromBody(bodyText)
    if (!meta) return

    let jsonldObj: Record<string, unknown> = {}
    if (draft.jsonld) {
      try {
        const v = JSON.parse(draft.jsonld)
        if (v && typeof v === 'object') {
          jsonldObj = v as Record<string, unknown>
        }
      } catch {
        /* fall through with empty object */
      }
    }
    if (meta.summary) jsonldObj.summary = meta.summary
    if (meta.keyPoints && meta.keyPoints.length > 0) {
      jsonldObj.keyPoints = meta.keyPoints
    }
    // Stamp a marker so consumers can tell auto-summarised nodes from
    // ones whose summary was author-written.
    jsonldObj.summaryGeneratedAtUtc = new Date().toISOString()

    await bridge.upsertDraftNode({
      id: nodeId,
      type: draft.type,
      title: draft.title ?? '',
      bodyMd: draft.bodyMd,
      jsonld: JSON.stringify(jsonldObj),
    })
  } catch (e) {
    console.warn('[summarise] save-back failed', e)
  }
}
