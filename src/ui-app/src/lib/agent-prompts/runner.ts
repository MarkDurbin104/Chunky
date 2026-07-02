// Slash-command runner — wires a PromptDefinition to bridge.llmQuery.

import { bridge } from '../../bridge/client'
import {
  findPrompt,
  type PromptDefinition,
  type PromptOutput,
  type SlashContext,
} from './templates'

export interface RunResult {
  markdown: string
  /** Whether to replace the selection (vs insert at cursor). */
  replaceSelection: boolean
  citations: Array<{ nodeId: string; used: boolean }>
}

/**
 * Per D-021 §4.12: each slash invocation records a structured audit event
 * carrying the command id and shape only — NEVER the body, selection text,
 * or user input. This lets ops see usage patterns ("/cite ran 12 times,
 * /draft ran 3 times") without leaking content. The Rust side appends a
 * `slash.<commandId>` line to `<appData>/logs/policy.jsonl` alongside the
 * existing `llm.query.invoked` line when this field is present.
 */
export interface SlashAuditShape {
  commandId: string
  /** True if the user had text selected at invocation time. */
  hasSelection: boolean
  /** True if the user supplied free-text arg via SlashArgPrompt. */
  hasArg: boolean
  /** True if the command will replace the selection (vs insert at cursor). */
  replaceSelection: boolean
}

export async function runSlashCommand(
  command: PromptDefinition,
  ctx: SlashContext,
  audit?: SlashAuditShape,
): Promise<RunResult> {
  return runFromPrompt(command.build(ctx), audit)
}

/**
 * Variant that takes a pre-built `PromptOutput` so callers that need
 * `replaceSelection` ahead of the (slow) LLM call can build the prompt
 * once and reuse it. Avoids the double-build pattern that `runSlashCommand`
 * had to do internally.
 *
 * When `audit` is supplied the Rust llm_query handler will emit a
 * `slash.<commandId>` audit entry alongside its standard
 * `llm.query.invoked` entry. Callers from non-slash surfaces (the chat
 * page) leave it undefined.
 */
export async function runFromPrompt(
  prompt: PromptOutput,
  audit?: SlashAuditShape,
): Promise<RunResult> {
  const res = await bridge.llmQuery({
    use: 'query',
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    contextHits: [],
    options: { temperature: 0.4, maxTokens: 800 },
    ...(audit ? { slashAudit: audit } : {}),
  })
  return {
    markdown: res.markdown,
    replaceSelection: prompt.replaceSelection,
    citations: res.citations,
  }
}

export { findPrompt }
