import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppSettings,
  LlmUseConfig,
  LlmUseId,
  allSuppliers,
  defaultSettings,
  isVisionEligible,
  loadSettings,
  modelsForSupplier,
  saveSettings,
} from '../lib/llm-config'
import { bridge } from '../bridge/client'
import { PRESETS, SupplierPreset } from '../lib/llm-presets'
import '../styles/Settings.css'

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; httpStatus: number; detail?: string }
  | { kind: 'error'; message: string }

interface UseFormProps {
  useId: LlmUseId
  label: string
  hint: string
  value: LlmUseConfig
  settings: AppSettings
  onChange: (next: LlmUseConfig) => void
  onAddCustomSupplier: () => void
  onAddCustomModel: (supplierId: string, model: { id: string; label: string }) => void
  visionRequired: boolean
}

function UseForm({
  useId,
  label,
  hint,
  value,
  settings,
  onChange,
  onAddCustomSupplier,
  onAddCustomModel,
  visionRequired,
}: UseFormProps) {
  const suppliers = allSuppliers(settings)
  const supplier = suppliers.find((s) => s.id === value.supplier)
  const allModelsForSupplier = modelsForSupplier(settings, value.supplier)
  const visibleModels = visionRequired
    ? allModelsForSupplier.filter(
        (m) =>
          isVisionEligible(settings, value.supplier, m.id) || m.vision === true,
      )
    : allModelsForSupplier
  const apiKeyRequired = supplier?.apiKeyRequired ?? false
  const [showAddModel, setShowAddModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newModelLabel, setNewModelLabel] = useState('')
  const [test, setTest] = useState<TestStatus>({ kind: 'idle' })

  const onSupplierChange = (supplierId: string) => {
    const next = suppliers.find((s) => s.id === supplierId)
    if (!next) return
    const firstModel = (visionRequired
      ? next.models.filter((m) => m.vision)
      : next.models)[0]?.id ?? next.models[0]?.id ?? ''
    onChange({
      ...value,
      supplier: supplierId,
      model: firstModel,
      baseUrl: next.baseUrl,
      binaryPath: next.binaryPath,
      transport: next.transport ?? 'http',
    })
    setTest({ kind: 'idle' })
  }
  const transport = supplier?.transport ?? 'http'

  const handleTest = async () => {
    setTest({ kind: 'pending' })
    if (transport === 'cli') {
      // Real CLI ping — spawn `<binary> --version` host-side with a
      // 5s timeout. No tokens burned. Reports the version string
      // back so the user sees what their binary actually advertises,
      // or a precise error code (E_CLI_PING_SPAWN / _TIMEOUT / _EXIT)
      // when something is wrong with the install or PATH.
      const binary = value.binaryPath || supplier?.binaryPath || 'claude'
      try {
        const res = await bridge.llmCliPing({ binary })
        setTest({
          kind: 'ok',
          httpStatus: 0,
          detail: `${res.binary} → ${res.version} (${res.durationMs} ms)`,
        })
      } catch (err) {
        setTest({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    try {
      // HEAD/GET against the base URL — never send a payload that would
      // burn tokens. The endpoint may not advertise CORS in the webview;
      // a network/CORS failure is still useful signal.
      const url = supplier?.id === 'ollama' || supplier?.id === 'vllm'
        ? `${value.baseUrl.replace(/\/+$/, '')}/models`
        : value.baseUrl
      const res = await fetch(url, { method: 'GET', mode: 'cors' })
      setTest({ kind: 'ok', httpStatus: res.status })
    } catch (err) {
      setTest({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <section className="llm-section">
      <header className="llm-section-header">
        <h2>{label}</h2>
        <p>{hint}</p>
      </header>

      <div className="llm-grid">
        <label>
          Supplier
          <div className="llm-row">
            <select
              value={value.supplier}
              onChange={(e) => onSupplierChange(e.target.value)}
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-link"
              onClick={onAddCustomSupplier}
              title="Add a supplier with a custom base URL and model list"
            >
              + Add custom supplier
            </button>
          </div>
        </label>

        <label>
          Model
          <div className="llm-row">
            <select
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
            >
              {visibleModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.id})
                  {visionRequired && !m.vision ? ' — non-vision' : ''}
                </option>
              ))}
              {visibleModels.length === 0 && (
                <option value="">(no models — add one)</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setShowAddModel((v) => !v)}
            >
              + Add custom model
            </button>
          </div>
          {showAddModel && (
            <div className="llm-add-model">
              <input
                type="text"
                placeholder="model id (e.g. gpt-5-preview)"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
              />
              <input
                type="text"
                placeholder="label (optional)"
                value={newModelLabel}
                onChange={(e) => setNewModelLabel(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const id = newModelId.trim()
                  if (!id) return
                  onAddCustomModel(value.supplier, {
                    id,
                    label: newModelLabel.trim() || id,
                  })
                  onChange({ ...value, model: id })
                  setShowAddModel(false)
                  setNewModelId('')
                  setNewModelLabel('')
                }}
              >
                Add
              </button>
            </div>
          )}
        </label>

        {transport === 'cli' ? (
          <label>
            CLI binary path
            <input
              type="text"
              value={value.binaryPath ?? supplier?.binaryPath ?? ''}
              onChange={(e) =>
                onChange({ ...value, binaryPath: e.target.value })
              }
              placeholder="claude"
              spellCheck={false}
            />
            <span className="llm-hint">
              Resolved on PATH. Auth is handled by the CLI itself — no API key
              needed at the host. The subprocess invocation lands in D-014.
            </span>
          </label>
        ) : (
          <label>
            Base URL
            <input
              type="url"
              value={value.baseUrl}
              onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </label>
        )}

        {apiKeyRequired && transport === 'http' && (
          <label>
            API key
            <input
              type="password"
              placeholder="sk-…  (saved to OS keychain — round 2)"
              disabled
            />
            <span className="llm-hint">
              Round 1 stub: the keychain integration ships in D-014. For now,
              a key set here is not persisted; the use will remain inactive.
            </span>
          </label>
        )}

        <label>
          Temperature
          <input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={value.temperature ?? (useId === 'imageTextExtraction' ? 0 : 0.2)}
            onChange={(e) =>
              onChange({
                ...value,
                temperature: Number.isNaN(parseFloat(e.target.value))
                  ? 0
                  : parseFloat(e.target.value),
              })
            }
          />
        </label>
      </div>

      <div className="llm-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleTest}
          disabled={transport === 'http' && !value.baseUrl}
        >
          {transport === 'cli' ? 'Test CLI binary' : 'Test connection'}
        </button>
        {test.kind === 'pending' && <span className="llm-test-pending">Testing…</span>}
        {test.kind === 'ok' && (
          <span className="llm-test-ok">
            {test.detail
              ? `Reachable — ${test.detail}`
              : `Reachable (HTTP ${test.httpStatus})`}
          </span>
        )}
        {test.kind === 'error' && (
          <span className="llm-test-err">Failed: {test.message}</span>
        )}
      </div>

      {apiKeyRequired && transport === 'http' && (
        <div className="llm-warning">
          ⚠ This LLM is not yet active — set an API key (deferred to D-014) to enable calls.
        </div>
      )}
      {transport === 'cli' && (
        <div className="llm-warning llm-info">
          ℹ CLI sidecar mode: the host invokes the binary as a subprocess and
          relies on whatever auth the CLI is already configured with. Useful
          when the operator has Claude Code installed but no separate
          Anthropic API key.
        </div>
      )}
    </section>
  )
}

// ── Atlassian settings section ────────────────────────────────────────────────

function AtlassianSettingsSection() {
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'testing' | 'ok' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    bridge.atlassianGetSettings().then((s: any) => {
      const atl = s.settings ?? {}
      setBaseUrl(atl.baseUrl ?? '')
      setEmail(atl.email ?? '')
      setApiToken(atl.apiToken ?? '')
    }).catch(() => {})
  }, [])

  const handleSave = async () => {
    setStatus('saving')
    try {
      await bridge.atlassianSetSettings({ settings: { baseUrl: baseUrl.trim(), email: email.trim(), apiToken: apiToken.trim() } })
      setStatus('saved')
      setMsg('Saved')
      setTimeout(() => setStatus('idle'), 2000)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const handleTest = async () => {
    setStatus('testing')
    setMsg('')
    try {
      const res = await bridge.atlassianDiagnose(baseUrl.trim())
      setStatus('ok')
      setMsg(`Connected as: ${res.displayName}`)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="llm-section">
      <div className="llm-section-header">
        <h2>Atlassian</h2>
        <p>
          Connect to Jira and Confluence using an API token.{' '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
            Generate a token here
          </a>{' '}
          (Atlassian account settings → Security → API tokens).
        </p>
      </div>
      <div className="llm-grid">
        <label>
          Domain
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="yourcompany.atlassian.net"
            spellCheck={false}
          />
        </label>
        <label>
          Account email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourcompany.com"
            spellCheck={false}
          />
        </label>
        <label>
          API token
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Paste your Atlassian API token"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="llm-actions">
        <button type="button" className="btn btn-secondary" onClick={handleTest}
          disabled={!baseUrl.trim() || !apiToken.trim() || status === 'testing'}>
          {status === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave}
          disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'ok' && <span className="llm-test-ok">{msg}</span>}
        {status === 'saved' && <span className="llm-test-ok">{msg}</span>}
        {status === 'error' && <span className="llm-test-err">{msg}</span>}
      </div>
    </section>
  )
}

// ── Microsoft 365 settings section ───────────────────────────────────────────
//
// Device-code OAuth: the user clicks "Sign in", we call
// `microsoftBeginSignIn` to get a user code + verification URL, the
// user enters that code at https://microsoft.com/devicelogin, and we
// poll `microsoftPollSignIn` until completion. The Rust side stores
// the refresh token; from then on `isSignedIn` is true on reload.

function MicrosoftSettingsSection() {
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [syncPath, setSyncPath] = useState('')
  const [signedInAs, setSignedInAs] = useState<{
    display: string
    upn: string
  } | null>(null)
  const [status, setStatus] = useState<
    'idle' | 'saving' | 'saved' | 'pending' | 'complete' | 'error'
  >('idle')
  const [msg, setMsg] = useState('')
  // Active device-code state — set when sign-in is in flight, cleared
  // on success / cancel / error.
  const [deviceFlow, setDeviceFlow] = useState<{
    userCode: string
    verificationUri: string
    deviceCode: string
    message: string
  } | null>(null)
  const pollHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    bridge
      .microsoftGetSettings()
      .then(({ settings }) => {
        setTenantId(settings.tenantId ?? '')
        setClientId(settings.clientId ?? '')
        // Pre-fill the input with the effective value so first-run
        // users see (and can save) the default path without having
        // to type it. They can edit freely from there.
        setSyncPath(settings.syncPath || settings.effectiveSyncPath || '')
        setSignedInAs(
          settings.isSignedIn
            ? {
                display: settings.userDisplayName,
                upn: settings.userPrincipalName,
              }
            : null,
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    return () => {
      if (pollHandleRef.current) clearTimeout(pollHandleRef.current)
    }
  }, [load])

  const handleSave = async () => {
    setStatus('saving')
    try {
      await bridge.microsoftSetSettings({
        settings: {
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          syncPath: syncPath.trim(),
        },
      })
      setStatus('saved')
      setMsg('Saved')
      setTimeout(() => setStatus('idle'), 2000)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Primary sign-in path: PKCE / authorization-code in a popup
   * WebView2 window. The Rust command awaits the entire round-trip
   * (open window → user signs in → intercept callback → exchange
   * code → persist tokens) and resolves with the profile, so JS is
   * a single await — no polling, no copy/paste code.
   */
  const handleSignIn = async () => {
    setStatus('pending')
    setMsg('Opening sign-in window…')
    try {
      const result = await bridge.microsoftBeginPopupSignIn()
      setSignedInAs({
        display: result.userDisplayName,
        upn: result.userPrincipalName,
      })
      setStatus('complete')
      setMsg(`Signed in as ${result.userDisplayName}`)
      setTimeout(() => setStatus('idle'), 2500)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Fallback sign-in path: OAuth 2.0 device-code flow. The user
   * copies a code into a browser at microsoft.com/devicelogin while
   * we poll the token endpoint. Slower and clunkier than the popup
   * but works on platforms where the WebView2 nav hook isn't wired
   * (non-Windows) or in corp networks where popups are blocked.
   */
  const handleSignInDeviceCode = async () => {
    setStatus('pending')
    setMsg('')
    try {
      const dc = await bridge.microsoftBeginSignIn()
      setDeviceFlow({
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        deviceCode: dc.deviceCode,
        message: dc.message,
      })
      const poll = async () => {
        try {
          const result = await bridge.microsoftPollSignIn(dc.deviceCode)
          if (result.status === 'complete') {
            setSignedInAs({
              display: result.userDisplayName,
              upn: result.userPrincipalName,
            })
            setDeviceFlow(null)
            setStatus('complete')
            setMsg(`Signed in as ${result.userDisplayName}`)
            setTimeout(() => setStatus('idle'), 2500)
            return
          }
          pollHandleRef.current = setTimeout(poll, (dc.interval || 5) * 1000)
        } catch (e) {
          setDeviceFlow(null)
          setStatus('error')
          setMsg(e instanceof Error ? e.message : String(e))
        }
      }
      pollHandleRef.current = setTimeout(poll, (dc.interval || 5) * 1000)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const handleCancelSignIn = () => {
    if (pollHandleRef.current) {
      clearTimeout(pollHandleRef.current)
      pollHandleRef.current = null
    }
    setDeviceFlow(null)
    setStatus('idle')
    setMsg('')
  }

  const handleSignOut = async () => {
    try {
      await bridge.microsoftSignOut()
      setSignedInAs(null)
      setStatus('idle')
      setMsg('')
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const handleCopyCode = async () => {
    if (!deviceFlow) return
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode)
    } catch {
      /* clipboard may be unavailable in some webview configs */
    }
  }

  return (
    <section className="llm-section">
      <div className="llm-section-header">
        <h2>Microsoft 365</h2>
        <p>
          Sign in with your corporate Microsoft account to upload PM
          specifications to SharePoint. Uses OAuth 2.0 device-code flow —
          no API token to manage. Sign-in stays valid until you sign out
          or your tenant revokes the token.
        </p>
      </div>
      {signedInAs ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 1rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            marginBottom: '0.75rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>
              {signedInAs.display}
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
              }}
            >
              {signedInAs.upn}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      ) : deviceFlow ? (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--accent-primary)',
            borderRadius: 6,
            marginBottom: '0.75rem',
          }}
        >
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.9rem' }}>
            1. Visit{' '}
            <a
              href={deviceFlow.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              {deviceFlow.verificationUri}
            </a>
          </p>
          <p style={{ margin: '0 0 0.4rem', fontSize: '0.9rem' }}>
            2. Enter this code:
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <code
              style={{
                fontSize: '1.4rem',
                fontWeight: 700,
                padding: '0.4rem 0.8rem',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                borderRadius: 4,
                letterSpacing: '0.1em',
              }}
            >
              {deviceFlow.userCode}
            </code>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCopyCode}
            >
              Copy code
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleCancelSignIn}
            >
              Cancel
            </button>
          </div>
          <p
            style={{
              margin: '0.6rem 0 0',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
            }}
          >
            Waiting for you to complete sign-in… (poll continues
            automatically)
          </p>
        </div>
      ) : null}
      <div className="llm-grid">
        <label style={{ gridColumn: '1 / -1' }}>
          Sync path
          <input
            type="text"
            value={syncPath}
            onChange={(e) => setSyncPath(e.target.value)}
            placeholder={
              'e.g. C:\\Users\\you\\Documents\\Projects\\Chunky Collateral'
            }
            spellCheck={false}
          />
          <span
            style={{
              fontSize: '0.78rem',
              color: 'var(--text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Local OneDrive-synced folder that PM Specs get written to.
            OneDrive then uploads to SharePoint. Use this when your tenant
            blocks the in-app Graph upload (AADSTS530033).
          </span>
        </label>
        <label>
          Tenant (optional)
          <input
            type="text"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="common (leave empty) or your-tenant.onmicrosoft.com"
            spellCheck={false}
          />
        </label>
        <label>
          Client ID (optional)
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Leave empty to use the Microsoft Graph CLI client"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="llm-actions">
        {!signedInAs && !deviceFlow && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSignIn}
              disabled={status === 'pending'}
              title="Opens a sign-in popup window (PKCE)"
            >
              Sign in with Microsoft
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSignInDeviceCode}
              disabled={status === 'pending'}
              title="Use device-code instead — copy a code to a browser"
            >
              Use device code instead
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleSave}
          disabled={status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : 'Save settings'}
        </button>
        {status === 'complete' && <span className="llm-test-ok">{msg}</span>}
        {status === 'saved' && <span className="llm-test-ok">{msg}</span>}
        {status === 'error' && <span className="llm-test-err">{msg}</span>}
      </div>
    </section>
  )
}

// ── Main settings page ────────────────────────────────────────────────────────

export const Settings: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings())
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const s = await loadSettings()
      if (!cancelled) {
        setSettings(s)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    setStatus('saving')
    setStatusMessage('Writing settings.json…')
    try {
      await saveSettings(settings)
      setStatus('saved')
      setStatusMessage(`Saved at ${new Date().toLocaleTimeString()}`)
    } catch (err) {
      setStatus('error')
      setStatusMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const updateUse = (useId: LlmUseId, next: LlmUseConfig) => {
    setSettings((s) => ({ ...s, llm: { ...s.llm, [useId]: next } }))
  }

  const handleAddCustomModel = (
    supplierId: string,
    model: { id: string; label: string },
  ) => {
    setSettings((s) => {
      const existing = s.userModelsBySupplier[supplierId] ?? []
      if (existing.some((m) => m.id === model.id)) return s
      return {
        ...s,
        userModelsBySupplier: {
          ...s.userModelsBySupplier,
          [supplierId]: [...existing, { id: model.id, label: model.label }],
        },
      }
    })
  }

  const [showAddSupplier, setShowAddSupplier] = useState(false)

  if (loading) return <div className="settings-page">Loading settings…</div>

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div>
          <h1>LLM configuration</h1>
          <p>
            Configure suppliers and models for the two LLM uses. Defaults to
            Anthropic Claude. Local providers (Ollama, vLLM) need no API key.
            Settings persist to the OS app-data directory for{' '}
            <code>com.chunky.desktop</code>{' '}
            (Windows: <code>%APPDATA%\com.chunky.desktop\</code>; macOS:{' '}
            <code>~/Library/Application Support/com.chunky.desktop/</code>;
            Linux: <code>~/.local/share/com.chunky.desktop/</code>).
          </p>
        </div>
        <div className="settings-save-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={status === 'saving'}
          >
            {status === 'saving' ? 'Saving…' : 'Save settings'}
          </button>
          {status === 'saved' && <span className="settings-saved">{statusMessage}</span>}
          {status === 'error' && <span className="settings-err">{statusMessage}</span>}
        </div>
      </div>

      {/* Appearance toggle lives in the sidebar footer post-redesign;
          the duplicate card here was removed so there's a single source
          of truth for theme. */}

      <UseForm
        useId="query"
        label="Query LLM"
        hint="Used for free-text queries against the knowledge graph and for evidence-cited drafting."
        value={settings.llm.query}
        settings={settings}
        onChange={(next) => updateUse('query', next)}
        onAddCustomSupplier={() => setShowAddSupplier(true)}
        onAddCustomModel={handleAddCustomModel}
        visionRequired={false}
      />

      <UseForm
        useId="imageTextExtraction"
        label="Image text extraction LLM"
        hint="Used to extract text content from images attached to a requirement (when the model is vision-capable). Use Ollama / vLLM with a vision model for fully-local OCR."
        value={settings.llm.imageTextExtraction}
        settings={settings}
        onChange={(next) => updateUse('imageTextExtraction', next)}
        onAddCustomSupplier={() => setShowAddSupplier(true)}
        onAddCustomModel={handleAddCustomModel}
        visionRequired
      />

      {showAddSupplier && (
        <AddSupplierModal
          onClose={() => setShowAddSupplier(false)}
          onAdd={(supplier) => {
            setSettings((s) => {
              if ([...PRESETS, ...s.customSuppliers].some((x) => x.id === supplier.id)) {
                return s
              }
              return { ...s, customSuppliers: [...s.customSuppliers, supplier] }
            })
            setShowAddSupplier(false)
          }}
        />
      )}

      <AtlassianSettingsSection />
      <MicrosoftSettingsSection />
    </div>
  )
}

interface AddSupplierModalProps {
  onClose: () => void
  onAdd: (supplier: SupplierPreset) => void
}

function AddSupplierModal({ onClose, onAdd }: AddSupplierModalProps) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyRequired, setApiKeyRequired] = useState(true)
  const [modelsCsv, setModelsCsv] = useState('')

  const valid = useMemo(() => {
    if (!id.trim()) return false
    if (!label.trim()) return false
    try {
      new URL(baseUrl)
    } catch {
      return false
    }
    return true
  }, [id, label, baseUrl])

  const handleAdd = () => {
    const models = modelsCsv
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((mid) => ({ id: mid, label: mid }))
    onAdd({
      id: id.trim(),
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      apiKeyRequired,
      models,
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add custom supplier</h2>
        <label>
          Id (slug)
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="mistral" />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Mistral AI" />
        </label>
        <label>
          Base URL
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.mistral.ai/v1"
            spellCheck={false}
          />
        </label>
        <label className="llm-checkbox">
          <input
            type="checkbox"
            checked={apiKeyRequired}
            onChange={(e) => setApiKeyRequired(e.target.checked)}
          />
          API key required
        </label>
        <label>
          Initial model ids (comma- or newline-separated)
          <textarea
            value={modelsCsv}
            onChange={(e) => setModelsCsv(e.target.value)}
            placeholder="mistral-large-latest, mistral-medium-latest"
            rows={3}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={!valid}
          >
            Add supplier
          </button>
        </div>
      </div>
    </div>
  )
}

export default Settings
