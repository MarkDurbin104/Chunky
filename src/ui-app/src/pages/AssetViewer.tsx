import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import '../styles/Projects.css'
import { bridge } from '../bridge/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface AssetNode {
  id: string
  type: string
  title: string
  bodyMd: string
  updatedAtUtc?: string
}

type ViewMode = 'rendered' | 'raw'

export default function AssetViewer() {
  const { projectId, assetId } = useParams<{ projectId: string; assetId: string }>()
  const [asset, setAsset] = useState<AssetNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [projectTitle, setProjectTitle] = useState('')

  useEffect(() => {
    if (!assetId || !projectId) return
    setLoading(true)
    Promise.all([
      bridge.readNode(assetId),
      bridge.readNode(projectId),
    ])
      .then(([node, proj]) => {
        setAsset({
          id: node.id,
          type: node.draft?.type ?? 'note',
          title: node.draft?.title ?? node.id.slice(0, 8),
          bodyMd: node.draft?.bodyMd ?? '',
          updatedAtUtc: node.updatedAtUtc,
        })
        setProjectTitle(proj.draft?.title ?? projectId)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load asset'))
      .finally(() => setLoading(false))
  }, [assetId, projectId])

  if (loading) {
    return (
      <main className="page-asset-viewer">
        <p className="status-loading">Loading asset…</p>
      </main>
    )
  }

  if (error || !asset) {
    return (
      <main className="page-asset-viewer">
        <p className="status-error">{error ?? 'Asset not found'}</p>
        <Link to={`/projects/${projectId}`}>Back to project</Link>
      </main>
    )
  }

  return (
    <main className="page-asset-viewer">
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/projects">Projects</Link>
          <span> / </span>
          <Link to={`/projects/${projectId}`}>{projectTitle}</Link>
          <span> / </span>
          <span>{asset.title}</span>
        </div>
        <div className="asset-view-actions">
          <span className="asset-type-badge">{asset.type}</span>
          {asset.updatedAtUtc && (
            <span className="asset-updated-label">
              {new Date(asset.updatedAtUtc).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <AssetBody asset={asset} viewMode={viewMode} onViewModeChange={setViewMode} />
    </main>
  )
}

function AssetBody({
  asset,
  viewMode,
  onViewModeChange,
}: {
  asset: AssetNode
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
}) {
  if (asset.type === 'image') {
    return <ImageAsset asset={asset} />
  }

  // Every non-image type uses the same block renderer path. PDF used to have
  // a "PDF-specific" heading label; keep that only for pdf, and fall through
  // to the generic TextAsset for docx / slides / spreadsheet / email / note /
  // code so images embedded during extraction render inline for all of them.
  if (asset.type === 'pdf') {
    return <PdfAsset asset={asset} viewMode={viewMode} onViewModeChange={onViewModeChange} />
  }

  return <TextAsset asset={asset} viewMode={viewMode} onViewModeChange={onViewModeChange} />
}

function ImageAsset({ asset }: { asset: AssetNode }) {
  const dataUrl = extractFirstImageUrl(asset.bodyMd)
  if (!dataUrl) {
    return <p className="status-error">No image data found in this asset.</p>
  }
  return (
    <div className="asset-image-wrapper">
      <img src={dataUrl} alt={asset.title} className="asset-image" />
    </div>
  )
}

function PdfAsset({
  asset,
  viewMode,
  onViewModeChange,
}: {
  asset: AssetNode
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
}) {
  return (
    <div className="asset-text-viewer">
      <div className="asset-toolbar">
        <button
          type="button"
          className={`btn btn-sm ${viewMode === 'rendered' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onViewModeChange('rendered')}
        >
          Extracted content
        </button>
        <button
          type="button"
          className={`btn btn-sm ${viewMode === 'raw' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onViewModeChange('raw')}
        >
          Raw JSON
        </button>
      </div>
      {viewMode === 'rendered' ? (
        <BlocksRenderer bodyMd={asset.bodyMd} />
      ) : (
        <pre className="asset-raw">{asset.bodyMd}</pre>
      )}
    </div>
  )
}

function TextAsset({
  asset,
  viewMode,
  onViewModeChange,
}: {
  asset: AssetNode
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
}) {
  const isCode = asset.type === 'code'

  return (
    <div className="asset-text-viewer">
      <div className="asset-toolbar">
        {!isCode && (
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'rendered' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onViewModeChange('rendered')}
          >
            Rendered
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${viewMode === 'raw' || isCode ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onViewModeChange('raw')}
        >
          {isCode ? 'Source' : 'Raw JSON'}
        </button>
      </div>

      {(viewMode === 'rendered' && !isCode) ? (
        <BlocksRenderer bodyMd={asset.bodyMd} />
      ) : (
        <pre className="asset-raw">{isCode ? extractPlainText(asset.bodyMd) : asset.bodyMd}</pre>
      )}
    </div>
  )
}

type ParagraphBlock = { type: 'paragraph'; content?: unknown }
type ImageBlock = {
  type: 'image'
  props?: { url?: string; caption?: string; previewWidth?: number }
}
type HeadingBlock = { type: 'heading'; content?: unknown; props?: { level?: number } }
type BulletBlock = { type: 'bulletListItem'; content?: unknown }
type NumberedBlock = { type: 'numberedListItem'; content?: unknown }
type CodeBlock = { type: 'codeBlock'; content?: unknown }
type Block =
  | ParagraphBlock
  | ImageBlock
  | HeadingBlock
  | BulletBlock
  | NumberedBlock
  | CodeBlock
  | { type: string; [k: string]: unknown }

function BlocksRenderer({ bodyMd }: { bodyMd: string }) {
  const blocks = parseBlocks(bodyMd)
  if (blocks.length === 0) {
    return <div className="asset-markdown"><p>No content.</p></div>
  }

  return (
    <div className="asset-markdown">
      {blocks.map((block, i) => {
        if (block.type === 'image') {
          const props = (block as ImageBlock).props ?? {}
          const url = normalizeImageDataUrl(props.url ?? '')
          if (!url) return null
          const caption = props.caption ?? ''
          return (
            <figure key={i} className="asset-figure">
              <img src={url} alt={caption} className="asset-inline-image" />
              {caption && <figcaption className="asset-figure-caption">{caption}</figcaption>}
            </figure>
          )
        }
        const text = inlineTextFrom(block as { content?: unknown })
        if (!text.trim()) return null
        if (block.type === 'heading') {
          const level = Math.min(6, Math.max(1, (block as HeadingBlock).props?.level ?? 2))
          const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements
          return <Tag key={i}>{text}</Tag>
        }
        if (block.type === 'bulletListItem') return <ul key={i}><li>{text}</li></ul>
        if (block.type === 'numberedListItem') return <ol key={i}><li>{text}</li></ol>
        if (block.type === 'codeBlock') return <pre key={i} className="asset-raw">{text}</pre>
        return (
          <div key={i} className="asset-md-block">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )
      })}
    </div>
  )
}

function parseBlocks(bodyMd: string): Block[] {
  if (!bodyMd) return []
  try {
    const parsed = JSON.parse(bodyMd) as { blocks?: Block[] }
    return Array.isArray(parsed.blocks) ? parsed.blocks : []
  } catch {
    return []
  }
}

function inlineTextFrom(block: { content?: unknown }): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    if (typeof c === 'string') parts.push(c)
    else if (c && typeof c === 'object') {
      const rec = c as Record<string, unknown>
      if (typeof rec.text === 'string') parts.push(rec.text)
    }
  }
  return parts.join('')
}

/** Data URLs saved with `application/octet-stream` still render if we sniff
 *  the base64 header and rewrite the mime. Small overhead, unlocks the
 *  DOCX/PPTX extractor output which occasionally mis-labels images. */
function normalizeImageDataUrl(url: string): string {
  if (!url.startsWith('data:')) return url
  if (!url.startsWith('data:application/octet-stream;base64,')) return url
  const b64 = url.slice('data:application/octet-stream;base64,'.length)
  const head = b64.slice(0, 16)
  let mime = 'image/png'
  if (head.startsWith('iVBOR')) mime = 'image/png'
  else if (head.startsWith('/9j/')) mime = 'image/jpeg'
  else if (head.startsWith('R0lGO')) mime = 'image/gif'
  else if (head.startsWith('UklGR')) mime = 'image/webp'
  else if (head.startsWith('PHN2Z') || head.startsWith('PD94b')) mime = 'image/svg+xml'
  return `data:${mime};base64,${b64}`
}

/** Concat all text blocks (used for `code` type raw-source view). */
function extractPlainText(bodyMd: string): string {
  const blocks = parseBlocks(bodyMd)
  return blocks
    .filter((b) => b.type !== 'image')
    .map((b) => inlineTextFrom(b as { content?: unknown }))
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
}

function extractFirstImageUrl(bodyMd: string): string | null {
  try {
    const parsed = JSON.parse(bodyMd) as { blocks?: Array<{ type: string; props?: { url?: string } }> }
    for (const block of parsed.blocks ?? []) {
      if (block.type === 'image' && block.props?.url) {
        return normalizeImageDataUrl(block.props.url)
      }
    }
  } catch {
    /* not JSON — no image */
  }
  return null
}
