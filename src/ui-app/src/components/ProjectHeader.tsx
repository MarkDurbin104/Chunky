import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bridge } from '../bridge/client'

/**
 * Inline-editable dropdown of the workspace's `Project` entities.
 * Sits where the static "Local-first knowledge graph workspace"
 * subtitle used to live.
 *
 * Behaviour:
 *   - Closed: shows the active project name + a ▾ chevron.
 *   - Click the chevron / name to open the dropdown. Each project is
 *     a row in the list; click any row to switch active project.
 *     The active row also exposes a small "rename" affordance that
 *     flips its label into an inline `<input>`.
 *   - A "+ New Project" row at the bottom creates a fresh project
 *     (defaults to "New Project") and immediately selects it.
 *
 * Persistence:
 *   - First mount: list `project` nodes. If none exist, create a
 *     default one. Active id comes from
 *     `localStorage["pmscratch-active-project-id"]` if it points at
 *     a still-existing project; otherwise fall back to the most
 *     recently updated.
 *   - Each rename / create / switch persists the active id back to
 *     localStorage and notifies the parent via `onProjectId`.
 */
export interface ProjectHeaderProps {
  /** Fired with the active project's id on resolve, create, and
   *  every switch. PI editor / scope filter reads this. */
  onProjectId?: (id: string) => void
}

interface ProjectMeta {
  id: string
  name: string
  updatedAtUtc?: string
}

const DEFAULT_NAME = 'My Project'
const NEW_NAME = 'New Project'
const ACTIVE_KEY = 'chunky-active-project-id'

