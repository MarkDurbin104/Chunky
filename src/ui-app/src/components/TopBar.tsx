/**
 * Contextual top bar that sits at the head of every route.
 *
 * Props:
 *   title    — primary page heading (always required)
 *   sub      — small subline (e.g. "First PI · 2 epics")
 *   back     — label for the back button (omit to hide). Renders the
 *              chevron-left icon.
 *   onBack   — callback for the back button
 *   actions  — node rendered right-aligned in the bar (buttons, pills…)
 */
import type { ReactNode } from 'react'
import { Icon } from './Icon'

interface TopBarProps {
  title: ReactNode
  sub?: ReactNode
  back?: string
  onBack?: () => void
  actions?: ReactNode
}

export function TopBar({ title, sub, back, onBack, actions }: TopBarProps) {
  return (
    <header className="topbar">
      {back && (
        <button type="button" className="topbar-back" onClick={onBack}>
          <Icon name="back" />
          {back}
        </button>
      )}
      <div className="topbar-titles">
        <div className="topbar-title">{title}</div>
        {sub && <div className="topbar-sub">{sub}</div>}
      </div>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  )
}
