import { invoke } from '@tauri-apps/api/core'
import type {
  RequestEnvelope,
  ResponseEnvelope,
  InterfaceMeta,
  AppHealth,
  StartupState,
  WorkspaceListRequest,
  WorkspaceListResponse,
  GraphNode,
  DraftNodeUpsert,
  SearchRequest,
  SearchResponse,
  TraceOptions,
  NeighborsResponse,
  McpToolResult,
  RunGherkinScriptRequest,
  RunGherkinScriptResult,
} from './types'

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function createMeta(caller: string): Omit<InterfaceMeta, 'requestId' | 'traceId' | 'timestampUtc'> {
  return {
    interfaceId: 'shell-bridge.v1',
    version: '1.0.0',
    caller,
  }
}

function createRequestEnvelope<T>(
  payload: T,
  caller: string,
): RequestEnvelope<T> {
  return {
    meta: {
      ...createMeta(caller),
      requestId: generateUUID(),
      traceId: generateUUID(),
      timestampUtc: new Date().toISOString(),
    },
    payload,
  }
}

async function invokeCommand<TReq, TRes>(
  cmd: string,
  payload: TReq,
  timeout?: number,
): Promise<ResponseEnvelope<TRes>> {
  const controller = new AbortController()
  const timeoutHandle = timeout ? setTimeout(() => controller.abort(), timeout) : undefined

  try {
    const response = await invoke<ResponseEnvelope<TRes>>(cmd, {
      payload,
    })
    return response
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export const bridge = {
  async getHealth(): Promise<AppHealth> {
    const req = createRequestEnvelope({}, 'ui-app')
    const res = await invokeCommand<typeof req, AppHealth>('app_getHealth', req)
    if (!res.ok) throw new Error(res.error?.message || 'getHealth failed')
    return res.payload!
  },

  async getStartupState(): Promise<StartupState> {
    const req = createRequestEnvelope({}, 'ui-app')
    const res = await invokeCommand<typeof req, StartupState>('startup_getState', req)
    if (!res.ok) throw new Error(res.error?.message || 'getStartupState failed')
    return res.payload!
  },

  async listWorkspaces(
    request: WorkspaceListRequest = {},
  ): Promise<WorkspaceListResponse> {
    const req = createRequestEnvelope(request, 'ui-app')
    const res = await invokeCommand<typeof req, WorkspaceListResponse>(
      'workspace_list',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'listWorkspaces failed')
    return res.payload!
  },

  async readNode(id: string): Promise<GraphNode> {
    const req = createRequestEnvelope({ id }, 'ui-app')
    const res = await invokeCommand<typeof req, GraphNode>(
      'workspace_readNode',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'readNode failed')
    return res.payload!
  },

  async upsertDraftNode(draft: DraftNodeUpsert): Promise<{ draftId: string; updatedAtUtc: string }> {
    const req = createRequestEnvelope({ draft }, 'ui-app')
    const res = await invokeCommand<typeof req, { draftId: string; updatedAtUtc: string }>(
      'workspace_upsertDraftNode',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'upsertDraftNode failed')
    return res.payload!
  },

  async promoteDraft(
    draftId: string,
    policyDecisionId: string,
  ): Promise<{ nodeId: string; canonicalPath: string; promotedAtUtc: string }> {
    const req = createRequestEnvelope({ draftId, policyDecisionId }, 'ui-app')
    const res = await invokeCommand<typeof req, { nodeId: string; canonicalPath: string; promotedAtUtc: string }>(
      'workspace_promoteDraft',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'promoteDraft failed')
    return res.payload!
  },

  /**
   * Convert a legacy Office binary (`.doc` / `.xls` / `.ppt`) to its
   * modern OOXML counterpart (`.docx` / `.xlsx` / `.pptx`) by driving
   * Word / Excel / PowerPoint via COM automation. Windows-only; throws
   * with `code === 'E_OFFICE_NOT_INSTALLED'` if the matching Office
   * app isn't available so the UI can fall back to a "save as" message.
   */
  async officeConvertLegacy(args: {
    dataUrl: string
    filename: string
    format: 'doc' | 'xls' | 'ppt'
  }): Promise<{
    dataUrl: string
    filename: string
    mimeType: string
    originalBytes: number
    convertedBytes: number
    durationMs: number
  }> {
    const req = createRequestEnvelope(args, 'ui-app/office-convert')
    const res = await invokeCommand<
      typeof req,
      {
        dataUrl: string
        filename: string
        mimeType: string
        originalBytes: number
        convertedBytes: number
        durationMs: number
      }
    >('office_convert_legacy', req, 90_000)
    if (!res.ok) {
      const e = new Error(res.error?.message || 'officeConvertLegacy failed') as Error & {
        code?: string
      }
      e.code = res.error?.code
      throw e
    }
    return res.payload!
  },

  async llmExtractImageText(
    args: {
      dataUrl: string
      filename?: string
      options?: { temperature?: number; maxChars?: number }
    },
  ): Promise<{
    text: string
    cached: boolean
    charsExtracted: number
    durationMs: number
    skipReason?: string
  }> {
    const req = createRequestEnvelope(args, 'ui-app/extract')
    const res = await invokeCommand<
      typeof req,
      {
        text: string
        cached: boolean
        charsExtracted: number
        durationMs: number
        skipReason?: string
      }
    >('llm_extract_image_text', req, 90_000)
    if (!res.ok) throw new Error(res.error?.message || 'llmExtractImageText failed')
    return res.payload!
  },

  async llmCliPing(
    args: { binary?: string },
  ): Promise<{ binary: string; version: string; durationMs: number }> {
    const req = createRequestEnvelope(args, 'ui-app/settings')
    const res = await invokeCommand<
      typeof req,
      { binary: string; version: string; durationMs: number }
    >('llm_cli_ping', req, 10_000)
    if (!res.ok) throw new Error(res.error?.message || 'llmCliPing failed')
    return res.payload!
  },

  /**
   * Run the bundled Gherkin → Jira/Xray Python script through the
   * embedded CPython runtime. The Rust `run_gherkin_script` command
   * ensures the vendored interpreter + `gherkin_insert.py` are
   * extracted, then spawns `python.exe <script> <featurePath>
   * --project <project> --ticket <ticket> [--extra <arg>]…` with output
   * captured (no console flash) and returns `{ ok, exitCode, stdout,
   * stderr }`.
   *
   * This is the low-level capability only — it does not parse stdout or
   * drive any publish UI; callers wire that once the real script ships.
   * Spawn / extraction / timeout failures surface as a thrown Error
   * (with `code` set to e.g. `E_PYTHON_RUN` / `E_PYTHON_TIMEOUT`),
   * matching `officeConvertLegacy`. 120s host budget covers the script's
   * eventual Jira/Xray HTTP calls.
   */
  async runGherkinScript(
    args: RunGherkinScriptRequest,
  ): Promise<RunGherkinScriptResult> {
    const req = createRequestEnvelope(args, 'ui-app/gherkin')
    const res = await invokeCommand<typeof req, RunGherkinScriptResult>(
      'run_gherkin_script',
      req,
      120_000,
    )
    if (!res.ok) {
      const e = new Error(res.error?.message || 'runGherkinScript failed') as Error & {
        code?: string
      }
      e.code = res.error?.code
      throw e
    }
    return res.payload!
  },

  async llmQuery(
    args: {
      use: 'query' | 'imageTextExtraction'
      systemPrompt: string
      userPrompt: string
      contextHits: Array<{
        nodeId: string
        title?: string
        snippet: string
        score?: number
      }>
      options?: { temperature?: number; maxTokens?: number }
      /**
       * D-021 §4.12: when llmQuery is called from the slash-command
       * runner, pass the command shape (id + boolean flags only — never
       * the body) so the Rust side can append a `slash.<commandId>`
       * audit entry alongside the standard `llm.query.invoked` entry.
       */
      slashAudit?: {
        commandId: string
        hasSelection: boolean
        hasArg: boolean
        replaceSelection: boolean
      }
    },
  ): Promise<{
    markdown: string
    citations: Array<{ nodeId: string; used: boolean }>
    /**
     * Images surfaced by MCP tool calls the agent made during this
     * turn (currently scoped to `mcp__pmscratch__get_image` results,
     * which the chat surfaces below the assistant's text). Empty
     * when no image-producing tool was called or when MCP wasn't
     * wired (e.g. non-chat `use_id`s).
     */
    toolImages?: Array<{ mimeType: string; dataBase64: string; toolName: string }>
    usage?: { promptTokens?: number; completionTokens?: number }
  }> {
    const req = createRequestEnvelope(args, 'ui-app/chat')
    const res = await invokeCommand<
      typeof req,
      {
        markdown: string
        citations: Array<{ nodeId: string; used: boolean }>
        toolImages?: Array<{ mimeType: string; dataBase64: string; toolName: string }>
        usage?: { promptTokens?: number; completionTokens?: number }
      }
      // 5-minute ceiling for the chat agent's full tool-use loop. The
      // model may chain several MCP tool calls (search_nodes →
      // list_references → get_node × N → answer) for complex queries
      // like "list all X then break down by Y" — 90s was tight enough
      // that those queries timed out before the agent could synthesise.
    >('llm_query', req, 300_000)
    if (!res.ok) throw new Error(res.error?.message || 'llmQuery failed')
    return res.payload!
  },

  async ingestUrl(args: {
    projectId: string
    url: string
  }): Promise<{ title?: string }> {
    const req = createRequestEnvelope(args, 'ui-app')
    const res = await invokeCommand<typeof req, { title?: string }>(
      'app_ingestUrl',
      req,
      60_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'ingestUrl failed')
    return res.payload!
  },

  async deleteNode(
    id: string,
  ): Promise<{ id: string; deletedPaths: string[] }> {
    const req = createRequestEnvelope({ id }, 'ui-app')
    const res = await invokeCommand<typeof req, { id: string; deletedPaths: string[] }>(
      'workspace_deleteNode',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'deleteNode failed')
    return res.payload!
  },

  async search(searchReq: SearchRequest): Promise<SearchResponse> {
    const req = createRequestEnvelope(searchReq, 'ui-app')
    const res = await invokeCommand<typeof req, SearchResponse>(
      'retrieval_search',
      req,
      15000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'search failed')
    return res.payload!
  },

  async trace(
    targetId: string,
    options?: TraceOptions,
  ): Promise<NeighborsResponse> {
    const req = createRequestEnvelope({ targetId, options }, 'ui-app')
    const res = await invokeCommand<typeof req, NeighborsResponse>(
      'retrieval_trace',
      req,
      15000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'trace failed')
    return res.payload!
  },

  async invokeTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const req = createRequestEnvelope({ toolName, input }, 'ui-app')
    const res = await invokeCommand<typeof req, McpToolResult>(
      'mcp_invokeTool',
      req,
      15000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'invokeTool failed')
    return res.payload!
  },

  // ── Atlassian connector ──────────────────────────────────────────────────

  async atlassianGetSettings(): Promise<{ settings: { baseUrl?: string; email?: string; apiToken?: string } }> {
    const req = createRequestEnvelope({}, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { settings: { baseUrl?: string; email?: string; apiToken?: string } }>(
      'atlassian_getSettings',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianGetSettings failed')
    return res.payload!
  },

  async atlassianSetSettings(args: { settings: { baseUrl: string; email: string; apiToken: string } }): Promise<void> {
    const req = createRequestEnvelope(args, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { ok: boolean }>(
      'atlassian_setSettings',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianSetSettings failed')
  },

  async atlassianImportFromUrl(url: string): Promise<{ id: string; title: string; space: string; url: string; body_md: string }> {
    const req = createRequestEnvelope({ url }, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { id: string; title: string; space: string; url: string; body_md: string }>(
      'atlassian_importFromUrl',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianImportFromUrl failed')
    return res.payload!
  },

  /** TRP C-018: fetch a Jira issue by its browser URL (board view with
   *  `?selectedIssue=`, `/browse/KEY`, or `/jira/.../issues/KEY`) and
   *  return the assembled markdown body + metadata. */
  async atlassianImportJiraIssue(url: string): Promise<{
    key: string
    summary: string
    project: string
    issue_type: string
    status: string
    priority: string
    assignee_display: string
    reporter_display: string
    assignee_account_id: string
    reporter_account_id: string
    created: string
    updated: string
    labels: string[]
    source_url: string
    body_md: string
    attachments_meta: Array<{
      id: string
      filename: string
      mime_type: string
      size: number
      url: string
    }>
  }> {
    const req = createRequestEnvelope({ url }, 'ui-app/atlassian')
    const res = await invokeCommand<
      typeof req,
      {
        key: string
        summary: string
        project: string
        issue_type: string
        status: string
        priority: string
        assignee_display: string
        reporter_display: string
        assignee_account_id: string
        reporter_account_id: string
        created: string
        updated: string
        labels: string[]
        source_url: string
        body_md: string
        attachments_meta: Array<{
          id: string
          filename: string
          mime_type: string
          size: number
          url: string
        }>
      }
    >('atlassian_importJiraIssue', req, 60_000)
    if (!res.ok) throw new Error(res.error?.message || 'atlassianImportJiraIssue failed')
    return res.payload!
  },

  async atlassianDiagnose(_domain?: string): Promise<{ ok: boolean; displayName: string }> {
    const req = createRequestEnvelope({}, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { ok: boolean; displayName: string }>(
      'atlassian_diagnose',
      req,
      10_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianDiagnose failed')
    return res.payload!
  },

  async atlassianSearchConfluence(query: string): Promise<Array<{
    id: string; title: string; space: string; url: string; excerpt: string
  }>> {
    const req = createRequestEnvelope({ query }, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { pages: Array<{
      id: string; title: string; space: string; url: string; excerpt: string
    }> }>(
      'atlassian_searchConfluence',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianSearchConfluence failed')
    return res.payload!.pages ?? []
  },

  async atlassianGetConfluencePage(pageId: string): Promise<string> {
    const req = createRequestEnvelope({ pageId }, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { text: string }>(
      'atlassian_getConfluencePage',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianGetConfluencePage failed')
    return res.payload!.text ?? ''
  },

  async atlassianSearchJira(jql: string): Promise<Array<{
    key: string; summary: string; status: string; issue_type: string; url: string; description: string
  }>> {
    const req = createRequestEnvelope({ jql }, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { issues: Array<{
      key: string; summary: string; status: string; issue_type: string; url: string; description: string
    }> }>(
      'atlassian_searchJira',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianSearchJira failed')
    return res.payload!.issues ?? []
  },

  async atlassianListJiraProjects(): Promise<Array<{ key: string; name: string }>> {
    const req = createRequestEnvelope({}, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { projects: Array<{ key: string; name: string }> }>(
      'atlassian_listJiraProjects',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianListJiraProjects failed')
    return res.payload!.projects ?? []
  },

  async atlassianCreateJiraIssue(args: {
    projectKey: string
    summary: string
    description: string
    issueType?: string
  }): Promise<{ key: string; id: string; url: string }> {
    const req = createRequestEnvelope(
      { projectKey: args.projectKey, summary: args.summary, description: args.description, issueType: args.issueType ?? 'Story' },
      'ui-app/atlassian',
    )
    const res = await invokeCommand<typeof req, { key: string; id: string; url: string }>(
      'atlassian_createJiraIssue',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianCreateJiraIssue failed')
    return res.payload!
  },

  /** TRP C-019: update an existing Jira issue's summary + description. */
  async atlassianUpdateJiraIssue(args: {
    issueKey: string
    summary: string
    description: string
  }): Promise<void> {
    const req = createRequestEnvelope(args, 'ui-app/atlassian')
    const res = await invokeCommand<typeof req, { ok: boolean }>(
      'atlassian_updateJiraIssue',
      req,
      30_000,
    )
    if (!res.ok) throw new Error(res.error?.message || 'atlassianUpdateJiraIssue failed')
  },

  // ── Microsoft 365 connector ──────────────────────────────────────────────
  //
  // OAuth2 device-code flow. The renderer:
  //   1. Calls `microsoftBeginSignIn()` to get a `userCode` +
  //      `verificationUri` to show, plus a `deviceCode` to poll with.
  //   2. Polls `microsoftPollSignIn(deviceCode)` every `interval`
  //      seconds until `status === 'complete'`.
  //   3. The Rust side persists the refresh token under settings.json
  //      and from then on `microsoftGetSettings().isSignedIn` is true.
  // The refresh token never crosses the IPC boundary.

  /** Write a small file to the configured local OneDrive-synced
   *  folder. Used as the SharePoint-upload fallback when the tenant
   *  CA policy blocks Graph upload (AADSTS530033) but the user has
   *  the document library synced locally — OneDrive then pushes the
   *  file up to SharePoint on its normal cadence (usually seconds).
   *
   *  Caller computes the SharePoint web URL itself from the same
   *  hostname / site / folder constants used for the API path. */
  async microsoftWriteSyncFile(args: {
    filename: string
    contentType?: string
    dataUrl: string
  }): Promise<{ ok: boolean; localPath: string; syncPath: string; size: number }> {
    const req = createRequestEnvelope(args, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, {
      ok: boolean
      localPath: string
      syncPath: string
      size: number
    }>('microsoft_writeSyncFile', req, 60_000)
    if (!res.ok)
      throw new Error(res.error?.message || 'microsoftWriteSyncFile failed')
    return res.payload!
  },

  async microsoftGetSettings(): Promise<{
    settings: {
      tenantId: string
      clientId: string
      userDisplayName: string
      userPrincipalName: string
      isSignedIn: boolean
      /** Raw configured value — empty when the user hasn't set one. */
      syncPath: string
      /** Resolved value with the Rust-side default substituted in. */
      effectiveSyncPath: string
    }
  }> {
    const req = createRequestEnvelope({}, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, {
      settings: {
        tenantId: string
        clientId: string
        userDisplayName: string
        userPrincipalName: string
        isSignedIn: boolean
        syncPath: string
        effectiveSyncPath: string
      }
    }>('microsoft_getSettings', req)
    if (!res.ok) throw new Error(res.error?.message || 'microsoftGetSettings failed')
    return res.payload!
  },

  async microsoftSetSettings(args: {
    settings: { tenantId?: string; clientId?: string; syncPath?: string }
  }): Promise<void> {
    const req = createRequestEnvelope(args, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, { ok: boolean }>(
      'microsoft_setSettings',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'microsoftSetSettings failed')
  },

  async microsoftBeginSignIn(): Promise<{
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
    message: string
  }> {
    const req = createRequestEnvelope({}, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, {
      deviceCode: string
      userCode: string
      verificationUri: string
      expiresIn: number
      interval: number
      message: string
    }>('microsoft_beginSignIn', req, 30_000)
    if (!res.ok) throw new Error(res.error?.message || 'microsoftBeginSignIn failed')
    return res.payload!
  },

  /** Poll the token endpoint. Returns `{ status: 'pending' }` when the
   *  user hasn't completed yet (keep polling), or `{ status: 'complete',
   *  userDisplayName, userPrincipalName }` on success. Throws on hard
   *  errors (expired, declined, network). */
  async microsoftPollSignIn(deviceCode: string): Promise<
    | { status: 'pending' }
    | { status: 'complete'; userDisplayName: string; userPrincipalName: string }
  > {
    const req = createRequestEnvelope({ deviceCode }, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req,
      | { status: 'pending' }
      | { status: 'complete'; userDisplayName: string; userPrincipalName: string }
    >('microsoft_pollSignIn', req, 30_000)
    if (!res.ok) throw new Error(res.error?.message || 'microsoftPollSignIn failed')
    return res.payload!
  },

  /** Open the PKCE / authorization-code popup sign-in flow. Opens a
   *  Tauri sub-window pointed at login.microsoftonline.com; the Rust
   *  side hooks WebView2's NavigationStarting event to intercept the
   *  `http://localhost/auth/callback` redirect, exchanges the code +
   *  PKCE verifier for tokens, persists them, closes the popup, and
   *  resolves with `{status: 'complete', userDisplayName, userPrincipalName}`.
   *
   *  Prefer this over `microsoftBeginSignIn` + `microsoftPollSignIn`
   *  — fewer round-trips, no copy/paste device code, single async
   *  call. Falls back to device-code on non-Windows (where the COM
   *  nav hook isn't implemented) or when the tenant blocks public-
   *  client app IDs (AADSTS530033).
   *
   *  Long timeout — the user may take a minute or two to enter
   *  credentials, do 2FA, and answer the consent prompt. We cap at
   *  10 minutes to keep the promise from leaking on session-end. */
  async microsoftBeginPopupSignIn(): Promise<{
    userDisplayName: string
    userPrincipalName: string
  }> {
    const req = createRequestEnvelope({}, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, {
      status: 'complete'
      userDisplayName: string
      userPrincipalName: string
    }>('microsoft_beginPopupSignIn', req, 600_000)
    if (!res.ok)
      throw new Error(res.error?.message || 'microsoftBeginPopupSignIn failed')
    return {
      userDisplayName: res.payload!.userDisplayName,
      userPrincipalName: res.payload!.userPrincipalName,
    }
  },

  async microsoftSignOut(): Promise<void> {
    const req = createRequestEnvelope({}, 'ui-app/microsoft')
    const res = await invokeCommand<typeof req, { ok: boolean }>(
      'microsoft_signOut',
      req,
    )
    if (!res.ok) throw new Error(res.error?.message || 'microsoftSignOut failed')
  },

  /** Upload a small (<4 MB) file to a SharePoint document library by
   *  path. The Rust side mints a fresh access token from the persisted
   *  refresh token, resolves the site by hostname + path, then PUTs
   *  the bytes. Returns the uploaded item's webUrl which the caller
   *  can splice into a Jira description / link / wherever. */
  async microsoftUploadFile(args: {
    hostname: string
    sitePath: string
    folderPath: string
    filename: string
    contentType: string
    dataUrl: string
  }): Promise<{
    ok: boolean
    item: { id: string; name: string; webUrl: string; size: number }
    siteWebUrl: string
  }> {
    const req = createRequestEnvelope(args, 'ui-app/microsoft')
    const res = await invokeCommand<
      typeof req,
      {
        ok: boolean
        item: { id: string; name: string; webUrl: string; size: number }
        siteWebUrl: string
      }
    >('microsoft_uploadFile', req, 60_000)
    if (!res.ok) throw new Error(res.error?.message || 'microsoftUploadFile failed')
    return res.payload!
  },
}