export function ProjectHeader({ onProjectId }: ProjectHeaderProps) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)

  const setActive = useCallback(
    (id: string) => {
      setActiveId(id)
      try {
        localStorage.setItem(ACTIVE_KEY, id)
      } catch {
        /* non-fatal */
      }
      onProjectId?.(id)
    },
    [onProjectId],
  )

  const refresh = useCallback(async (): Promise<ProjectMeta[]> => {
    const res = await bridge.listWorkspaces({ type: 'project' })
    const items: ProjectMeta[] = res.items.map((it) => ({
      id: it.id,
      name: it.title || 'Untitled project',
      updatedAtUtc: it.updatedAtUtc,
    }))
    // Most-recently-updated first so the default selection lands on
    // what the user was last touching.
    items.sort((a, b) =>
      String(b.updatedAtUtc ?? '').localeCompare(String(a.updatedAtUtc ?? '')),
    )
    setProjects(items)
    return items
  }, [])

  // First-mount resolve. Creates a default project if none exist.
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        let items = await refresh()
        if (cancelled) return
        if (items.length === 0) {
          const created = await bridge.upsertDraftNode({
            type: 'project',
            title: DEFAULT_NAME,
            bodyMd: JSON.stringify({ name: DEFAULT_NAME, blocks: [] }, null, 2),
            jsonld: JSON.stringify({ '@type': 'Project', name: DEFAULT_NAME }),
          })
          await bridge.promoteDraft(created.draftId, '')
          if (cancelled) return
          items = await refresh()
          if (cancelled) return
        }
        // Pick saved active if it still exists, else MRU.
        let pick: string | null = null
        try {
          const saved = localStorage.getItem(ACTIVE_KEY)
          if (saved && items.some((p) => p.id === saved)) pick = saved
        } catch {
          /* non-fatal */
        }
        if (!pick) pick = items[0]?.id ?? null
        if (pick) setActive(pick)
      } catch (e) {
        console.warn('[project-header] init failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close the dropdown when the user clicks outside it.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setRenaming(null)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  // Auto-focus the rename input when renaming flips on.
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  )

  const startRename = (id: string) => {
    const p = projects.find((x) => x.id === id)
    if (!p) return
    setDraft(p.name)
    setRenaming(id)
  }

  const commitRename = useCallback(async () => {
    const id = renaming
    if (!id) return
    const next = draft.trim()
    setRenaming(null)
    const current = projects.find((p) => p.id === id)
    if (!current || next.length === 0 || next === current.name) return
    try {
      await bridge.upsertDraftNode({
        id,
        type: 'project',
        title: next,
        bodyMd: JSON.stringify({ name: next, blocks: [] }, null, 2),
        jsonld: JSON.stringify({ '@type': 'Project', name: next }),
      })
      await refresh()
    } catch (e) {
      console.warn('[project-header] rename failed:', e)
    }
  }, [renaming, draft, projects, refresh])

  const cancelRename = () => {
    setRenaming(null)
    setDraft('')
  }

  const createNew = async () => {
    try {
      const created = await bridge.upsertDraftNode({
        type: 'project',
        title: NEW_NAME,
        bodyMd: JSON.stringify({ name: NEW_NAME, blocks: [] }, null, 2),
        jsonld: JSON.stringify({ '@type': 'Project', name: NEW_NAME }),
      })
      await bridge.promoteDraft(created.draftId, '')
      await refresh()
      setActive(created.draftId)
      // Drop straight into rename mode so the user can type the
      // real name without a second click.
      setDraft(NEW_NAME)
      setRenaming(created.draftId)
    } catch (e) {
      console.warn('[project-header] create failed:', e)
    }
  }

  if (loading) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading project…</p>
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch or rename project"
        title="Switch or rename project"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.15rem 0.5rem',
          background: 'transparent',
          border: '1px solid transparent',
          borderRadius: 4,
          color: 'var(--text-secondary)',
          font: 'inherit',
          fontSize: '0.95rem',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderColor =
            'var(--border-default)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent'
        }}
      >
        <span>{active?.name ?? 'No project'}</span>
        <span aria-hidden="true" style={{ fontSize: '0.7rem' }}>
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 260,
            maxHeight: 320,
            overflowY: 'auto',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-md, 0 4px 16px rgba(0,0,0,0.18))',
            zIndex: 50,
            padding: '0.25rem',
          }}
        >
          {projects.map((p) => {
            const isActive = p.id === activeId
            const isRenaming = renaming === p.id
            return (
              <div
                key={p.id}
                role="option"
                aria-selected={isActive}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.35rem 0.5rem',
                  borderRadius: 4,
                  background: isActive ? 'var(--accent-soft-bg)' : 'transparent',
                  color: isActive ? 'var(--text-link)' : 'var(--text-primary)',
                }}
              >
                {isRenaming ? (
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelRename()
                      }
                    }}
                    onBlur={() => void commitRename()}
                    aria-label="Project name"
                    style={{
                      flex: 1,
                      font: 'inherit',
                      color: 'var(--text-primary)',
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-focus, var(--border-default))',
                      borderRadius: 4,
                      padding: '0.15rem 0.4rem',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        setActive(p.id)
                        setOpen(false)
                      } else {
                        startRename(p.id)
                      }
                    }}
                    title={
                      isActive ? 'Click to rename' : 'Switch to this project'
                    }
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      font: 'inherit',
                      padding: 0,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.name}
                  </button>
                )}
                {isActive && !isRenaming && (
                  <button
                    type="button"
                    aria-label="Rename project"
                    title="Rename"
                    onClick={() => startRename(p.id)}
                    style={{
                      flex: '0 0 auto',
                      padding: '0.1rem 0.35rem',
                      background: 'transparent',
                      border: '1px solid var(--border-default)',
                      borderRadius: 3,
                      color: 'var(--text-muted)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    ✎
                  </button>
                )}
              </div>
            )
          })}
          <div
            style={{
              borderTop: '1px solid var(--border-default)',
              marginTop: '0.25rem',
              paddingTop: '0.25rem',
            }}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                void createNew()
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.35rem 0.5rem',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-link)',
                font: 'inherit',
                cursor: 'pointer',
                borderRadius: 4,
              }}
            >
              + New Project
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProjectHeader
