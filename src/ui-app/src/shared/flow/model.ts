// shared/flow — the single source of truth for all three projections.
// Framework-free: NO React / Tauri imports. Pure TypeScript, unit-testable.
//
// These are the §3 types from `docs/Flow Studio - Design.md`, implemented
// verbatim. The SVG / statechart / Gherkin / Markdown projections are all
// pure functions of a `FlowDoc`.

export type NodeRole =
  | 'start' //        entry pseudo-state (circle, grey)
  | 'screen' //       primary operator screen (rounded box, blue)
  | 'subdialog' //    dialog/sub-flow opened and returned from (lighter blue)
  | 'success' //      terminal success (green)
  | 'cancel' //       terminal close/cancel (grey)
  | 'error' //        error/invalid state (orange)
  | 'transient' //    framework state, foldable into start/done (not drawn)

export type EdgeKind = 'forward' | 'back' | 'self' // solid / dashed / self-loop

export interface FlowField {
  // feeds Input-data / Computed-outputs tables
  name: string
  io: 'input' | 'computed'
  type?: string //        e.g. 'numeric'
  required?: boolean
  notes?: string //       ranges/units — may carry TODO(verify)
  verify?: boolean //     render the notes with TODO(verify)
}

export interface FlowNode {
  id: string
  label: string //        canonical screen name (used everywhere)
  subtitle?: string //    e.g. controller name / "Job / new / last used"
  role: NodeRole
  tabs?: string[] //      view-tabs shown as an annotation, not boxes
  fields?: FlowField[]
  screenImage?: string // optional reconstructed-screen asset ref
  pos: { x: number; y: number } //   author-controlled layout
  size?: { w: number; h: number } // defaults per role
}

export interface FlowEdge {
  id: string
  from: string //         node id
  to: string //           node id (== from for self)
  events: string[] //     UPPER_SNAKE machine events
  guards?: string[] //    [condition] guards
  kind: EdgeKind
  label: string //        plain-language label for the diagram
  message?: { text: string; verify?: boolean } // pop-up text -> Gherkin docstring
  examples?: { headers: string[]; rows: string[][] } // -> Scenario Outline
  scenarioOverride?: string // author-edited Gherkin, persisted on the edge
  route?: Array<{ x: number; y: number }> // optional explicit waypoints
  // Manual nudge for the edge label, in SVG units, relative to the auto-computed
  // anchor (midpoint of the longest routed segment, or the self-loop point). The
  // label therefore tracks the edge as nodes move but keeps the author's offset.
  labelOffset?: { dx: number; dy: number }
}

export interface FlowDoc {
  id: string //           <dir>__<flow>
  title: string
  source?: { machine: string; md: string } // provenance links into flows/
  revision: { version: string; date: string; author: string }[]
  overview: string //     Brief Overview prose
  nodes: FlowNode[]
  edges: FlowEdge[]
  legendNotes?: string[] // e.g. "blocked SET stays on screen"
}
