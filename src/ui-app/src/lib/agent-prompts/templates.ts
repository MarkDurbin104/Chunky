// D-021 slash-command prompt templates.
//
// Each command's `buildPrompt` produces a typed `{systemPrompt, userPrompt}`
// pair. The host (DocumentEditor / EpicEditor) calls `bridge.llmQuery` with
// the result, then surfaces the response in a SlashProposalPanel for
// accept / edit / reject.
//
// Audit-log discipline (HITL #17): the prompt copy here is reviewed at
// merge-time and frozen. Edits to a template here MUST be reviewed in PR.

export interface SlashContext {
  /** The full document body as Markdown / stringified BlockNote. */
  docBody: string
  /** The currently-selected text (empty string if nothing selected). */
  selection: string
  /** Doc name for header context. */
  docName: string
  /** Names of pinned references (for /match-style + /structure-from). */
  pinnedReferences: Array<{ id: string; name: string; category?: string; summary?: string }>
  /** Linked collection ids (for /cite scope). */
  linkedCollections: string[]
  /** Optional free-text user input collected via the prompt's argInput. */
  userInput?: string
  /** Title of the section the cursor is currently inside (the nearest
   *  preceding heading). Used to make slash-generated content
   *  section-appropriate. */
  sectionTitle?: string
  /** Section purpose, threaded through from the seeding reference's
   *  structureTemplate. Stored on the heading block's
   *  `props.sectionPurpose` and walked up from the cursor. */
  sectionPurpose?: string
  /** Section style hint (shape/tone spec) from the same source as
   *  `sectionPurpose`. */
  sectionStyleHint?: string
}

export interface PromptOutput {
  systemPrompt: string
  userPrompt: string
  /** Whether the result should replace the selection (true) or be inserted
   *  at the cursor as a proposal (false). */
  replaceSelection: boolean
}

export interface PromptDefinition {
  id: string
  label: string
  description: string
  /** True if this command needs free-text input from the user (e.g. a
   *  description for /draft). The host opens an input modal first and
   *  passes the result via `userInput`. */
  needsArgInput: boolean
  argPlaceholder?: string
  /** Some commands require non-empty selection to be useful. */
  requiresSelection?: boolean
  build: (ctx: SlashContext) => PromptOutput
}

const SYSTEM_BASE =
  'You are a senior product manager assistant inside a local-first PM scratch pad. Stay concise, keep tone neutral, prefer plain Markdown. NEVER fabricate citations — if you reference a node, only do so when its UUID is provided in the prompt context.'

const ref = (r: SlashContext['pinnedReferences'][number]) =>
  `- ${r.name}${r.category ? ` (${r.category})` : ''}${r.summary ? `: ${r.summary}` : ''}`

/**
 * Render the section-context block prefix included in every slash
 * userPrompt. Pulls the cursor's nearest-heading title, purpose, and
 * styleHint (threaded through from the seeding reference's
 * `structureTemplate`) so the model writes content that fits the
 * section. Returns an empty string when no section context is
 * available — the prompt then falls through to the doc-level voice
 * cues from `pinnedReferences`.
 */
export function sectionContextBlock(ctx: SlashContext): string {
  if (!ctx.sectionTitle && !ctx.sectionPurpose && !ctx.sectionStyleHint) {
    return ''
  }
  const lines: string[] = ['Current section context:']
  if (ctx.sectionTitle) lines.push(`- Heading: ${ctx.sectionTitle}`)
  if (ctx.sectionPurpose) lines.push(`- Purpose: ${ctx.sectionPurpose}`)
  if (ctx.sectionStyleHint) lines.push(`- Style: ${ctx.sectionStyleHint}`)
  lines.push(
    'Write content that fits the purpose and follows the style. Do not repeat the heading.',
  )
  return lines.join('\n')
}

