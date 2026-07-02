// Full-screen preview of a generated markdown document, used as the
// PM Spec export confirmation step. Renders the markdown with GFM
// extensions (tables, task lists, strikethrough, autolinks) plus an
// action bar so the user can copy to clipboard or save as .md
// straight from the preview instead of being handed a download with
// no idea what's inside.
//
// Kept dumb on purpose: takes a pre-built markdown string + a
// filename suggestion + an onClose callback. The export call sites
// (App.tsx HomeWorkPane, EpicEditor) build the markdown then mount
// this modal — the modal owns clipboard + download mechanics but
// not the markdown assembly itself.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './MarkdownPreviewModal.css'

interface MarkdownPreviewModalProps {
  /** The markdown body to render + offer for save/copy. */
  markdown: string
  /** Suggested filename WITHOUT extension; `.md` is appended. */
  filenameBase: string
  /** Window title shown in the modal header. */
  title?: string
  /** Called when the user closes the modal (X button, backdrop click, Esc). */
  onClose: () => void
  /** Called after a successful save with the suggested filename — lets the
   *  caller flash a status message. Optional. */
  onSaved?: (filename: string) => void
  /** Called after a successful copy. Optional. */
  onCopied?: () => void
}

export const MarkdownPreviewModal: React.FC<MarkdownPreviewModalProps> = ({
  markdown,
  filenameBase,
  title,
  onClose,
  onSaved,
  onCopied,
}) => {
  const [copiedFlash, setCopiedFlash] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [savedDocFlash, setSavedDocFlash] = useState(false)
  const renderedRef = useRef<HTMLElement>(null)

  const safeNameBase = useMemo(() => {
    return (
      filenameBase
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'document'
    )
  }, [filenameBase])
  const filename = `${safeNameBase}.md`
  const docxFilename = `${safeNameBase}.docx`
  const pdfFilename = `${safeNameBase}.pdf`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopiedFlash(true)
      setTimeout(() => setCopiedFlash(false), 1500)
      onCopied?.()
    } catch (e) {
      console.warn('[md-preview] clipboard.writeText failed', e)
    }
  }

  const triggerDownload = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const handleSave = () => {
    try {
      const blob = new Blob([markdown], {
        type: 'text/markdown;charset=utf-8',
      })
      triggerDownload(blob, filename)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
      onSaved?.(filename)
    } catch (e) {
      console.warn('[md-preview] anchor download failed', e)
    }
  }

  /**
   * Save the preview as a real `.docx`. Routes through
   * `markdownToDocxBytes` — the same entry point the SharePoint
   * sync upload uses — so the modal-saved file and the auto-synced
   * file are byte-for-byte identical for the same input. Previously
   * this captured `renderedRef.current.innerHTML` and called
   * `renderedHtmlToDocxBytes` directly, which meant the modal had
   * its own ReactMarkdown render with its own `urlTransform` config,
   * and fixes to the sync path (e.g. allowing
   * `data:application/octet-stream` images through) didn't apply
   * here — two paths drifted silently.
   */
  const handleSaveDoc = async () => {
    try {
      const { markdownToDocxBytes, DOCX_MIME } = await import(
        '../lib/export-doc'
      )
      const bytes = await markdownToDocxBytes(
        markdown,
        title ?? safeNameBase,
      )
      // Copy into a fresh ArrayBuffer because jszip returns a
      // Uint8Array view that may be backed by a SharedArrayBuffer in
      // some bundlings, which Blob rejects in strict environments.
      const blob = new Blob([bytes.slice().buffer], { type: DOCX_MIME })
      triggerDownload(blob, docxFilename)
      setSavedDocFlash(true)
      setTimeout(() => setSavedDocFlash(false), 1500)
      onSaved?.(docxFilename)
    } catch (e) {
      console.warn('[md-preview] docx save failed', e)
    }
  }

  /**
   * Save as PDF via the WebView's print pipeline. We clone the
   * rendered preview into a hidden iframe with a print stylesheet,
   * focus it, and call `window.print()` — the system print dialog
   * appears with "Microsoft Print to PDF" (Windows) / "Save as PDF"
   * (other platforms) preselectable. The user picks Save and ends up
   * with a vector PDF: selectable text, real tables, embedded images
   * at full resolution. No raster step, no extra dependency.
   *
   * The print dialog uses the iframe's `<title>` as the suggested
   * filename, so we set that to the PDF basename for a sensible
   * default in the Save dialog.
   */
  const handleSavePdf = () => {
    try {
      const rendered = renderedRef.current
      if (!rendered) return
      const printCss = `
        @page { size: A4; margin: 1.5cm; }
        html, body { margin: 0; padding: 0; }
        body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000; line-height: 1.5; }
        h1 { font-size: 22pt; font-weight: 700; margin: 0 0 12pt; border-bottom: 2pt solid #000; padding-bottom: 4pt; page-break-after: avoid; }
        h2 { font-size: 16pt; font-weight: 700; margin: 14pt 0 8pt; border-bottom: 1pt solid #999; padding-bottom: 2pt; page-break-after: avoid; }
        h3 { font-size: 13pt; font-weight: 700; margin: 12pt 0 6pt; page-break-after: avoid; }
        h4, h5, h6 { font-size: 11pt; font-weight: 700; margin: 10pt 0 4pt; page-break-after: avoid; }
        p { margin: 6pt 0; }
        ul, ol { margin: 6pt 0; padding-left: 24pt; }
        li { margin: 2pt 0; }
        blockquote { border-left: 3pt solid #888; padding-left: 8pt; color: #444; margin: 8pt 0; }
        code { font-family: Consolas, "Cascadia Code", monospace; font-size: 10pt; background: #f4f4f4; padding: 1pt 3pt; border: 1px solid #ddd; }
        pre { font-family: Consolas, "Cascadia Code", monospace; font-size: 10pt; background: #f4f4f4; border: 1px solid #ddd; padding: 6pt; page-break-inside: avoid; }
        pre code { background: transparent; border: 0; padding: 0; }
        table { border-collapse: collapse; margin: 8pt 0; width: 100%; page-break-inside: avoid; }
        th, td { border: 1px solid #888; padding: 4pt 6pt; vertical-align: top; }
        th { background: #eee; font-weight: 700; text-align: left; }
        img { max-width: 100%; height: auto; page-break-inside: avoid; }
        a { color: #06c; text-decoration: underline; }
        hr { border: 0; border-top: 1pt solid #888; margin: 12pt 0; }
      `
      const docHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${safeNameBase}</title>
<style>${printCss}</style>
</head>
<body>${rendered.innerHTML}</body>
</html>`
      const iframe = document.createElement('iframe')
      iframe.setAttribute('aria-hidden', 'true')
      iframe.style.position = 'fixed'
      iframe.style.right = '-10000px'
      iframe.style.bottom = '-10000px'
      iframe.style.width = '816px'
      iframe.style.height = '1056px'
      iframe.style.border = '0'
      // `srcdoc` runs as same-origin so contentWindow.print() works.
      iframe.srcdoc = docHtml
      document.body.appendChild(iframe)
      const cleanup = () => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      }
      iframe.addEventListener('load', () => {
        try {
          iframe.contentWindow?.focus()
          iframe.contentWindow?.print()
          // Notify the caller that an export was kicked off — we
          // can't observe whether the user actually picked "Save as
          // PDF" vs cancelled, so the status message is best-effort.
          onSaved?.(pdfFilename)
        } catch (e) {
          console.warn('[md-preview] print invoke failed', e)
        }
        // Leave the iframe around long enough for WebView2's print
        // pipeline to finish reading its content, then remove it.
        setTimeout(cleanup, 60_000)
      })
    } catch (e) {
      console.warn('[md-preview] pdf save failed', e)
    }
  }

  return (
    <div
      className="md-preview-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Markdown preview'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="md-preview-modal">
        <header className="md-preview-header">
          <h2 className="md-preview-title">{title ?? 'Preview'}</h2>
          <div className="md-preview-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCopy}
              title="Copy the markdown source to the clipboard"
            >
              {copiedFlash ? '✓ Copied' : 'Copy markdown'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleSavePdf}
              title={`Open the system print dialog to save ${pdfFilename}`}
            >
              Save PDF
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleSaveDoc}
              title={`Download as ${docxFilename} (opens in Word)`}
            >
              {savedDocFlash ? '✓ Saved' : 'Save DOCX'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              title={`Download as ${filename}`}
            >
              {savedFlash ? '✓ Saved' : 'Save MD'}
            </button>
            <button
              type="button"
              className="md-preview-close"
              aria-label="Close preview"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        <div className="md-preview-body">
          <article ref={renderedRef} className="md-preview-rendered">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              // react-markdown's default `urlTransform` blocks `data:`
              // URLs as a defence against XSS via `<a href="data:…">`.
              // Allow any `data:` on an `src` through — BlockNote
              // labels pasted images as `data:application/octet-stream`
              // even when the bytes are a real JPEG/PNG, so the
              // stricter `data:image/` filter dropped them. Since
              // this exporter builds its OWN markdown out of the
              // user's own editor contents (no external input), the
              // permissive policy is safe. Regular `href` attrs
              // still go through the default gate.
              urlTransform={(url, key) =>
                key === 'src' && url.startsWith('data:')
                  ? url
                  : defaultUrlTransform(url, key)
              }
            >
              {markdown}
            </ReactMarkdown>
          </article>
        </div>
        <footer className="md-preview-footer">
          <span className="md-preview-stats">
            {markdown.length.toLocaleString()} chars ·{' '}
            {markdown.split(/\n/).length.toLocaleString()} lines
          </span>
          <span className="md-preview-hint">Esc to close</span>
        </footer>
      </div>
    </div>
  )
}

export default MarkdownPreviewModal
