import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { bridge } from '../bridge/client'
import { loadSettings, AppSettings } from '../lib/llm-config'
import { renderWithChips, SearchHitLite } from '../lib/citations'
import type { ChatTurn } from '../lib/chat-session'
import '../styles/Chat.css'

const MAX_PRIOR_TURNS = 4

interface PriorTurn {
  role: 'user' | 'assistant'
  text: string
}

function buildSystemPrompt(projectId: string, projectTitle: string): string {
  return `You are answering questions about assets in the "${projectTitle}" knowledge base (project id: ${projectId}). The user provides a question; you have MCP tools to query the graph. Make reasonable assumptions and answer — do NOT ask clarifying questions back to the user.

Available tools (always prefer these over guessing):
- search_nodes(query, types?, limit?): full-text search over the graph. Returns ranked candidates with id, title, snippet, score. Best for keyword lookups.
- list_assets_in_project(projectId, limit?): return every asset linked to this project. Each entry includes id, type, title, summary, and keyPoints. Use projectId="${projectId}" for this project.
- get_node(id): read the full body of a single node. Use after a search hit when the snippet is thin.
- get_nodes(ids[]): BULK read up to 50 nodes in a single call. ALWAYS prefer this over chaining get_node when the user wants details on multiple results.
- get_neighbors(id, depth?, limit?): expand related nodes.
- list_node_images(nodeId): list every image attached to a node — returns id, caption, mimeType for each.

Showing images in your answer:
- After calling list_node_images, reference each image you want shown by writing a line on its own: \`![<short caption>](chunky://image/<nodeId>/<imageId>)\`. The chat UI renders the picture inline.
- DO NOT call get_image to fetch image bytes.

Workflow:
1. For "list all assets" → list_assets_in_project. For specific topical query → search_nodes. Read bodies via get_nodes only when keyPoints don't cover what the user asked.
2. Try alternate phrasings if the first search returns nothing useful.
3. Compose a Markdown answer. Cite each claim inline as [<node-id>] using the full UUID.

Rules:
- Attempt the task. Do not ask clarifying questions.
- Only state facts supported by tool results.
- Do NOT invent node ids. Cite only ids returned by the tools you called.
- No preamble, no apology. Just the cited answer.`
}

function buildUserPrompt(query: string, priorTurns: PriorTurn[]): string {
  const conversation =
    priorTurns.length > 0
      ? `Prior conversation:\n${priorTurns
          .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
          .join('\n\n')}\n\n`
      : ''
  return `${conversation}Current question:\n${query}\n\nUse the MCP tools to find relevant nodes, then answer with inline [<node-id>] citations.`
}

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
        console.warn('[project-chat] image fetch failed', ref, err)
        return null
      }
    }),
  )
  const toolImages = fetched.filter(
    (x): x is { mimeType: string; dataBase64: string; toolName: string } => x !== null,
  )

  let cleaned = markdown
  for (const ref of refs) {
    cleaned = cleaned.split(ref.raw).join('')
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return { cleaned, toolImages }
}

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
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (k === 'id' || k === 'url' || k === 'name' || k === 'previewWidth') continue
          visit(x)
        }
      }
    }
    visit(parsed)
    if (out.length > 0) return out.join(' ').slice(0, maxLen)
  } catch {
    /* fall through */
  }
  return raw.slice(0, maxLen)
}

