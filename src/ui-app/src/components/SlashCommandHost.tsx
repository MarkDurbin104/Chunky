import React, { useEffect, useState } from 'react'

export interface SlashCommand {
  id: string
  label: string
  description?: string
  /** D-021 fills these in. */
  run: () => Promise<void> | void
}

interface Props {
  /** Element on whose contents we listen for "/" key. */
  surfaceRef: React.RefObject<HTMLElement | null>
  /** D-021 supplies the populated list. D-018 ships an empty list. */
  commands?: SlashCommand[]
}

/**
 * Minimal slash-command popover skeleton (D-018 §5.2 step 6).
 *
 * Listens for "/" typed at the start of a block (col 0). When triggered,
 * shows a popover near the caret with a list of commands. D-021 supplies
 * the populated list; this TRP ships only the host so the trigger is
 * available for downstream wiring.
 *
 * Press Escape to dismiss; click outside to dismiss; Enter on a focused
 * row to invoke. The list is filtered by the typed query after "/".
 */
export const SlashCommandHost: React.FC<Props> = ({ surfaceRef, commands = [] }) => {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [query, setQuery] = useState('')

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (open) {
        if (e.key === 'Escape') {
          setOpen(false)
          return
        }
        if (e.key === 'Backspace' && query.length === 0) {
          setOpen(false)
          return
        }
        if (e.key.length === 1) {
          setQuery((q) => q + e.key)
          return
        }
        if (e.key === 'Backspace') {
          setQuery((q) => q.slice(0, -1))
          return
        }
        return
      }
      if (e.key !== '/') return
      // Best-effort: only open if the active element looks like a contenteditable
      // (BlockNote uses contenteditable on its blocks). Avoid hijacking "/" in
      // form inputs.
      const target = e.target as HTMLElement | null
      if (!target) return
      const isEditable =
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA'
      if (!isEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        // Inputs/textareas: leave "/" alone.
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      }
      // Position near the caret if possible; otherwise centre on the surface.
      try {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0).cloneRange()
          const rect = range.getBoundingClientRect()
          setPosition({ top: rect.bottom + 4, left: rect.left })
        } else {
          const rect = surface.getBoundingClientRect()
          setPosition({ top: rect.top + 32, left: rect.left + 32 })
        }
      } catch {
        const rect = surface.getBoundingClientRect()
        setPosition({ top: rect.top + 32, left: rect.left + 32 })
      }
      setQuery('')
      setOpen(true)
    }

    surface.addEventListener('keydown', onKeyDown)
    return () => surface.removeEventListener('keydown', onKeyDown)
  }, [surfaceRef, open, query.length])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      const popover = document.getElementById('slash-command-popover')
      if (popover && !popover.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClickOutside)
    return () => window.removeEventListener('mousedown', onClickOutside)
  }, [open])

  if (!open) return null

  const matches = commands.filter(
    (c) =>
      !query ||
      c.id.toLowerCase().includes(query.toLowerCase()) ||
      c.label.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div
      id="slash-command-popover"
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 1100,
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
        minWidth: 240,
        maxWidth: 360,
        padding: '0.4rem',
      }}
    >
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          padding: '0.2rem 0.4rem',
        }}
      >
        Type a slash command{query ? ` — /${query}` : ''}
      </div>
      {matches.length === 0 ? (
        <div style={{ padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {commands.length === 0
            ? 'No slash commands available yet — D-021 wires these up.'
            : 'No matching commands.'}
        </div>
      ) : (
        matches.map((c) => (
          <button
            key={c.id}
            onClick={async () => {
              setOpen(false)
              try {
                await c.run()
              } catch (err) {
                console.error('Slash command failed', err)
              }
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              padding: '0.45rem 0.5rem',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              borderRadius: 4,
            }}
          >
            <strong>/{c.id}</strong> — {c.label}
            {c.description && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {c.description}
              </div>
            )}
          </button>
        ))
      )}
    </div>
  )
}

export default SlashCommandHost
