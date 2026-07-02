import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { bridge } from '../bridge/client'
import '../styles/Projects.css'
import { processFileInWorker } from '../lib/extract-client'
import { runOnWorkQueue } from '../lib/work-queue'

interface AssetItem {
  id: string
  type: string
  title: string
  updatedAtUtc?: string
  collectionId?: string | null
}

interface CustomCollection {
  id: string
  name: string
  updatedAtUtc?: string
}

const TYPE_BUCKETS: { id: string; label: string; icon: string; match: (t: string) => boolean }[] = [
  { id: 'paragraphs',   label: 'Paragraphs',   icon: '📓', match: (t) => t === 'note' },
  { id: 'documents',    label: 'Documents',    icon: '📝', match: (t) => t === 'docx' },
  { id: 'slides',       label: 'Slides',       icon: '📽️', match: (t) => t === 'slides' },
  { id: 'pdfs',         label: 'PDFs',         icon: '📄', match: (t) => t === 'pdf' },
  { id: 'spreadsheets', label: 'Spreadsheets', icon: '📊', match: (t) => t === 'spreadsheet' },
  { id: 'emails',       label: 'Emails',       icon: '✉️', match: (t) => t === 'email' },
  { id: 'images',       label: 'Images',       icon: '🖼️', match: (t) => t === 'image' },
  { id: 'code',         label: 'Code',         icon: '💻', match: (t) => t === 'code' },
  { id: 'links',        label: 'Links',        icon: '🔗', match: (t) => t === 'url' },
]

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [projectTitle, setProjectTitle] = useState('')
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [customCollections, setCustomCollections] = useState<CustomCollection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ingesting, setIngesting] = useState(false)
  const [ingestStatus, setIngestStatus] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadProject = () => {
    if (!projectId) return
    setLoading(true)
    Promise.all([
      bridge.readNode(projectId),
      bridge.listWorkspaces({}),
    ])
      .then(([node, list]) => {
        setProjectTitle(node.draft?.title ?? projectId)
        const collections: CustomCollection[] = []
        const projectAssets: AssetItem[] = []
        for (const it of list.items) {
          if (it.type === 'project') continue
          let jsonld: { projectId?: string; collectionId?: string | null; name?: string } = {}
          try { jsonld = JSON.parse(it.jsonld ?? '{}') } catch { /* ignore */ }
          if (jsonld.projectId !== projectId) continue
          if (it.type === 'collection') {
            collections.push({
              id: it.id,
              name: it.title ?? jsonld.name ?? 'Untitled collection',
              updatedAtUtc: it.updatedAtUtc,
            })
          } else {
            projectAssets.push({
              id: it.id,
              type: it.type,
              title: it.title ?? it.id.slice(0, 8),
              updatedAtUtc: it.updatedAtUtc,
              collectionId: jsonld.collectionId ?? null,
            })
          }
        }
        setCustomCollections(collections)
        setAssets(projectAssets)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load project'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadProject() }, [projectId])

  const bucketCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const b of TYPE_BUCKETS) counts[b.id] = 0
    for (const a of assets) {
      const b = TYPE_BUCKETS.find((x) => x.match(a.type))
      if (b) counts[b.id]++
    }
    return counts
  }, [assets])

  const customCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of customCollections) counts[c.id] = 0
    for (const a of assets) {
      if (a.collectionId && a.collectionId in counts) counts[a.collectionId]++
    }
    return counts
  }, [assets, customCollections])

  const ingestFile = async (file: File, targetCollectionId: string | null = null) => {
    if (!projectId) return
    setIngestStatus(`Extracting ${file.name}...`)
    try {
      const result = await runOnWorkQueue(
        `Extracting ${file.name}`,
        () => processFileInWorker(file),
      )

      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      let nodeType = 'note'
      if (ext === 'pdf') nodeType = 'pdf'
      else if (['pptx', 'ppt'].includes(ext)) nodeType = 'slides'
      else if (['docx', 'doc'].includes(ext)) nodeType = 'docx'
      else if (['xlsx', 'xls', 'csv'].includes(ext)) nodeType = 'spreadsheet'
      else if (ext === 'msg') nodeType = 'email'
      else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) nodeType = 'image'
      else if (
        [
          'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
          'py', 'rs', 'go', 'java', 'cs',
          'cpp', 'cc', 'cxx', 'c', 'h', 'hpp',
          'rb', 'php', 'kt', 'swift', 'scala', 'lua',
          'sh', 'bash', 'zsh', 'ps1', 'psm1',
          'sql', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf',
          'json', 'xml', 'html', 'htm', 'css', 'scss', 'sass',
        ].includes(ext)
      ) nodeType = 'code'
      else if (['md', 'markdown', 'mdown'].includes(ext)) nodeType = 'note'
      else if (ext === 'txt') nodeType = 'note'

      type Chunk = { kind: string; inline?: unknown[]; image?: { dataUrl: string; name: string } }

      let imageOcrText: string | undefined
      let bodyMd: string
      if (result.kind === 'image') {
        setIngestStatus(`Reading text from ${file.name}...`)
        try {
          const ocr = await bridge.llmExtractImageText({
            dataUrl: result.dataUrl,
            filename: file.name,
          })
          if (ocr.text && ocr.text.trim().length > 0) {
            imageOcrText = ocr.text
          } else if (ocr.skipReason) {
            console.info('[ingest-image] OCR skipped:', ocr.skipReason)
          }
        } catch (e) {
          console.warn('[ingest-image] OCR call failed:', e)
        }

        const blocks: unknown[] = [
          { type: 'image', props: { url: result.dataUrl, caption: file.name } },
        ]
        if (imageOcrText) {
          for (const para of imageOcrText.split(/\n{2,}/)) {
            const trimmed = para.trim()
            if (!trimmed) continue
            blocks.push({
              type: 'paragraph',
              content: [{ type: 'text', text: trimmed }],
            })
          }
        }
        bodyMd = JSON.stringify({ blocks })
      } else {
        bodyMd = JSON.stringify({
          blocks: (result.chunks ?? [] as Chunk[]).map((c: Chunk) => {
            if (c.kind === 'image' && c.image) {
              return { type: 'image', props: { url: c.image.dataUrl, caption: c.image.name } }
            }
            return { type: 'paragraph', content: c.inline ?? [] }
          }),
        })
      }

      setIngestStatus(`Indexing ${file.name}...`)
      const res = await bridge.upsertDraftNode({
        type: nodeType,
        title: file.name,
        bodyMd,
        jsonld: JSON.stringify({
          '@type': nodeType,
          name: file.name,
          projectId,
          collectionId: targetCollectionId,
          source: file.name,
          ...(imageOcrText ? { extractedText: imageOcrText } : {}),
        }),
      })
      await bridge.promoteDraft(res.draftId, '')
      setIngestStatus(`Done: ${file.name}`)
      loadProject()
    } catch (e) {
      setIngestStatus(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const ingestUrl = async () => {
    const url = urlInput.trim()
    if (!url || !projectId) return
    setIngesting(true)
    setIngestStatus(`Fetching ${url}...`)
    try {
      const result = await bridge.ingestUrl({ projectId, url })
      setIngestStatus(`Indexed: ${result.title ?? url}`)
      setUrlInput('')
      loadProject()
    } catch (e) {
      setIngestStatus(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setIngesting(false)
    }
  }

  const createCollection = async () => {
    const name = newCollectionName.trim()
    if (!name || !projectId) return
    try {
      const res = await bridge.upsertDraftNode({
        type: 'collection',
        title: name,
        bodyMd: JSON.stringify({ name, blocks: [] }, null, 2),
        jsonld: JSON.stringify({ '@type': 'Collection', name, projectId }),
      })
      await bridge.promoteDraft(res.draftId, '')
      setNewCollectionName('')
      loadProject()
    } catch (e) {
      setIngestStatus(`Collection create failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDropActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    setIngesting(true)
    void Promise.all(files.map((f) => ingestFile(f, null))).finally(() => setIngesting(false))
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setIngesting(true)
    void Promise.all(files.map((f) => ingestFile(f, null))).finally(() => setIngesting(false))
    e.target.value = ''
  }

  const assignAssetToCollection = async (assetId: string, targetCollectionId: string | null) => {
    try {
      const node = await bridge.readNode(assetId)
      let jsonld: Record<string, unknown> = {}
      try { jsonld = JSON.parse(node.draft?.jsonld ?? '{}') } catch { /* ignore */ }
      jsonld.collectionId = targetCollectionId
      await bridge.upsertDraftNode({
        id: assetId,
        type: node.draft?.type ?? 'note',
        title: node.draft?.title ?? assetId.slice(0, 8),
        bodyMd: node.draft?.bodyMd ?? '',
        jsonld: JSON.stringify(jsonld),
      })
      loadProject()
    } catch (e) {
      setIngestStatus(`Reassign failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const handleCollectionDrop = async (
    e: React.DragEvent<HTMLLIElement>,
    targetCollectionId: string | null,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const assetId = e.dataTransfer.getData('application/x-chunky-asset')
    const files = Array.from(e.dataTransfer.files)
    if (assetId) {
      setIngestStatus(`Moving asset...`)
      await assignAssetToCollection(assetId, targetCollectionId)
      setIngestStatus('Moved.')
      return
    }
    if (files.length > 0) {
      setIngesting(true)
      try {
        await Promise.all(files.map((f) => ingestFile(f, targetCollectionId)))
      } finally {
        setIngesting(false)
      }
    }
  }

  const totalAssets = assets.length

  return (
    <main className="page-project-detail">
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/projects">Projects</Link>
          <span> / </span>
          <span>{projectTitle}</span>
        </div>
        <div className="project-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate(`/projects/${projectId}/chat`)}
          >
            💬 Chat
          </button>
        </div>
      </div>

      <div
        className={`drop-zone${dropActive ? ' drop-zone--active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={handleDrop}
      >
        <p>Drop files here to add them to this project</p>
        <p className="drop-zone-types">
          PDF, DOCX / DOC, PPTX / PPT, XLSX / XLS, CSV, MSG (Outlook), MD, TXT,
          images (PNG, JPG, GIF, WEBP, BMP, SVG), code files
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          Browse files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileInput}
        />
      </div>

      <div className="url-import-row">
        <input
          type="url"
          placeholder="Paste a URL to import..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ingestUrl() }}
          className="input-url"
        />
        <button
          type="button"
          onClick={() => void ingestUrl()}
          disabled={ingesting || !urlInput.trim()}
          className="btn btn-primary"
        >
          Import
        </button>
      </div>

      {ingestStatus && <p className="ingest-status">{ingestStatus}</p>}
      {loading && <p className="status-loading">Loading collections...</p>}
      {error && <p className="status-error">{error}</p>}

      {!loading && (
        <>
          {totalAssets > 0 && (
            <>
              <h2 className="section-heading">By type</h2>
              <ul className="collection-grid">
                {TYPE_BUCKETS.filter((b) => bucketCounts[b.id] > 0).map((b) => (
                  <li
                    key={b.id}
                    className="collection-card"
                    onClick={() => navigate(`/projects/${projectId}/collections/type-${b.id}`)}
                  >
                    <span className="collection-card-icon">{b.icon}</span>
                    <span className="collection-card-name">{b.label}</span>
                    <span className="collection-card-count">{bucketCounts[b.id]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="section-heading-row">
            <h2 className="section-heading">Collections</h2>
          </div>
          <ul className="collection-grid">
            {customCollections.map((c) => (
              <li
                key={c.id}
                className={
                  'collection-card' + (dropTargetId === c.id ? ' collection-card--drop' : '')
                }
                onClick={() => navigate(`/projects/${projectId}/collections/${c.id}`)}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDropTargetId(c.id)
                }}
                onDragLeave={() => setDropTargetId((cur) => (cur === c.id ? null : cur))}
                onDrop={(e) => {
                  setDropTargetId(null)
                  void handleCollectionDrop(e, c.id)
                }}
              >
                <span className="collection-card-icon">📚</span>
                <span className="collection-card-name">{c.name}</span>
                <span className="collection-card-count">{customCounts[c.id] ?? 0}</span>
                <span className="collection-card-hint">drop files or assets</span>
              </li>
            ))}
            <li className="collection-card collection-card--new">
              <input
                type="text"
                placeholder="New collection name..."
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createCollection() }}
                className="collection-new-input"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!newCollectionName.trim()}
                onClick={() => void createCollection()}
              >
                Add
              </button>
            </li>
          </ul>

          {totalAssets === 0 && customCollections.length === 0 && (
            <div className="projects-splash projects-splash--sm">
              <img src="/chunky.png" alt="Chunky" className="projects-splash-img" />
              <p className="projects-splash-hint">Drop files, paste a URL, or create a collection above.</p>
            </div>
          )}
        </>
      )}
    </main>
  )
}
