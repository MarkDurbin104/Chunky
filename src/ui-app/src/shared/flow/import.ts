// shared/flow/import.ts — parse a mermaid stateDiagram-v2 block into a FlowDoc.
//
// Nodes come from state ids; edges from transition lines (those containing
// `-->`). A `: label` is split into events / guards; dashed `back` is inferred
// from ESC/back/cancel events. Roles are inferred heuristically. pos is left at
// (0,0) for layout.ts to assign.

import type { EdgeKind, FlowDoc, FlowEdge, FlowNode, NodeRole } from './model'

const BACK_RE = /\b(ESC|BACK|CANCEL|CLOSE|VETO|ABORT)\b/i
const SUCCESS_RE = /(success|complete|done|confirmed|stored|saved|ok\b|result)/i
const CANCEL_RE = /(cancel|closing|closed|unloaded|garbage|abort|exit|quit)/i
const ERROR_RE = /(error|invalid|fail|reject|missing|identical|warn)/i

function inferRole(id: string, isStart: boolean): NodeRole {
  if (isStart) return 'start'
  const name = id.toLowerCase()
  if (SUCCESS_RE.test(name) && !CANCEL_RE.test(name)) return 'success'
  if (CANCEL_RE.test(name)) return 'cancel'
  if (ERROR_RE.test(name)) return 'error'
  return 'screen'
}

function humanize(id: string): string {
  // split camelCase / PascalCase / snake into words; Title Case
  const spaced = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

interface RawTransition {
  from: string
  to: string
  label: string
}

/** Split a transition line into from / to / label. Handles both `:` and the
 * mermaid-permitted spacing around `-->`. Returns null for non-transitions. */
function parseTransitionLine(line: string): RawTransition | null {
  if (!line.includes('-->')) return null
  // strip leading state-block tokens; keep `[*]` literal for detection
  const m = /^(.+?)-->\s*([^:]+?)\s*(?::\s*(.*))?$/.exec(line)
  if (!m) return null
  const from = m[1].trim()
  const to = m[2].trim()
  const label = (m[3] ?? '').trim()
  if (!from || !to) return null
  return { from, to, label }
}

/** Parse a `EVENTS [guard] / action` mermaid label into events + guards. */
function parseLabel(label: string): { events: string[]; guards: string[] } {
  if (!label) return { events: [], guards: [] }
  const guards: string[] = []
  // pull out [...] guard groups
  let rest = label.replace(/\[([^\]]+)\]/g, (_full, g: string) => {
    guards.push(g.trim())
    return ''
  })
  // drop a trailing "/ action" effect — events are the left of the first slash
  // group, but mermaid also uses `A / B` to mean alternative events. We treat
  // UPPER_SNAKE tokens as events and lowercase tokens as prose/effects.
  rest = rest.trim()
  const tokens = rest
    .split(/\s*\/\s*|\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
  const events: string[] = []
  for (const t of tokens) {
    // an event token: starts with a capital or is UPPER_SNAKE / F-keys
    const head = t.split(/\s+/)[0]
    if (/^[A-Z][A-Z0-9_]*$/.test(head) || /^F\d+$/.test(head)) {
      events.push(t)
    } else if (events.length === 0) {
      // leading prose with no clear event — keep as a single event-ish token
      events.push(t)
    }
    // trailing lowercase prose (effects/actions) is dropped from events
  }
  return { events, guards }
}

function inferKind(from: string, to: string, events: string[]): EdgeKind {
  if (from === to) return 'self'
  const joined = events.join(' ')
  if (BACK_RE.test(joined)) return 'back'
  return 'forward'
}

/** Strip a mermaid block down to its content lines (drops fences, notes,
 * composite-state wrappers but keeps the transitions they contain). */
function contentLines(text: string): string[] {
  const out: string[] = []
  let inNote = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('```')) continue
    if (line === 'stateDiagram-v2' || line === 'stateDiagram') continue
    if (/^note\b/.test(line)) {
      inNote = true
      continue
    }
    if (inNote) {
      if (/^end note$/.test(line)) inNote = false
      continue
    }
    if (/^state\b/.test(line)) continue // composite wrapper open
    if (line === '}') continue // composite wrapper close
    out.push(line)
  }
  return out
}

export function importStatechart(text: string): FlowDoc {
  const lines = contentLines(text)
  const nodeIds: string[] = []
  const seen = new Set<string>()
  const startTargets = new Set<string>()
  const edges: FlowEdge[] = []
  let edgeSeq = 0

  const register = (id: string) => {
    if (id === '[*]') return
    if (!seen.has(id)) {
      seen.add(id)
      nodeIds.push(id)
    }
  }

  for (const line of lines) {
    const t = parseTransitionLine(line)
    if (!t) continue
    const fromStart = t.from === '[*]'
    const toEnd = t.to === '[*]'
    register(t.from)
    register(t.to)
    if (fromStart) {
      startTargets.add(t.to)
      continue // [*] --> X is the entry; the pseudo-state is synthesised below
    }
    if (toEnd) continue // X --> [*] is a terminal marker, not a model edge

    const { events, guards } = parseLabel(t.label)
    const kind = inferKind(t.from, t.to, events)
    edgeSeq++
    edges.push({
      id: `e${edgeSeq}`,
      from: t.from,
      to: t.to,
      events,
      guards: guards.length ? guards : undefined,
      kind,
      label: events.length ? events.join(' / ') : humanize(t.to),
    })
  }

  // Synthesise a single start pseudo-node and wire it to the entry targets.
  const startId = '__start__'
  const nodes: FlowNode[] = [
    {
      id: startId,
      label: 'Start',
      role: 'start',
      pos: { x: 0, y: 0 },
    },
  ]
  for (const id of nodeIds) {
    nodes.push({
      id,
      label: humanize(id),
      role: inferRole(id, false),
      pos: { x: 0, y: 0 },
    })
  }
  for (const target of startTargets) {
    edgeSeq++
    edges.unshift({
      id: `e${edgeSeq}`,
      from: startId,
      to: target,
      events: ['START'],
      kind: 'forward',
      label: 'start',
    })
  }

  return {
    id: 'imported__flow',
    title: 'Imported Flow',
    revision: [],
    overview: 'Imported from a mermaid stateDiagram-v2 block.',
    nodes,
    edges,
  }
}
