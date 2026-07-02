import { useEffect } from 'react'
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import Browse from './pages/Browse'
import Settings from './pages/Settings'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import AssetViewer from './pages/AssetViewer'
import CollectionDetail from './pages/CollectionDetail'
import ProjectChat from './pages/ProjectChat'
import { applyTheme, readPersistedTheme, watchOsScheme, THEME_CHANGE_EVENT } from './lib/theme'
import { loadSettings } from './lib/llm-config'
import type { ThemeMode } from './lib/theme'
import './App.css'

applyTheme(readPersistedTheme())

export default function App() {
  useEffect(() => {
    let stopOs: (() => void) | undefined
    loadSettings().then((s) => {
      const mode = (s?.theme as ThemeMode | undefined) ?? 'system'
      applyTheme(mode)
      stopOs = watchOsScheme(mode)
    }).catch(() => {
      stopOs = watchOsScheme('system')
    })
    const onThemeChange = (e: Event) => {
      const mode = (e as CustomEvent<ThemeMode>).detail
      stopOs?.()
      stopOs = watchOsScheme(mode)
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
    return () => {
      stopOs?.()
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
    }
  }, [])

  return (
    <MantineProvider>
      <Router>
        <div className="app-shell">
          <Sidebar />
          <div className="app-content">
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:projectId" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/collections/:collectionId" element={<CollectionDetail />} />
                <Route path="/projects/:projectId/assets/:assetId" element={<AssetViewer />} />
                <Route path="/projects/:projectId/chat" element={<ProjectChat />} />
                <Route path="/browse" element={<Browse />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/projects" replace />} />
              </Routes>
            </ErrorBoundary>
          </div>
          <StatusBar />
        </div>
      </Router>
    </MantineProvider>
  )
}
