import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  applyTheme,
  readPersistedTheme,
  THEME_CHANGE_EVENT,
  type ThemeMode,
} from '../lib/theme'
import './Sidebar.css'

export function Sidebar() {
  const navigate = useNavigate()
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readPersistedTheme())

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: ThemeMode }>).detail
      if (detail?.mode) setThemeMode(detail.mode)
    }
    window.addEventListener(THEME_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange)
  }, [])

  const pickTheme = (m: ThemeMode) => {
    setThemeMode(m)
    applyTheme(m)
  }

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand" onClick={() => navigate('/projects')} role="button" tabIndex={0}>
        <img src="/chunky-icon.png" alt="" className="sidebar-brand-icon" />
        <span className="sidebar-brand-name">Chunky</span>
      </div>

      <ul className="sidebar-nav">
        <li>
          <NavLink
            to="/projects"
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}
          >
            <span className="sidebar-link-icon">📁</span>
            Projects
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/browse"
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}
          >
            <span className="sidebar-link-icon">🔍</span>
            Browse
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/settings"
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}
          >
            <span className="sidebar-link-icon">⚙️</span>
            Settings
          </NavLink>
        </li>
      </ul>

      <div className="sidebar-foot">
        <div className="sidebar-theme" role="radiogroup" aria-label="Theme">
          {(['light', 'auto', 'dark'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={themeMode === m}
              className={'sidebar-theme-btn' + (themeMode === m ? ' on' : '')}
              onClick={() => pickTheme(m)}
              title={m === 'auto' ? 'Follow system' : m.charAt(0).toUpperCase() + m.slice(1)}
            >
              {m === 'light' ? '☀️' : m === 'dark' ? '🌙' : '🖥️'}
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
