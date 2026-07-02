// shell-bridge.v1 type definitions

export type UUID = string
export type ISO8601Utc = string
export type Sha256Hex = string
export type SemVer = string
export type PathString = string
export type NodeId = string
export type EdgePredicate = string

export type InterfaceMeta = {
  interfaceId: string
  version: SemVer
  requestId: UUID
  traceId: UUID
  timestampUtc: ISO8601Utc
  caller: string
  actorId?: string
}

export type RequestEnvelope<TPayload> = {
  meta: InterfaceMeta
  payload: TPayload
}

export type ErrorEnvelope = {
  code: string
  message: string
  details?: Record<string, unknown>
  retryable: boolean
}

export type ResponseEnvelope<TPayload> = {
  meta: {
    requestId: UUID
    traceId: UUID
    durationMs: number
  }
  ok: boolean
  payload: TPayload | null
  error: ErrorEnvelope | null
}

// Domain types

/**
 * The on-disk record shape returned by `workspace_readNode`. The bridge
 * handler returns the parsed JSON file verbatim — do NOT assume top-level
 * `type` / `title` / `bodyMd` / `jsonld`; they live under `draft`.
 *
 * `kind` and `policyDecisionId` are present after a record has been
 * promoted to canonical (`kb/<type>s/<id>.json`); absent in `drafts/`.
 */
export type GraphNode = {
  id: NodeId
  draft: {
    type: string
    title?: string
    bodyMd?: string
    jsonld?: string
  }
  updatedAtUtc: ISO8601Utc
  actor?: string
  kind?: 'canonical'
  policyDecisionId?: string
  sourcePath?: PathString
}

export type GraphEdge = {
  srcId: NodeId
  predicate: EdgePredicate
  dstId: NodeId
  weight?: number
  evidenceId?: string
}

export type EvidenceRef = {
  id: string
  sourceId: string
  sourceType: "code" | "pdf" | "office" | "transcript" | "ticket" | "web"
  contentHash: Sha256Hex
}

// App Health and Startup
export type StartupState = {
  state: "ready" | "initializing" | "repairing" | "failed"
  mode: "fresh" | "upgrade" | "repair" | "none"
  assetPackVersion: SemVer
  appVersion: SemVer
  lastError?: string | null
}

export type AppHealth = {
  status: "ok" | "degraded" | "failed"
  startup: StartupState
  index: {
    ready: boolean
    nodeCount: number
    edgeCount: number
    lastUpdatedUtc?: ISO8601Utc
  }
  ingestion?: {
    activeRuns: number
    failedRuns24h: number
  }
}

// Workspace types — closed set, source of truth for the type vocabulary.
// Authoring Phase: B-017 split the legacy "requirement" into "artifact_collection"
// (raw material) and "requirement_document" (authored prose), with "epic" promoted
// to a first-class output and "product_increment" / "reference" added as scopes.
export type WorkspaceType =
  | "project"
  | "collection"
  | "pdf"
  | "docx"
  | "slides"
  | "spreadsheet"
  | "email"
  | "image"
  | "code"
  | "note"
  | "url"
  | "product_increment"
  | "artifact_collection"
  | "requirement_document"
  | "epic"
  | "flow"
  | "reference"
  | "component"
  | "interface"
  | "constraint"
  | "decision"
  | "risk"
  | "testcase"
  | "annotation"
  | "evidence"
  | "draft"

export type WorkspaceListRequest = {
  type?: WorkspaceType
  cursor?: string
  limit?: number
  /** Optional Program Increment scope. When present, only items whose source
   *  JSON carries `draft.piId === piId` are returned. Items without a piId on
   *  disk are excluded from a piId-filtered listing. (A-017) */
  piId?: string
  /** Optional draft|canonical kind filter. */
  kind?: "draft" | "canonical"
}

