import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { bridge } from '../bridge/client'
import '../styles/Projects.css'

interface AssetItem {
  id: string
  type: string
  title: string
  updatedAtUtc?: string
  collectionId?: string | null
}

const TYPE_BUCKETS: Record<string, { label: string; icon: string; match: (t: string) => boolean }> = {
  paragraphs:   { label: 'Paragraphs',   icon: '📓', match: (t) => t === 'note' },
  documents:    { label: 'Documents',    icon: '📝', match: (t) => t === 'docx' },
  slides:       { label: 'Slides',       icon: '📽️', match: (t) => t === 'slides' },
  pdfs:         { label: 'PDFs',         icon: '📄', match: (t) => t === 'pdf' },
  spreadsheets: { label: 'Spreadsheets', icon: '📊', match: (t) => t === 'spreadsheet' },
  emails:       { label: 'Emails',       icon: '✉️', match: (t) => t === 'email' },
  images:       { label: 'Images',       icon: '🖼️', match: (t) => t === 'image' },
  code:         { label: 'Code',         icon: '💻', match: (t) => t === 'code' },
  links:        { label: 'Links',        icon: '🔗', match: (t) => t === 'url' },
}

const typeIcon: Record<string, string> = {
  pdf: '📄',
  docx: '📝',
  slides: '📽️',
  spreadsheet: '📊',
  email: '✉️',
  image: '🖼️',
  url: '🔗',
  code: '💻',
  note: '📓',
}