export const PROMPTS: PromptDefinition[] = [
  {
    id: 'draft',
    label: 'Draft a new section',
    description: 'Generate a Markdown section from a brief description.',
    needsArgInput: true,
    argPlaceholder: 'What should this section cover?',
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' When drafting a new section: produce 2-4 short paragraphs OR a bullet list, never both. Lead with a sentence that names the topic. Avoid headings unless the user explicitly asks for one.',
      userPrompt: [
        `Document: ${ctx.docName || '(untitled)'}`,
        sectionContextBlock(ctx),
        ctx.pinnedReferences.length > 0
          ? `Pinned style references (treat as voice/tone exemplars, not facts to copy):\n${ctx.pinnedReferences
              .map(ref)
              .join('\n')}`
          : '',
        `\nWrite a section about:\n${ctx.userInput ?? '(no description provided)'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      replaceSelection: false,
    }),
  },
  {
    id: 'expand',
    label: 'Expand selection',
    description: 'Rewrite the selected text more thoroughly.',
    needsArgInput: false,
    requiresSelection: true,
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' When expanding: keep the original meaning, add specificity, examples, or clarifying detail. Aim for ~2x the original length, not more.',
      userPrompt: [
        sectionContextBlock(ctx),
        `Expand this passage:\n\n${ctx.selection}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      replaceSelection: true,
    }),
  },
  {
    id: 'cite',
    label: 'Suggest citations',
    description: 'Find collection ids worth citing for the selected passage.',
    needsArgInput: false,
    requiresSelection: true,
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' Output ONLY a Markdown bullet list of suggested citation chips, format `- [<uuid>] — <one-line reason>`. Use only UUIDs that appear in the linkedCollections list. Do not invent uuids.',
      userPrompt: [
        `Passage to cite:\n${ctx.selection}`,
        ctx.linkedCollections.length > 0
          ? `Available linked collection uuids:\n${ctx.linkedCollections.map((c) => `- ${c}`).join('\n')}`
          : 'No linked collections — return "No collections to cite from."',
      ].join('\n\n'),
      replaceSelection: false,
    }),
  },
  {
    id: 'match-style',
    label: 'Match style of references',
    description: 'Rewrite the selection in the voice of pinned references.',
    needsArgInput: false,
    requiresSelection: true,
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' When matching style: preserve the meaning of the original. Adjust tone, sentence rhythm, and vocabulary to match the pinned references\' voice. Do NOT copy phrases verbatim from the references.',
      userPrompt: [
        sectionContextBlock(ctx),
        ctx.pinnedReferences.length > 0
          ? `Pin a style on this passage. Reference voices to match:\n${ctx.pinnedReferences.map(ref).join('\n')}`
          : 'No references pinned — pin one via "Pin References" then retry. Return "No pinned references." for now.',
        `\nPassage:\n${ctx.selection}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      replaceSelection: true,
    }),
  },
  {
    id: 'structure-from',
    label: 'Apply structure from a reference',
    description: 'Reorganise the document using a pinned reference as a structural template.',
    needsArgInput: false,
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' When applying structure: produce a Markdown skeleton (## headings + 1-line stubs per heading). Match the structural shape of the pinned reference; do not copy its content.',
      userPrompt: [
        ctx.pinnedReferences.length > 0
          ? `Use the structural shape of:\n${ctx.pinnedReferences.map(ref).join('\n')}`
          : 'No references pinned — return "No pinned reference to draw structure from."',
        `\nCurrent document body (for context, not to rewrite):\n${ctx.docBody.slice(0, 4000)}`,
      ].join('\n\n'),
      replaceSelection: false,
    }),
  },
  {
    id: 'summarise',
    label: 'Summarise selection',
    description: 'One-paragraph summary of the selected text (or the full doc if nothing selected).',
    needsArgInput: false,
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' Produce a single neutral paragraph (3-5 sentences) capturing the main points. No heading, no bullets.',
      userPrompt: ctx.selection
        ? `Summarise:\n\n${ctx.selection}`
        : `Summarise this document:\n\n${ctx.docBody.slice(0, 8000)}`,
      replaceSelection: false,
    }),
  },
  {
    id: 'ask',
    label: 'Ask a free-form question',
    description: 'Run an arbitrary question against the document body as context.',
    needsArgInput: true,
    argPlaceholder: 'What do you want to know?',
    build: (ctx) => ({
      systemPrompt:
        SYSTEM_BASE +
        ' Answer the user\'s question using the document body as context. If the answer is not in the body, say so plainly.',
      userPrompt: [
        `Question:\n${ctx.userInput ?? '(none)'}`,
        `\nDocument:\n${ctx.docBody.slice(0, 8000)}`,
      ].join('\n\n'),
      replaceSelection: false,
    }),
  },
]

export function findPrompt(id: string): PromptDefinition | undefined {
  return PROMPTS.find((p) => p.id === id)
}
