import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { bridge } from '../bridge/client'
import type { WorkspaceType } from '../bridge/types'
// stylesheet for the browse list
import '../styles/Browse.css'

interface ListItem {
  id: string
  type: string
  title?: string
  updatedAtUtc?: string
  kind?: string
  path?: string
  piId?: string
}

interface PiOption {
  id: string
  title: string
}

// Local view of the bridge SearchResultItem — picks the fields the page renders.
type SearchResultItem = {
  nodeId: string
  type: string
  title?: string
  snippet: string
  finalScore: number
  updatedAtUtc: string
}

export const Browse: React.FC = () => {
  const [items, setItems] = useState<ListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [kindFilter, setKindFilter] = useState<'all' | 'draft' | 'canonical'>('all')
  const [piFilter, setPiFilter] = useState<string>('all')
  const [piOptions, setPiOptions] = useState<PiOption[]>([])

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [counts, setCounts] = useState<{ nodeCount: number; edgeCount: number } | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await bridge.listWorkspaces({
        type: filter === 'all' ? undefined : (filter as WorkspaceType),
        ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
        ...(piFilter !== 'all' && piFilter !== 'unassigned' ? { piId: piFilter } : {}),
      })
      let next: ListItem[] = res.items.map((it) => ({
        id: it.id,
        type: it.type,
        title: it.title,
        updatedAtUtc: it.updatedAtUtc,
        kind: it.kind,
        path: it.path,
        piId: it.piId,
      }))
      if (piFilter === 'unassigned') {
        // The bridge has no "no piId" filter — surface client-side.
        next = next.filter((i) => !i.piId)
      }
      setItems(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  // Populate the PI dropdown from the index. Re-runs whenever the user
  // creates a new PI elsewhere in the app and comes back.
  const refreshPiOptions = async () => {
    try {
      const res = await bridge.listWorkspaces({ type: 'product_increment' })
      setPiOptions(
        res.items.map((i) => ({ id: i.id, title: i.title || `PI ${i.id.slice(0, 8)}` })),
      )
    } catch {
      setPiOptions([])
    }
  }

  const refreshCounts = async () => {
    try {
      const h = await bridge.getHealth()
      setCounts({ nodeCount: h.index.nodeCount, edgeCount: h.index.edgeCount })
    } catch {
      setCounts(null)
    }
  }

  const handleDelete = async (e: React.MouseEvent, item: ListItem) => {
    e.preventDefault()
    e.stopPropagation()
    const label = item.title || item.id
    if (!window.confirm(
      `Delete "${label}"?\n\nThe file on disk and the SQLite row will be removed. This cannot be undone.`,
    )) return
    try {
      await bridge.deleteNode(item.id)
      // Optimistically remove from local list — no need to wait for refresh.
      setItems((prev) => prev.filter((i) => i.id !== item.id))
      refreshCounts()
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  useEffect(() => {
    refresh()
    refreshCounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, kindFilter, piFilter])

  // PI options are independent of the current filter set — fetch once on
  // mount. Refreshing the page (or revisiting Browse after creating a PI
  // elsewhere) re-runs this; that's the intended cadence.
  useEffect(() => {
    refreshPiOptions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced search: when query changes, query the FTS-backed graph.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults(null)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    const handle = window.setTimeout(async () => {
      try {
        const res = await bridge.search({
          query: trimmed,
          filters: filter === 'all' ? undefined : { type: filter },
          limit: 25,
        })
        if (cancelled) return
        // bridge.search returns SearchResultItem[] from bridge/types.ts —
        // shape (nodeId/type/title/snippet/finalScore/updatedAtUtc/...) matches
        // the local SearchResultItem we render here.
        const results: SearchResultItem[] = res.results.map((r) => ({
          nodeId: r.nodeId,
          type: r.type,
          title: r.title,
          snippet: r.snippet,
          finalScore: r.finalScore,
          updatedAtUtc: r.updatedAtUtc,
        }))
        setSearchResults(results)
      } catch (err) {
        if (cancelled) return
        setSearchError(err instanceof Error ? err.message : 'Search failed')
        setSearchResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [query, filter])

  const showingResults = searchResults !== null
  const renderedRows = useMemo(() => {
    if (showingResults) {
      return (searchResults ?? []).map((r) => ({
        id: r.nodeId,
        type: r.type,
        title: r.title,
        updatedAtUtc: r.updatedAtUtc,
        snippet: r.snippet,
        score: r.finalScore,
      }))
    }
    return items.map((it) => ({
      id: it.id,
      type: it.type,
      title: it.title,
      updatedAtUtc: it.updatedAtUtc,
      snippet: undefined as string | undefined,
      score: undefined as number | undefined,
    }))
  }, [items, searchResults, showingResults])

  return (
    <div className="browse-page">
      <div className="browse-header">
        <h1>Saved drafts</h1>
        <p>
          Drafts saved from Create Requirement and Create Annotation are stored
          on disk and indexed for full-text search via SQLite FTS5.
          {counts && (
            <>
              {' '}
              <strong>
                {counts.nodeCount} node{counts.nodeCount === 1 ? '' : 's'}
              </strong>{' '}
              indexed.
            </>
          )}
        </p>
        <div className="browse-controls">
          <input
            type="search"
            placeholder="Search the graph (FTS5)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="browse-search"
          />
          <label>
            Type:&nbsp;
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="themed-select"
            >
              <option value="all">All</option>
              <option value="product_increment">PIs</option>
              <option value="artifact_collection">Collections</option>
              <option value="requirement_document">Documents</option>
              <option value="epic">Epics</option>
              <option value="flow">Flows</option>
              <option value="reference">References</option>
            </select>
          </label>
          <label>
            PI:&nbsp;
            <select
              value={piFilter}
              onChange={(e) => setPiFilter(e.target.value)}
              className="themed-select"
            >
              <option value="all">All PIs</option>
              {piOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label>
            Kind:&nbsp;
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'all' | 'draft' | 'canonical')}
            >
              <option value="all">All</option>
              <option value="draft">Drafts</option>
              <option value="canonical">Canonical (kb/)</option>
            </select>
          </label>
          <button
            onClick={() => {
              refresh()
              refreshCounts()
            }}
            className="btn btn-secondary"
          >
            Refresh
          </button>
        </div>
      </div>

      {showingResults && searching && <div className="browse-loading">Searching…</div>}
      {searchError && <div className="browse-error">Search error: {searchError}</div>}
      {!showingResults && loading && <div className="browse-loading">Loading…</div>}
      {!showingResults && error && <div className="browse-error">Error: {error}</div>}

      {!loading && !showingResults && !error && items.length === 0 && (
        <div className="browse-empty">
          No drafts yet. Try{' '}
          <Link to="/requirement/create">Create Requirement</Link> or{' '}
          <Link to="/annotation/create">Create Annotation</Link>.
        </div>
      )}

      {showingResults && !searching && (searchResults ?? []).length === 0 && (
        <div className="browse-empty">
          No results for <code>{query}</code>.
        </div>
      )}

      {renderedRows.length > 0 && (
        <ul className="browse-list">
          {renderedRows.map((it) => {
            const target =
              it.type === 'annotation'
                ? `/annotation/create?draftId=${encodeURIComponent(it.id)}`
                : it.type === 'flow'
                  ? `/flow/${encodeURIComponent(it.id)}`
                  : it.type === 'epic'
                    ? `/epic/${encodeURIComponent(it.id)}`
                    : `/requirement/create?draftId=${encodeURIComponent(it.id)}`
            // Use the original item record (not the search-result projection)
            // for delete since handleDelete needs full ListItem fields.
            const original =
              items.find((x) => x.id === it.id) ??
              ({ id: it.id, type: it.type, title: it.title } as ListItem)
            return (
              <li key={it.id} className="browse-item">
                <button
                  type="button"
                  className="browse-item-delete"
                  onClick={(e) => handleDelete(e, original)}
                  title="Delete this item permanently"
                  aria-label="Delete"
                >
                  ×
                </button>
                <Link to={target} className="browse-item-link">
                  <div className="browse-item-row">
                    <span className={`type-chip type-${it.type}`}>
                      {it.type || 'unknown'}
                    </span>
                    {(() => {
                      const original = items.find((x) => x.id === it.id)
                      const kind = original?.kind
                      if (!kind) return null
                      return (
                        <span className={`kind-chip kind-${kind}`}>
                          {kind === 'canonical' ? '✓ canonical' : 'draft'}
                        </span>
                      )
                    })()}
                    <strong className="browse-item-title">
                      {it.title || '(untitled)'}
                    </strong>
                    {it.score !== undefined && (
                      <span className="browse-item-score">
                        score {it.score.toFixed(2)}
                      </span>
                    )}
                    <span className="browse-item-id">{it.id}</span>
                  </div>
                  {it.snippet && (
                    <div
                      className="browse-item-snippet"
                      dangerouslySetInnerHTML={{ __html: it.snippet }}
                    />
                  )}
                  <div className="browse-item-meta">
                    {it.updatedAtUtc && (
                      <span>
                        updated {new Date(it.updatedAtUtc).toLocaleString()}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default Browse