export default function CollectionDetail() {
  const { projectId, collectionId } = useParams<{ projectId: string; collectionId: string }>()
  const navigate = useNavigate()
  const [projectTitle, setProjectTitle] = useState('')
  const [collectionTitle, setCollectionTitle] = useState('')
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [customCollections, setCustomCollections] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [railTargetId, setRailTargetId] = useState<string | 'none' | null>(null)

  const bucketKey = useMemo(
    () => (collectionId?.startsWith('type-') ? collectionId.slice(5) : null),
    [collectionId],
  )
  const bucket = bucketKey ? TYPE_BUCKETS[bucketKey] : null

  useEffect(() => {
    if (!projectId || !collectionId) return
    setLoading(true)
    Promise.all([
      bridge.readNode(projectId),
      bridge.listWorkspaces({}),
      bucket ? Promise.resolve(null) : bridge.readNode(collectionId).catch(() => null),
    ])
      .then(([projectNode, list, collectionNode]) => {
        setProjectTitle(projectNode.draft?.title ?? projectId)
        if (bucket) {
          setCollectionTitle(bucket.label)
        } else {
          setCollectionTitle(collectionNode?.draft?.title ?? 'Collection')
        }

        const customCols: { id: string; name: string }[] = []
        const inScope: AssetItem[] = []
        for (const it of list.items) {
          if (it.type === 'project') continue
          let jsonld: { projectId?: string; collectionId?: string | null; name?: string } = {}
          try { jsonld = JSON.parse(it.jsonld ?? '{}') } catch { /* ignore */ }
          if (jsonld.projectId !== projectId) continue
          if (it.type === 'collection') {
            customCols.push({ id: it.id, name: it.title ?? jsonld.name ?? 'Untitled collection' })
            continue
          }
          if (bucket && bucket.match(it.type)) {
            inScope.push({
              id: it.id,
              type: it.type,
              title: it.title ?? it.id.slice(0, 8),
              updatedAtUtc: it.updatedAtUtc,
              collectionId: jsonld.collectionId ?? null,
            })
          } else if (!bucket && jsonld.collectionId === collectionId) {
            inScope.push({
              id: it.id,
              type: it.type,
              title: it.title ?? it.id.slice(0, 8),
              updatedAtUtc: it.updatedAtUtc,
              collectionId: jsonld.collectionId ?? null,
            })
          }
        }
        setCustomCollections(customCols)
        setAssets(inScope)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load collection'))
      .finally(() => setLoading(false))
  }, [projectId, collectionId, bucket])

  const assignAssetIdToCollection = async (
    assetId: string,
    targetCollectionId: string | null,
  ) => {
    const asset = assets.find((a) => a.id === assetId)
    if (!asset) return
    await assignToCollection(asset, targetCollectionId)
  }

  const assignToCollection = async (asset: AssetItem, targetCollectionId: string | null) => {
    try {
      const node = await bridge.readNode(asset.id)
      let jsonld: Record<string, unknown> = {}
      try { jsonld = JSON.parse(node.draft?.jsonld ?? '{}') } catch { /* ignore */ }
      jsonld.collectionId = targetCollectionId
      await bridge.upsertDraftNode({
        id: asset.id,
        type: node.draft?.type ?? asset.type,
        title: node.draft?.title ?? asset.title,
        bodyMd: node.draft?.bodyMd ?? '',
        jsonld: JSON.stringify(jsonld),
      })
      setAssets((prev) =>
        bucket
          ? prev.map((a) => (a.id === asset.id ? { ...a, collectionId: targetCollectionId } : a))
          : prev.filter((a) => a.id !== asset.id),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign collection')
    }
  }

  const railDrop = async (
    e: React.DragEvent<HTMLLIElement>,
    targetCollectionId: string | null,
  ) => {
    e.preventDefault()
    setRailTargetId(null)
    const assetId = e.dataTransfer.getData('application/x-chunky-asset')
    if (assetId) {
      await assignAssetIdToCollection(assetId, targetCollectionId)
    }
  }

  return (
    <main className="page-project-detail">
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/projects">Projects</Link>
          <span> / </span>
          <Link to={`/projects/${projectId}`}>{projectTitle}</Link>
          <span> / </span>
          <span>{collectionTitle}</span>
        </div>
      </div>

      {(customCollections.length > 0 || assets.length > 0) && (
        <>
          <p className="collection-rail-hint">
            Drag any row onto a collection below to move it, or use the row dropdown.
          </p>
          <ul className="collection-rail">
            <li
              className={
                'collection-rail-item' +
                (railTargetId === 'none' ? ' collection-rail-item--drop' : '')
              }
              onDragOver={(e) => {
                e.preventDefault()
                setRailTargetId('none')
              }}
              onDragLeave={() => setRailTargetId((c) => (c === 'none' ? null : c))}
              onDrop={(e) => void railDrop(e, null)}
              title="Move asset to unassigned"
            >
              — unassigned —
            </li>
            {customCollections.map((c) => (
              <li
                key={c.id}
                className={
                  'collection-rail-item' +
                  (railTargetId === c.id ? ' collection-rail-item--drop' : '')
                }
                onDragOver={(e) => {
                  e.preventDefault()
                  setRailTargetId(c.id)
                }}
                onDragLeave={() => setRailTargetId((cur) => (cur === c.id ? null : cur))}
                onDrop={(e) => void railDrop(e, c.id)}
                title={`Move asset into "${c.name}"`}
              >
                📚 {c.name}
              </li>
            ))}
          </ul>
        </>
      )}

      {loading && <p className="status-loading">Loading collection...</p>}
      {error && <p className="status-error">{error}</p>}

      {!loading && assets.length === 0 && (
        <div className="projects-splash projects-splash--sm">
          <img src="/chunky.png" alt="Chunky" className="projects-splash-img" />
          <p className="projects-splash-hint">No assets in this collection yet.</p>
        </div>
      )}

      <ul className="asset-list">
        {assets.map((a) => (
          <li
            key={a.id}
            className="asset-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-chunky-asset', a.id)
              e.dataTransfer.setData('text/plain', a.title)
            }}
          >
            <span
              className="asset-icon"
              onClick={() => navigate(`/projects/${projectId}/assets/${a.id}`)}
            >
              {typeIcon[a.type] ?? '📎'}
            </span>
            <span
              className="asset-title"
              onClick={() => navigate(`/projects/${projectId}/assets/${a.id}`)}
            >
              {a.title}
            </span>
            <span className="asset-type">{a.type}</span>
            {a.updatedAtUtc && (
              <span className="asset-updated">
                {new Date(a.updatedAtUtc).toLocaleDateString()}
              </span>
            )}
            <select
              className="asset-assign-select"
              value={a.collectionId ?? ''}
              onChange={(e) => void assignToCollection(a, e.target.value || null)}
              onClick={(e) => e.stopPropagation()}
              title="Assign to collection"
            >
              <option value="">— unassigned —</option>
              {customCollections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </main>
  )
}