export default function ProjectChat() {
  const { projectId } = useParams<{ projectId: string }>()
  const [projectTitle, setProjectTitle] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [messages, setMessages] = useState<ChatTurn[]>(() => loadMessages(projectId ?? ''))
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  useEffect(() => {
    if (!projectId) return
    bridge.readNode(projectId)
      .then((node) => setProjectTitle(node.draft?.title ?? projectId))
      .catch(() => setProjectTitle(projectId))
  }, [projectId])

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages.length, pending])

  const handleClear = () => {
    if (messages.length === 0) return
    if (!window.confirm('Clear the conversation? This cannot be undone.')) return
    setMessages([])
    persistMessages(projectId ?? '', [])
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (pending || !input.trim() || !projectId) return

    const q = input.trim()
    const newMessages: ChatTurn[] = [...messages, { role: 'user', text: q }]
    setMessages(newMessages)
    setInput('')
    setPending(true)
    persistMessages(projectId, newMessages)

    const priorTurns: PriorTurn[] = messages
      .slice(-MAX_PRIOR_TURNS)
      .filter((m) => !m.error && m.text)
      .map((m) => ({
        role: m.role,
        text:
          m.role === 'assistant'
            ? m.text.replace(/\[[0-9a-f-]{36}\]/gi, '').trim()
            : m.text,
      }))

    const t0 = performance.now()
    try {
      const res = await bridge.llmQuery({
        use: 'query',
        systemPrompt: buildSystemPrompt(projectId, projectTitle),
        userPrompt: buildUserPrompt(q, priorTurns),
        contextHits: [],
      })
      const [resolvedHits, resolvedImages] = await Promise.all([
        resolveCitations(res.citations ?? []),
        resolveLocalImageRefs(res.markdown),
      ])
      const durationMs = Math.round(performance.now() - t0)
      const finalMessages: ChatTurn[] = [
        ...newMessages,
        {
          role: 'assistant',
          text: resolvedImages.cleaned,
          citations: res.citations,
          resolvedHits,
          toolImages: [...(res.toolImages ?? []), ...resolvedImages.toolImages],
          durationMs,
        },
      ]
      setMessages(finalMessages)
      persistMessages(projectId, finalMessages)
    } catch (err) {
      const finalMessages: ChatTurn[] = [
        ...newMessages,
        {
          role: 'assistant',
          text: '',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Math.round(performance.now() - t0),
        },
      ]
      setMessages(finalMessages)
      persistMessages(projectId, finalMessages)
    } finally {
      setPending(false)
    }
  }

  const queryConfig = settings?.llm.query
  const supplierLabel = useMemo(() => {
    if (!queryConfig) return ''
    const transport = queryConfig.transport ?? 'http'
    return `${queryConfig.supplier} / ${queryConfig.model} (${transport})`
  }, [queryConfig])

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div>
          <div className="breadcrumb">
            <Link to="/projects">Projects</Link>
            <span> / </span>
            <Link to={`/projects/${projectId}`}>{projectTitle}</Link>
            <span> / </span>
            <span>Chat</span>
          </div>
          <p>
            Ask questions about the assets in this project. The model uses MCP
            tools to search and read nodes, then cites sources inline.
          </p>
        </div>
        <div className="chat-meta">
          <span className="chat-via">via {supplierLabel || '—'}</span>
          <div className="chat-meta-actions">
            <button
              type="button"
              className="btn btn-link"
              onClick={handleClear}
              disabled={messages.length === 0}
            >
              Clear chat
            </button>
            <Link to="/settings" className="btn btn-link">
              Settings
            </Link>
          </div>
        </div>
      </header>

      <div ref={transcriptRef} className="chat-transcript">
        {messages.length === 0 && (
          <div className="chat-placeholder">
            Ask anything about the assets in <strong>{projectTitle || 'this project'}</strong>.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatTurnRow key={i} turn={m} />
        ))}
        {pending && (
          <div className="chat-turn assistant">
            <div className="chat-bubble">
              <span className="chat-spinner" /> Searching the project and composing an answer…
            </div>
          </div>
        )}
      </div>

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder="Ask about this project… (Enter to send, Shift+Enter for newline)"
          disabled={pending}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}

function ChatTurnRow({ turn }: { turn: ChatTurn }) {
  const [copied, setCopied] = useState(false)
  const hitsById = useMemo(() => {
    const map = new Map<string, SearchHitLite>()
    for (const h of turn.resolvedHits ?? []) {
      map.set(h.nodeId.toLowerCase(), {
        nodeId: h.nodeId,
        title: h.title,
        snippet: h.snippet,
        score: h.score,
        type: h.type,
      })
    }
    return map
  }, [turn.resolvedHits])

  if (turn.role === 'user') {
    return (
      <div className="chat-turn user">
        <div className="chat-bubble">{turn.text}</div>
      </div>
    )
  }

  const cited = turn.citations?.filter((c) => c.used).length ?? 0

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = turn.text
        ta.setAttribute('readonly', '')
        ta.style.position = 'absolute'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {
        // ignore
      }
    }
  }

  return (
    <div className="chat-turn assistant">
      <div className={`chat-bubble ${turn.error ? 'chat-error' : ''}`}>
        {!turn.error && turn.text && (
          <button
            type="button"
            className="chat-copy-btn"
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy response to clipboard'}
            aria-label={copied ? 'Copied' : 'Copy response to clipboard'}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
          </button>
        )}
        {turn.error ? (
          <>
            <strong>LLM call failed:</strong> {turn.error}
          </>
        ) : (
          <div className="chat-markdown">
            {renderWithChips(turn.text, hitsById)}
          </div>
        )}
        {!turn.error && turn.toolImages && turn.toolImages.length > 0 && (
          <div className="chat-tool-images" aria-label="Images fetched during this turn">
            {turn.toolImages.map((img, idx) => (
              <figure key={idx} className="chat-tool-image">
                <img
                  src={`data:${img.mimeType};base64,${img.dataBase64}`}
                  alt={`Tool image ${idx + 1}`}
                  loading="lazy"
                />
              </figure>
            ))}
          </div>
        )}
        {turn.durationMs !== undefined && !turn.error && (
          <div className="chat-meta-line">
            {turn.durationMs} ms
            {cited > 0 && <> · {cited} cited</>}
            {turn.toolImages && turn.toolImages.length > 0 && (
              <> · {turn.toolImages.length} image{turn.toolImages.length === 1 ? '' : 's'}</>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function storageKey(projectId: string): string {
  return `chat-project-${projectId}-v1`
}

function loadMessages(projectId: string): ChatTurn[] {
  if (!projectId) return []
  try {
    const raw = sessionStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ChatTurn[]
  } catch {
    /* fall through */
  }
  return []
}

function persistMessages(projectId: string, messages: ChatTurn[]): void {
  if (!projectId) return
  try {
    const serialised = JSON.stringify(messages)
    if (serialised.length > 3_000_000) {
      let trimmed = messages
      while (JSON.stringify(trimmed).length > 3_000_000 && trimmed.length > 2) {
        trimmed = trimmed.slice(2)
      }
      sessionStorage.setItem(storageKey(projectId), JSON.stringify(trimmed))
    } else {
      sessionStorage.setItem(storageKey(projectId), serialised)
    }
  } catch {
    /* non-fatal */
  }
}

function ClipboardIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
