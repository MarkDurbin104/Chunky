// LLM settings shape and load/save helpers. Persisted to disk via the
// app_getSettings / app_setSettings shell-bridge commands; API keys are
// stored separately via the OS keychain (deferred to D-014, not included
// here per TRP D-013).

import type { ModelPreset, SupplierPreset } from './llm-presets'
import { DEFAULT_MODEL_ID, DEFAULT_SUPPLIER_ID, PRESETS } from './llm-presets'
import { invoke } from '@tauri-apps/api/core'

export type LlmUseId = 'query' | 'imageTextExtraction'

export interface LlmUseConfig {
  supplier: string
  model: string
  /** OpenAI-compatible base URL when transport='http'; unused when 'cli'. */
  baseUrl: string
  /** Path to the CLI binary when transport='cli' (resolved on $PATH). */
  binaryPath?: string
  /** Mirror of the chosen supplier's transport at save time. */
  transport?: 'http' | 'cli'
  /** Optional extra HTTP headers (e.g. proxy auth). */
  extraHeaders?: Record<string, string>
  /** Sampling temperature; image extraction defaults to 0 for determinism. */
  temperature?: number
}

export type ThemeMode = 'light' | 'dark' | 'auto'

export interface AppSettings {
  llm: {
    query: LlmUseConfig
    imageTextExtraction: LlmUseConfig
  }
  /** User-added suppliers (extend the static PRESETS catalogue). */
  customSuppliers: SupplierPreset[]
  /** User-added models per supplier id. */
  userModelsBySupplier: Record<string, ModelPreset[]>
  /** UI theme mode. 'auto' follows the OS prefers-color-scheme. */
  theme: ThemeMode
}

export function defaultSettings(): AppSettings {
  const preset = PRESETS.find((p) => p.id === DEFAULT_SUPPLIER_ID)
  const baseUse: LlmUseConfig = {
    supplier: DEFAULT_SUPPLIER_ID,
    model: DEFAULT_MODEL_ID,
    baseUrl: preset?.baseUrl ?? '',
    binaryPath: preset?.binaryPath,
    transport: preset?.transport ?? 'http',
    extraHeaders: {},
  }
  return {
    llm: {
      query: { ...baseUse, temperature: 0.2 },
      imageTextExtraction: { ...baseUse, temperature: 0 },
    },
    customSuppliers: [],
    userModelsBySupplier: {},
    theme: 'auto',
  }
}

/** Returns the union catalogue (presets + custom). */
export function allSuppliers(settings: AppSettings): SupplierPreset[] {
  return [...PRESETS, ...settings.customSuppliers]
}

/** Returns the union model list for a supplier (preset + custom). */
export function modelsForSupplier(
  settings: AppSettings,
  supplierId: string,
): ModelPreset[] {
  const supplier = allSuppliers(settings).find((s) => s.id === supplierId)
  const presetModels = supplier?.models ?? []
  const userModels = settings.userModelsBySupplier[supplierId] ?? []
  // De-dupe by id; user value wins (so a relabel sticks).
  const seen = new Map<string, ModelPreset>()
  for (const m of presetModels) seen.set(m.id, m)
  for (const m of userModels) seen.set(m.id, m)
  return [...seen.values()]
}

interface RequestEnvelope<T> {
  meta: {
    interfaceId: string
    version: string
    requestId: string
    traceId: string
    timestampUtc: string
    caller: string
  }
  payload: T
}

interface ResponseEnvelope<T> {
  meta: { requestId: string; traceId: string; durationMs: number }
  ok: boolean
  payload: T | null
  error: { code: string; message: string; retryable: boolean } | null
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function makeReq<T>(payload: T): RequestEnvelope<T> {
  return {
    meta: {
      interfaceId: 'shell-bridge.v1',
      version: '1.0.0',
      requestId: uuid(),
      traceId: uuid(),
      timestampUtc: new Date().toISOString(),
      caller: 'ui-app/settings',
    },
    payload,
  }
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const res = await invoke<ResponseEnvelope<{ settings: Partial<AppSettings> | null }>>(
      'app_getSettings',
      { payload: makeReq({}) },
    )
    if (!res.ok || !res.payload) return defaultSettings()
    const onDisk = res.payload.settings
    if (!onDisk || Object.keys(onDisk).length === 0) return defaultSettings()
    // Shallow-merge so any newly-added top-level field falls back to the
    // default rather than being undefined.
    const fallback = defaultSettings()
    return {
      llm: {
        query: onDisk.llm?.query ?? fallback.llm.query,
        imageTextExtraction:
          onDisk.llm?.imageTextExtraction ?? fallback.llm.imageTextExtraction,
      },
      customSuppliers: onDisk.customSuppliers ?? [],
      userModelsBySupplier: onDisk.userModelsBySupplier ?? {},
      theme: onDisk.theme ?? fallback.theme,
    }
  } catch (err) {
    console.warn('[settings] load failed, falling back to defaults:', err)
    return defaultSettings()
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const res = await invoke<ResponseEnvelope<{ persistedAt: string }>>(
    'app_setSettings',
    { payload: makeReq({ settings }) },
  )
  if (!res.ok) throw new Error(res.error?.message ?? 'saveSettings failed')
}

/**
 * For image-text-extraction the model must be vision-capable. Local providers
 * (Ollama, vLLM, custom) have to declare it via a custom model entry, so we
 * permit any model on those — only known cloud providers are filtered.
 */
export function isVisionEligible(
  settings: AppSettings,
  supplierId: string,
  modelId: string,
): boolean {
  if (
    supplierId === 'ollama' ||
    supplierId === 'vllm' ||
    settings.customSuppliers.some((s) => s.id === supplierId)
  ) {
    return true
  }
  const models = modelsForSupplier(settings, supplierId)
  const m = models.find((x) => x.id === modelId)
  return !!m?.vision
}
