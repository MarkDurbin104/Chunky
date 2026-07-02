// shared/flow/projections/gherkin.ts — FlowDoc -> Acceptance Criteria (Gherkin).
//
// Pure function. Scenarios are grouped by source screen, exactly one per edge:
//   forward -> navigates to target
//   self    -> remains on the source
//   back    -> returns to the target
// edge.message -> a """ docstring; edge.examples -> a Scenario Outline +
// Examples; edge.scenarioOverride, if present, replaces the generated scenario.

import type { FlowDoc, FlowEdge, FlowNode } from '../model'

function eventPhrase(e: FlowEdge): string {
  const ev = e.events.length ? e.events.join(' / ') : e.label || 'the action'
  const guards = (e.guards ?? []).map((g) => `[${g}]`).join(' ')
  return guards ? `${ev} ${guards}` : ev
}

function docstring(text: string): string[] {
  const lines = ['"""']
  for (const l of text.split('\n')) lines.push(l)
  lines.push('"""')
  return lines
}

function examplesBlock(examples: NonNullable<FlowEdge['examples']>): string[] {
  const out: string[] = ['**Examples**']
  out.push(`| ${examples.headers.join(' | ')} |`)
  for (const row of examples.rows) {
    out.push(`| ${row.join(' | ')} |`)
  }
  return out
}

function thenClause(e: FlowEdge, fromLabel: string, toLabel: string): string {
  if (e.kind === 'self') return `**Then** remains on "${fromLabel}"`
  if (e.kind === 'back') return `**Then** returns to "${toLabel}"`
  return `**Then** navigates to "${toLabel}"`
}

function scenarioFor(e: FlowEdge, fromNode: FlowNode, toNode: FlowNode): string[] {
  if (e.scenarioOverride && e.scenarioOverride.trim()) {
    return e.scenarioOverride.replace(/\n+$/, '').split('\n')
  }
  const isOutline = !!e.examples && e.examples.rows.length > 0
  const kw = isOutline ? '**Scenario Outline**' : '**Scenario**'
  const title = e.label || eventPhrase(e)
  const out: string[] = [`${kw}: ${title}`]
  out.push(`**Given** on "${fromNode.label}"`)
  out.push(`**When** ${eventPhrase(e)}`)
  out.push(thenClause(e, fromNode.label, toNode.label))
  if (e.message && e.message.text) {
    const text = e.message.verify
      ? `${e.message.text}\nTODO(verify)`
      : e.message.text
    out.push(...docstring(text))
  }
  if (isOutline) {
    out.push(...examplesBlock(e.examples!))
  }
  return out
}

export function toGherkin(doc: FlowDoc): string {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const lines: string[] = [`### Feature: ${doc.title}`, '']

  const startNode = doc.nodes.find((n) => n.role === 'start')
  const bgGuards = doc.edges
    .filter((e) => startNode && e.from === startNode.id)
    .flatMap((e) => e.guards ?? [])
  lines.push('**Background:**')
  if (bgGuards.length) {
    lines.push(`**Given** ${bgGuards.map((g) => `[${g}]`).join(' and ')}`)
  } else {
    lines.push('**Given** the flow is launched')
  }
  lines.push('')

  // group edges by source screen, preserving node order
  let groupNum = 0
  for (const node of doc.nodes) {
    if (node.role === 'start' || node.role === 'transient') continue
    const outgoing = doc.edges.filter((e) => e.from === node.id)
    if (!outgoing.length) continue
    groupNum++
    lines.push(`#### ${groupNum}. ${node.label}`)
    lines.push('')
    for (const e of outgoing) {
      const fromNode = byId.get(e.from)!
      const toNode = byId.get(e.to) ?? fromNode
      lines.push(...scenarioFor(e, fromNode, toNode))
      lines.push('')
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}
