// shared/flow/edit.ts — pure, immutable mutation helpers over a FlowDoc.
//
// Framework-free (NO React / Tauri). Every function returns a NEW FlowDoc and
// never mutates its input, so callers can hold the result in state and rely on
// reference equality to detect change. New ids use crypto.randomUUID() with a
// 'n_' prefix for nodes and 'e_' for edges; ids of untouched items are stable.

import type {
  EdgeKind,
  FlowDoc,
  FlowEdge,
  FlowNode,
  NodeRole,
} from './model'
import { nodeSize } from './style'

// Human-readable default label per role for freshly-added nodes.
const DEFAULT_LABEL: Record<NodeRole, string> = {
  start: 'Start',
  screen: 'New screen',
  subdialog: 'New dialog',
  success: 'Success',
  cancel: 'Cancel',
  error: 'Error',
  transient: 'Transient',
}

function newNodeId(): string {
  return `n_${crypto.randomUUID()}`
}

function newEdgeId(): string {
  return `e_${crypto.randomUUID()}`
}

/** A blank document with a single 'start' node and no edges. */
export function makeEmptyDoc(title = 'Untitled flow'): FlowDoc {
  const today = new Date().toISOString().slice(0, 10)
  const start: FlowNode = {
    id: newNodeId(),
    label: DEFAULT_LABEL.start,
    role: 'start',
    pos: { x: 220, y: 40 },
  }
  return {
    id: `doc__${crypto.randomUUID()}`,
    title,
    revision: [{ version: '0.1', date: today, author: '' }],
    overview: '',
    nodes: [start],
    edges: [],
  }
}

/** Add a new node of `role` at `pos`; merges `partial` on top of the defaults.
 * Returns the new doc and the id of the created node. */
export function addNode(
  doc: FlowDoc,
  role: NodeRole,
  pos: { x: number; y: number },
  partial?: Partial<FlowNode>,
): { doc: FlowDoc; id: string } {
  const id = partial?.id ?? newNodeId()
  const node: FlowNode = {
    label: DEFAULT_LABEL[role],
    size: { ...nodeSize(role) },
    ...partial,
    id,
    role,
    pos: partial?.pos ? { ...partial.pos } : { x: pos.x, y: pos.y },
  }
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, id }
}

/** Shallow-merge `patch` into the node with `id`. Other nodes keep identity. */
export function updateNode(
  doc: FlowDoc,
  id: string,
  patch: Partial<FlowNode>,
): FlowDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch, id: n.id } : n)),
  }
}

/** Convenience: move a node to an absolute position. */
export function moveNode(
  doc: FlowDoc,
  id: string,
  pos: { x: number; y: number },
): FlowDoc {
  return updateNode(doc, id, { pos: { x: pos.x, y: pos.y } })
}

/** Remove a node and cascade-remove every edge touching it (from OR to). */
export function removeNode(doc: FlowDoc, id: string): FlowDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

/** Add an edge from->to. kind defaults to 'self' when from===to else 'forward';
 * events default to [], label to ''. Returns the new doc and the edge id. */
export function addEdge(
  doc: FlowDoc,
  from: string,
  to: string,
  partial?: Partial<FlowEdge>,
): { doc: FlowDoc; id: string } {
  const id = partial?.id ?? newEdgeId()
  const kind: EdgeKind = partial?.kind ?? (from === to ? 'self' : 'forward')
  const edge: FlowEdge = {
    events: [],
    label: '',
    ...partial,
    id,
    from,
    to,
    kind,
  }
  return { doc: { ...doc, edges: [...doc.edges, edge] }, id }
}

/** Shallow-merge `patch` into the edge with `id`. kind is left untouched unless
 * the caller explicitly supplies it in the patch. */
export function updateEdge(
  doc: FlowDoc,
  id: string,
  patch: Partial<FlowEdge>,
): FlowDoc {
  return {
    ...doc,
    edges: doc.edges.map((e) => (e.id === id ? { ...e, ...patch, id: e.id } : e)),
  }
}

/** Set the manual label offset for the edge with `id` (immutable). The offset
 * is a delta in SVG units from the auto-computed label anchor. */
export function moveEdgeLabel(
  doc: FlowDoc,
  id: string,
  offset: { dx: number; dy: number },
): FlowDoc {
  return updateEdge(doc, id, { labelOffset: { dx: offset.dx, dy: offset.dy } })
}

/** Remove the edge with `id`. */
export function removeEdge(doc: FlowDoc, id: string): FlowDoc {
  return { ...doc, edges: doc.edges.filter((e) => e.id !== id) }
}
