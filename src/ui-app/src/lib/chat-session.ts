// Module-level chat session store.
//
// The chat page used to keep `messages`, `input`, and `pending` in
// component-local `useState`. That meant: when the user navigated
// away while the LLM was still thinking, the `await bridge.llmQuery`
// promise's resolve handler ran on a now-unmounted component, its
// `setState` calls were no-ops, and on return the answer was gone.
// The user's only recourse was to retype the question.
//
// This module hoists the state out of React so the in-flight call
// can complete regardless of whether the chat page is mounted. The
// chat page becomes a *view* of the store via `useSyncExternalStore`:
// it reads messages/pending/input on render, and dispatches via
// `submitChatMessage` / `setChatInput` / `clearChat`. The actual
// LLM round-trip runs here and updates the store directly.
//
// Persistence: sessionStorage mirroring stays here too so messages
// survive a window reload (refresh during dev). The input is mirrored
// only when non-empty so the dropdown doesn't clobber a cleared
// input on remount.

import { bridge } from '../bridge/client'
import type { SearchHitLite } from './citations'

/**
 * Pattern the chat agent uses to reference images it wants the UI to
 * render (see Chat.tsx system prompt). Two capture groups: nodeId and
 * imageId. The optional `![alt](…)` wrapper means either an inline
 * markdown image or a bare URL is accepted.
 */
const IMAGE_REF_PATTERN =
  /(?:!\[[^\]]*\]\()?chunky:\/\/image\/([0-9a-f-]{8,})\/([^\s)\]]+)(?:\))?/gi

interface ParsedImageRef {
  raw: string
  nodeId: string
  imageId: string
}

function parseImageRefs(markdown: string): ParsedImageRef[] {
  const out: ParsedImageRef[] = []
  const seen = new Set<string>()
  const re = new RegExp(IMAGE_REF_PATTERN.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const nodeId = m[1].toLowerCase()
    const imageId = m[2]
    const key = `${nodeId}/${imageId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ raw: m[0], nodeId, imageId })
  }
  return out
}

/**
 * Pull every `pmscratch://image/<nodeId>/<imageId>` reference out of
 * the assistant's markdown, fetch each image in parallel via the
 * in-process MCP service, and return both the cleaned markdown
 * (references stripped — the UI shows the images below the bubble)
 * and the array of fetched images ready for the ChatTurn.
 */
async function resolveLocalImageRefs(
  markdown: string,
): Promise<{
  cleaned: string
  toolImages: Array<{ mimeType: string; dataBase64: string; toolName: string }>
}> {
  const refs = parseImageRefs(markdown)
  if (refs.length === 0) return { cleaned: markdown, toolImages: [] }

  const fetched = await Promise.all(
    refs.map(async (ref) => {
      try {
        // mcp_invokeTool dispatches in-process to the MCP service we
        // ship — the agent never sees these bytes, so they're cheap
        // (single Tauri IPC + a SQLite read).
        const res = await bridge.invokeTool('get_image', {
          nodeId: ref.nodeId,
          imageId: ref.imageId,
          bytes: true,
        })
        const out = (res as { output?: Record<string, unknown> }).output ?? {}
        const data = (out as { data?: unknown }).data
        const mime = (out as { mimeType?: unknown }).mimeType
        if (typeof data !== 'string' || data.length === 0) return null
        return {
          mimeType: typeof mime === 'string' ? mime : 'image/png',
          dataBase64: data,
          toolName: 'mcp__chunky__get_image',
        }
      } catch (err) {
        console.warn('[chat] image fetch failed', ref, err)
        return null
      }
    }),
  )
  const toolImages = fetched.filter(
    (x): x is { mimeType: string; dataBase64: string; toolName: string } =>
      x !== null,
  )

  // Strip the pmscratch:// references from the rendered markdown so
  // the bubble doesn't show raw URLs alongside the rendered images.
  // Each reference, including any `![alt](…)` wrapper, becomes blank
  // text; the surrounding whitespace gets collapsed at render time.
  let cleaned = markdown
  for (const ref of refs) {
    cleaned = cleaned.split(ref.raw).join('')
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return { cleaned, toolImages }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  citations?: Array<{ nodeId: string; used: boolean }>
  resolvedHits?: SearchHitLite[]
  /**
   * Images surfaced by MCP tool calls during this turn (currently
   * just `mcp__pmscratch__get_image` results). Rendered below the
   * assistant's text in the chat bubble. Each `dataBase64` is the
   * raw base64 payload; the UI prepends `data:<mimeType>;base64,`
   * before assigning to an `<img src>`.
   */
  toolImages?: Array<{ mimeType: string; dataBase64: string; toolName: string }>
  error?: string
  durationMs?: number
}

interface PriorTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatSessionState {
  messages: ChatTurn[]
  pending: boolean
  input: string
}

type Listener = (s: ChatSessionState) => void

const STORAGE_KEY = 'chat-messages-v1'
const STORAGE_INPUT_KEY = 'chat-input-v1'

function loadMessagesFromSession(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ChatTurn[]
  } catch {
    /* fall through */
  }
  return []
}

function persistMessages(messages: ChatTurn[]): void {
  try {
    const serialised = JSON.stringify(messages)
    if (serialised.length > 3_000_000) {
      let trimmed = messages
      while (
        JSON.stringify(trimmed).length > 3_000_000 &&
        trimmed.length > 2
      ) {
        trimmed = trimmed.slice(2)
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } else {
      sessionStorage.setItem(STORAGE_KEY, serialised)
    }
  } catch (err) {
    console.warn('[chat-session] could not mirror messages:', err)
  }
}

function persistInput(input: string): void {
  try {
    if (input) sessionStorage.setItem(STORAGE_INPUT_KEY, input)
    else sessionStorage.removeItem(STORAGE_INPUT_KEY)
  } catch {
    /* non-fatal */
  }
}

let state: ChatSessionState = {
  messages: loadMessagesFromSession(),
  pending: false,
  input: sessionStorage.getItem(STORAGE_INPUT_KEY) ?? '',
}

const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l(state)
}

function setState(patch: Partial<ChatSessionState>): void {
  state = { ...state, ...patch }
  notify()
}

export function subscribeChatSession(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getChatSessionSnapshot(): ChatSessionState {
  return state
}

export function setChatInput(input: string): void {
  setState({ input })
  persistInput(input)
}

export function clearChat(): void {
  setState({ messages: [] })
  persistMessages([])
}

const MAX_PRIOR_TURNS = 4

async function resolveCitations(
  citations: Array<{ nodeId: string; used: boolean }>,
): Promise<SearchHitLite[]> {
  const unique = Array.from(new Set(citations.map((c) => c.nodeId.toLowerCase())))
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const node = await bridge.readNode(id)
        const body = node.draft?.bodyMd ?? ''
        const snippet = extractFirstReadableText(body, 200)
        return {
          nodeId: node.id,
          title: node.draft?.title,
          snippet,
          type: node.draft?.type,
        } as SearchHitLite
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SearchHitLite => r !== null)
}

function extractFirstReadableText(raw: string, maxLen: number): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    const out: string[] = []
    const visit = (v: unknown): void => {
      if (out.join(' ').length > maxLen) return
      if (typeof v === 'string') {
        if (!v.startsWith('data:') && v.trim().length > 0) out.push(v)
      } else if (Array.isArray(v)) {
        for (const x of v) visit(x)
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'id' || k === 'url' || k === 'name' || k === 'previewWidth') continue
          visit(x)
        }
      }
    }
    visit(parsed)
    if (out.length > 0) return out.join(' ').slice(0, maxLen)
  } catch {
    /* fall through to plain text */
  }
  return raw.slice(0, maxLen)
}

