import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { loadSettings, AppSettings } from '../lib/llm-config'
// citations.tsx exports the JSX renderer + the regex parser.
import { renderWithChips, SearchHitLite } from '../lib/citations'
import {
  type ChatTurn,
  clearChat,
  getChatSessionSnapshot,
  setChatInput,
  submitChatMessage,
  subscribeChatSession,
} from '../lib/chat-session'
import '../styles/Chat.css'

// Tool-use system prompt: the chat runs inside Claude Code with the
// local MCP server wired in via `--mcp-config`. The model is expected
// to call these tools itself rather than rely on a pre-fetched
// candidate list.
const SYSTEM_PROMPT = `You are answering questions about a local knowledge graph. The user provides a question; you have MCP tools to query the graph. Make reasonable assumptions and answer — do NOT ask clarifying questions back to the user. If a question is ambiguous, pick the most plausible interpretation and proceed; the user can refine in a follow-up turn.

Available tools (always prefer these over guessing):
- search_nodes(query, types?, limit?): full-text search over the graph. Returns ranked candidates with id, title, snippet, score. Best for keyword lookups.
- get_node(id): read the full body of a single node. Use after a search hit when the snippet is thin.
- get_nodes(ids[]): BULK read up to 50 nodes in a single call. ALWAYS prefer this over chaining get_node when the user wants details on multiple results — after list_assets_in_project, call get_nodes with the ids you want to detail rather than calling get_node repeatedly.
- get_neighbors(id, depth?, limit?): expand related nodes (edges are sparse in v1; may return empty).
- list_assets_in_project(projectId, limit?): return every asset linked to a project. Each entry includes id, type, title, **summary** (1-2 sentence pre-extracted summary), and **keyPoints** (array of structured data points). For "list and break down" queries, keyPoints usually has everything you need — read bodies via get_nodes only as a fallback.
- list_nodes_by_type(type?, projectId?, limit?): return nodes filtered by type (pdf, docx, image, code, note, url) across the whole graph or within a project.
- list_node_images(nodeId): list every image attached to a node — returns id, caption, mimeType for each. Use this whenever the user asks to see screenshots / pictures / images / diagrams, OR whenever a screenshot would obviously help.

Showing images in your answer:
- After calling list_node_images, reference each image you want shown by writing a line on its own that looks like: \`![<short caption>](chunky://image/<nodeId>/<imageId>)\`. The chat UI fetches the bytes locally (cheap, parallel) and renders the picture inline at that exact spot in your answer. Up to ~6 image references per turn is fine.
- DO NOT call get_image to fetch image bytes — that path is intentionally disabled because routing screenshot base64 through this tool channel adds many minutes per turn. Just emit the \`chunky://image/...\` markdown reference and let the renderer resolve it.
- Use the imageId verbatim from list_node_images (it's the string id in the returned array, NOT an index). Both the nodeId and the imageId are required in the URL.

Workflow:
1. Pick the most efficient tool for the user's intent. "List all assets in project X" → list_assets_in_project. Specific topical query → search_nodes. Read bodies via get_nodes (bulk) only when keyPoints don't cover what the user asked for. Never chain get_node serially when get_nodes covers the same set.
2. Try alternate phrasings if the first search returns nothing useful (e.g. "hardware" → "device", "sensor"; "function" → "feature", "capability").
3. Compose a Markdown answer in the format the user asked for — table, list, prose, etc. Cite each claim inline as [<node-id>] using the full UUID. Multiple ids per claim are fine: "Foo is X. [a-b-c-d-e][f-g-h-i-j]".

Rules:
- Attempt the task. Do not ask clarifying questions; do not list interpretations and ask which one to pursue. Pick one and answer.
- If the user asks for a table, return a Markdown table.
- Only state facts supported by tool results. If searches yield nothing relevant, say "I cannot find that in the indexed knowledge." (Do this only after at least 2 distinct search attempts.)
- Do NOT invent node ids. Cite only ids returned by the tools you called.
- No preamble, no apology, no meta-commentary about tool calls. Just the cited answer in the format the user asked for.`

const MAX_PRIOR_TURNS = 4 // user+assistant pairs to include as conversation context

interface PriorTurn {
  role: 'user' | 'assistant'
  text: string
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

export const Chat: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // Read messages / input / pending from the module-level chat
  // session store. The store survives route changes so an in-flight
  // LLM call that the user navigated away from will land its answer
  // in `messages` regardless — the chat view picks it up the next
  // time it mounts (or live, via this subscription, if still
  // mounted).
  const session = useSyncExternalStore(
    subscribeChatSession,
    getChatSessionSnapshot,
    getChatSessionSnapshot,
  )
  const messages = session.messages
  const input = session.input
  const pending = session.pending
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  const handleClear = () => {
    if (messages.length === 0) return
    if (!window.confirm('Clear the conversation? This cannot be undone.')) return
    clearChat()
  }

  // Scroll to bottom on new turn or pending toggle.
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages.length, pending])

  const queryConfig = settings?.llm.query

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (pending) return
    void submitChatMessage({
      question: input,
      systemPrompt: SYSTEM_PROMPT,
      buildUserPrompt,
    })
  }

  const supplierLabel = useMemo(() => {
    if (!queryConfig) return ''
    const label = queryConfig.supplier
    const transport = queryConfig.transport ?? 'http'
    return `${label} / ${queryConfig.model} (${transport})`
  }, [queryConfig])

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div>
          <h1>Chat</h1>
          <p>
            Free-text questions answered from the indexed knowledge graph.
            The model uses MCP tools to search and read nodes, then cites
            sources inline. Click any citation chip to open the source.
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
              title="Clear the in-window conversation"
            >
              Clear chat
            </button>
            <Link to="/settings/llm" className="btn btn-link">
              Settings
            </Link>
          </div>
        </div>
      </header>

      <div ref={transcriptRef} className="chat-transcript">
        {messages.length === 0 && (
          <div className="chat-placeholder">
            Ask anything about the indexed graph. Try{' '}
            <em>"what is a control job?"</em> or{' '}
            <em>"tell me about the TS20"</em>.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatTurnRow key={i} turn={m} />
        ))}
        {pending && (
          <div className="chat-turn assistant">
            <div className="chat-bubble">
              <span className="chat-spinner" /> Searching the graph and
              composing an answer…
            </div>
          </div>
        )}
      </div>

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Ask the graph… (Enter to send, Shift+Enter for newline)"
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
    } catch (err) {
      // Tauri webview / older browsers may not have async clipboard.
      // Fall back to a hidden textarea + execCommand.
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
        console.warn('clipboard write failed:', err)
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

export default Chat
