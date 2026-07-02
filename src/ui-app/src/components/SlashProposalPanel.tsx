import React, { useEffect, useState } from 'react'

interface Props {
  open: boolean
  /** Title shown in the panel header (typically "Result of /<command>"). */
  title: string
  /** Initial text shown to the user. They can edit before accepting. */
  initialText: string
  /** Whether accepting should replace the prior selection vs insert at cursor. */
  replaceSelection: boolean
  /** Show a banner when the LLM call is in flight. */
  loading?: boolean
  /** Render an error message. */
  error?: string | null
  onClose: () => void
  onAccept: (finalText: string, mode: 'replace' | 'insert') => void
}

/**
 * D-021 proposal panel.
 *
 * The agent never auto-inserts. After an LLM call, this panel surfaces
 * the result with three actions:
 *   - Accept: insert at cursor (or replace selection, depending on
 *     `replaceSelection`).
 *   - Edit: textarea is editable; user tweaks and then accepts.
 *   - Reject: dismiss without changing the document.
 */
export const SlashProposalPanel: React.FC<Props> = ({
  open,
  title,
  initialText,
  replaceSelection,
  loading = false,
  error = null,
  onClose,
  onAccept,
}) => {
  const [text, setText] = useState(initialText)

  useEffect(() => {
    if (open) setText(initialText)
  }, [open, initialText])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          color: 'var(--text-primary)',
          borderRadius: 8,
          padding: '1.25rem 1.5rem',
          width: 'min(720px, 92vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.5rem',
          }}
        >
          <h3 style={{ margin: 0 }}>{title}</h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {replaceSelection ? 'Replaces the selection on Accept' : 'Inserts at the cursor on Accept'}
          </span>
        </div>

        {loading && (
          <div
            style={{
              padding: '0.75rem',
              background: 'var(--surface-2, #f5f5f5)',
              borderRadius: 6,
              fontSize: '0.9rem',
              marginBottom: '0.5rem',
            }}
          >
            Thinking… (LLM is generating the proposal)
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--danger-soft, #ffe5e5)',
              color: 'var(--danger, #c33)',
              border: '1px solid var(--danger, #c33)',
              borderRadius: 6,
              fontSize: '0.9rem',
              marginBottom: '0.5rem',
            }}
          >
            {error}
          </div>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="(empty proposal)"
          rows={14}
          style={{
            width: '100%',
            padding: '0.6rem',
            fontFamily: 'inherit',
            fontSize: '0.95rem',
            resize: 'vertical',
            flex: 1,
          }}
          disabled={loading}
        />

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            marginTop: '0.75rem',
          }}
        >
          <button onClick={onClose} className="btn btn-secondary">
            Reject
          </button>
          <button
            onClick={() => onAccept(text, replaceSelection ? 'replace' : 'insert')}
            className="btn btn-primary"
            disabled={loading || !text.trim()}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}

export default SlashProposalPanel
