// shared/flow/projections/statechart.ts — FlowDoc -> mermaid stateDiagram-v2.
//
// Pure function. Emits `[*] --> start`, one `from --> to : EVENTS [guards]`
// line per edge, and nested composite states for nodes that carry `tabs`.

import type { FlowDoc, FlowEdge, FlowNode } from '../model'

function transitionLabel(e: FlowEdge): string {
  const events = e.events.join(' / ')
  const guards = (e.guards ?? []).map((g) => `[${g}]`).join(' ')
  const parts = [events, guards].filter(Boolean)
  return parts.length ? ` : ${parts.join(' ')}` : ''
}

function nodeId(n: FlowNode): string {
  return n.id
}

export function toStatechart(doc: FlowDoc): string {
  const lines: string[] = ['stateDiagram-v2']
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))

  // entry edge: [*] --> <first start node> (or first node if none flagged)
  const startNode =
    doc.nodes.find((n) => n.role === 'start') ?? doc.nodes[0]
  if (startNode) lines.push(`  [*] --> ${nodeId(startNode)}`)

  // composite states for nodes with tabs
  for (const n of doc.nodes) {
    if (n.tabs && n.tabs.length) {
      lines.push(`  state ${nodeId(n)} {`)
      const first = n.tabs[0]
      lines.push(`    [*] --> ${first}`)
      for (let i = 0; i < n.tabs.length; i++) {
        const cur = n.tabs[i]
        const next = n.tabs[(i + 1) % n.tabs.length]
        lines.push(`    ${cur} --> ${next} : PAGE`)
      }
      lines.push(`  }`)
    }
  }

  // one transition per edge
  for (const e of doc.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    lines.push(`  ${nodeId(from)} --> ${nodeId(to)}${transitionLabel(e)}`)
  }

  return lines.join('\n')
}