export type WorkspaceListItem = {
  id: string
  path: PathString
  type: WorkspaceType
  updatedAtUtc: ISO8601Utc
  /** Present iff the source JSON carried a `draft.piId` field. (A-017) */
  piId?: string
  /** Whether the entry came from `<appData>/drafts/` or `<appData>/kb/<type>s/`. */
  kind?: "draft" | "canonical"
  /** Draft title at the time of listing. */
  title?: string
  /** Raw JSON-LD string from the node's draft, if the backend includes it. */
  jsonld?: string
}

export type WorkspaceListResponse = {
  items: WorkspaceListItem[]
  nextCursor?: string
}

export type DraftNodeUpsert = {
  id?: string
  type: string
  title: string
  bodyMd?: string
  jsonld?: string
}

// Retrieval types — shapes match the Rust `retrieval_service::SearchResponse`
// / `NeighborsResponse` exactly. The earlier draft lied about which fields
// were present (no `type`/`title`/`snippet`/`updatedAtUtc`); fixed in the
// audit pass after `Browse.tsx` ran into the gap and worked around it with
// `as unknown as` casts. The Rust handler reads `filters.type` (singular
// string), not `filters.types` (plural array) — TS now matches.
export type SearchFilters = {
  type?: string
  pathPrefix?: string
}

export type SearchRequest = {
  query: string
  filters?: SearchFilters
  limit?: number
}

export type SearchResultItem = {
  nodeId: NodeId
  type: string
  title?: string
  snippet: string
  scoreLexical: number
  scoreSemantic: number
  scoreStructural: number
  finalScore: number
  evidenceIds: string[]
  updatedAtUtc: ISO8601Utc
}

export type SearchResponse = {
  seeds: NodeId[]
  results: SearchResultItem[]
}

export type TraceOptions = {
  maxDepth?: 1 | 2
  includeEvidence?: boolean
}

/**
 * Per-neighbour record returned by `retrieval.trace`. Matches the Rust
 * `retrieval_service::NeighborItem` shape.
 */
export type NeighborItem = {
  nodeId: NodeId
  type: string
  title?: string
  snippet: string
  hop: 1 | 2
  viaPredicate: string
  updatedAtUtc: ISO8601Utc
}

/**
 * Response shape for `bridge.trace` — matches the Rust
 * `retrieval_service::NeighborsResponse`. The older `TraceabilityReport`
 * alias ({targetId, relatedNodes, relatedEdges, evidenceIds}) was
 * aspirational; the runtime never produced it. Renamed to make the gap
 * explicit. If a future round wires a richer traceability surface it
 * MUST come through a new typed alias, not by mutating this one.
 */
export type NeighborsResponse = {
  seedId: NodeId
  depth: 1 | 2
  neighbors: NeighborItem[]
}

// Gherkin → Jira/Xray Python runner (TRP capability)
//
// Maps to the Rust `run_gherkin_script` command, which spawns the
// embedded CPython runtime against the bundled `gherkin_insert.py`
// with `<featurePath> --project <project> --ticket <ticket>
// [--extra <arg>]…`. Shapes mirror the command's request payload and
// the `{ exitCode, stdout, stderr, ok }` JSON it returns verbatim.
export type RunGherkinScriptRequest = {
  /** Absolute path to the Gherkin/.feature file handed to python.exe. */
  featurePath: string
  /** Jira project key the script targets. */
  project: string
  /** Jira ticket the script attaches its results to. */
  ticket: string
  /** Extra `--extra <arg>` pairs forwarded to the script, in order. */
  extraArgs?: string[]
}

export type RunGherkinScriptResult = {
  /** `true` iff the script exited 0 (mirrors the Rust `ok` field). */
  ok: boolean
  /** Process exit code; `-1` when the OS reported no code. */
  exitCode: number
  stdout: string
  stderr: string
}

// MCP types
export type McpToolResult = {
  toolName: string
  output: Record<string, unknown>
  provenance: { nodeIds?: string[]; evidenceIds?: string[] }
}
