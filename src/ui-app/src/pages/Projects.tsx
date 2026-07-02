import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { bridge } from '../bridge/client'
import '../styles/Projects.css'

interface ProjectItem {
  id: string
  title: string
  updatedAtUtc?: string
}

export default function Projects() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = () => {
    setLoading(true)
    bridge
      .listWorkspaces({ type: 'project' })
      .then((res) => {
        setProjects(
          res.items.map((it) => ({
            id: it.id,
            title: it.title || `Project ${it.id.slice(0, 8)}`,
            updatedAtUtc: it.updatedAtUtc,
          }))
        )
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load projects'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const createProject = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const res = await bridge.upsertDraftNode({
        type: 'project',
        title: name,
        bodyMd: JSON.stringify({ blocks: [] }),
        jsonld: JSON.stringify({ '@type': 'Project', name }),
      })
      await bridge.promoteDraft(res.draftId, '')
      setNewName('')
      load()
      navigate(`/projects/${res.draftId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="page-projects">
      <div className="page-header">
        <h1>Projects</h1>
        <div className="new-project-row">
          <input
            type="text"
            placeholder="New project name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createProject() }}
            className="input-new-project"
          />
          <button
            type="button"
            onClick={() => void createProject()}
            disabled={creating || !newName.trim()}
            className="btn btn-primary"
          >
            {creating ? 'Creating…' : '+ New Project'}
          </button>
        </div>
      </div>

      {loading && <p className="status-loading">Loading…</p>}
      {error && <p className="status-error">{error}</p>}

      {!loading && projects.length === 0 && (
        <div className="projects-splash">
          <img src="/chunky.png" alt="Chunky" className="projects-splash-img" />
          <p className="projects-splash-hint">Create your first project above to get started.</p>
        </div>
      )}

      <ul className="project-grid">
        {projects.map((p) => (
          <li key={p.id} className="project-card" onClick={() => navigate(`/projects/${p.id}`)}>
            <span className="project-card-title">{p.title}</span>
            {p.updatedAtUtc && (
              <span className="project-card-meta">
                {new Date(p.updatedAtUtc).toLocaleDateString()}
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