/**
 * Dispatch a chat turn. Updates the store with the user message,
 * sets `pending: true`, and kicks off the LLM round-trip. The
 * promise resolves regardless of whether the chat view is mounted —
 * the result lands in the store and renders the next time the view
 * subscribes (i.e. on return from another route).
 *
 * Concurrent submits are dropped (no-op while `pending` is true) to
 * match the previous in-component guard.
 */
export async function submitChatMessage(args: {
  question: string
  systemPrompt: string
  buildUserPrompt: (q: string, prior: PriorTurn[]) => string
}): Promise<void> {
  if (state.pending) return
  const q = args.question.trim()
  if (!q) return

  const newMessages: ChatTurn[] = [
    ...state.messages,
    { role: 'user', text: q },
  ]
  setState({ messages: newMessages, pending: true, input: '' })
  persistMessages(newMessages)
  persistInput('')

  const priorTurns: PriorTurn[] = state.messages
    .slice(-MAX_PRIOR_TURNS)
    .filter((m) => !m.error && m.text)
    .map((m) => ({
      role: m.role,
      text:
        m.role === 'assistant'
          ? m.text.replace(/\[[0-9a-f-]{36}\]/gi, '').trim()
          : m.text,
    }))
  const userPrompt = args.buildUserPrompt(q, priorTurns)
  const t0 = performance.now()
  try {
    const res = await bridge.llmQuery({
      use: 'query',
      systemPrompt: args.systemPrompt,
      userPrompt,
      contextHits: [],
    })
    // Resolve agent-emitted image references (pmscratch://image/<nodeId>/<imageId>)
    // by fetching each via the in-process MCP service. Runs in parallel
    // with citation resolution to keep latency to the slower of the two.
    const [resolvedHits, resolvedImages] = await Promise.all([
      resolveCitations(res.citations ?? []),
      resolveLocalImageRefs(res.markdown),
    ])
    const durationMs = Math.round(performance.now() - t0)
    const finalMessages: ChatTurn[] = [
      ...state.messages,
      {
        role: 'assistant',
        text: resolvedImages.cleaned,
        citations: res.citations,
        resolvedHits,
        toolImages: [...(res.toolImages ?? []), ...resolvedImages.toolImages],
        durationMs,
      },
    ]
    setState({ messages: finalMessages, pending: false })
    persistMessages(finalMessages)
  } catch (err) {
    const finalMessages: ChatTurn[] = [
      ...state.messages,
      {
        role: 'assistant',
        text: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - t0),
      },
    ]
    setState({ messages: finalMessages, pending: false })
    persistMessages(finalMessages)
  }
}
