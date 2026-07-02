import React, { useEffect, useState } from 'react'

interface Props {
  open: boolean
  title: string
  placeholder?: string
  onClose: () => void
  onSubmit: (text: string) => void
}

/**
 * Small inline prompt for slash commands that need free-text args
 * (e.g. /draft, /ask). One-line input + Submit/Cancel.
 */
export const SlashArgPrompt: React.FC<Props> = ({
  open,
  title,
  placeholder,
  onClose,
  onSubmit,
}) => {
  const [text, setText] = useState('')

  useEffect(() => {
    if (open) setText('')
  }, [open])

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
        zIndex: 1150,
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
          width: 'min(520px, 92vw)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        }}
      >
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              onSubmit(text.trim())
            }
          }}
          style={{ width: '100%', padding: '0.5rem' }}
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
            Cancel
          </button>
          <button
            onClick={() => text.trim() && onSubmit(text.trim())}
            className="btn btn-primary"
            disabled={!text.trim()}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}

export default SlashArgPrompt
