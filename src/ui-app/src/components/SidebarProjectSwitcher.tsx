/**
 * Sidebar project switcher — replaces the static "My Project" button.
 *
 * Click the button to open a dropdown listing every project workspace.
 * Each row is a switch button; the row matching the active project also
 * shows a small "rename" affordance that flips the title into an inline
 * input. The bottom row is a "+ New Project" action that creates a
 * fresh project, switches to it, and drops into rename immediately.
 *
 * State persists via:
 *   - `localStorage["pmscratch-active-project-id"]` for active selection
 *   - `bridge.upsertDraftNode` / `promoteDraft` for create + rename
 *
 * The `onProjectId` callback fires on first resolve and every switch so
 * downstream consumers (PI editor, scope filters) can read the active
 * project id off a global `window.__pmscratchProjectId` value.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bridge } from '../bridge/client'
import { Icon } from './Icon'

export interface SidebarProjectSwitcherProps {
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

export function SidebarProjectSwitcher({ onProjectId }: SidebarProjectSwitcherProps) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    items.sort((a, b) =>
      String(b.updatedAtUtc ?? '').localeCompare(String(a.updatedAtUtc ?? '')),
    )
    setProjects(items)
    return items
  }, [])

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
        console.warn('[sidebar-project] init failed:', e)
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
      console.warn('[sidebar-project] rename failed:', e)
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
      setDraft(NEW_NAME)
      setRenaming(created.draftId)
      setOpen(true)
    } catch (e) {
      console.warn('[sidebar-project] create failed:', e)
    }
  }

  if (loading) {
    return (
      <button className="sb-project" type="button" disabled>
        <span className="sb-project-label">
          <span className="k">Project</span>
          <span className="v">Loading…</span>
        </span>
      </button>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="sb-project"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch or rename project"
      >
        <span className="sb-project-label">
          <span className="k">Project</span>
          <span className="v">{active?.name ?? 'No project'}</span>
        </span>
        <span className="chev">
          <Icon name="chevDown" size={16} />
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Projects"
          className="sb-project-menu"
        >
          {projects.map((p) => {
            const isActive = p.id === activeId
            const isRenaming = renaming === p.id
            return (
              <div
                key={p.id}
                role="option"
                aria-selected={isActive}
                className={'sb-project-row' + (isActive ? ' active' : '')}
              >
                {isRenaming ? (
                  <input
                    ref={inputRef}
                    className="sb-project-rename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelRename()
                      }
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="sb-project-pick"
                      onClick={() => {
                        setActive(p.id)
                        setOpen(false)
                      }}
                    >
                      {p.name}
                    </button>
                    {isActive && (
                      <button
                        type="button"
                        className="sb-project-rename-btn"
                        title="Rename project"
                        aria-label="Rename project"
                        onClick={() => startRename(p.id)}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className="sb-project-new"
            onClick={() => void createNew()}
          >
            <Icon name="plus" size={13} />
            New project
          </button>
        </div>
      )}
    </div>
  )
}
