// LLM supplier and model presets for the Settings UI. The catalogue is the
// reference design from TRP D-013 §4.3 — keep in sync.
//
// `vision: true` flags models that accept image input alongside text and are
// therefore valid choices for the imageTextExtraction use. Operators can
// extend the catalogue at runtime via "Add custom supplier" and "Add custom
// model" — those user-added entries land in <appData>/settings.json under
// `customSuppliers` / `userModelsBySupplier`.

export interface ModelPreset {
  id: string
  label: string
  contextTokens?: number
  vision?: boolean
}

/** How the host invokes this supplier. */
export type Transport = 'http' | 'cli'

export interface SupplierPreset {
  id: string
  label: string
  /** OpenAI-compatible base URL (transport='http') or unused (transport='cli'). */
  baseUrl: string
  /** Default executable to spawn when transport='cli'. Resolved on $PATH. */
  binaryPath?: string
  apiKeyRequired: boolean
  /** Default 'http' for backwards compat. */
  transport?: Transport
  models: ModelPreset[]
}

export const PRESETS: SupplierPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyRequired: true,
    transport: 'http',
    models: [
      { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   contextTokens: 1_000_000, vision: true },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextTokens: 200_000,   vision: true },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextTokens: 200_000,   vision: true },
      { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  contextTokens: 200_000,   vision: true },
    ],
  },
  {
    id: 'claude-code-cli',
    label: 'Claude Code (CLI sidecar)',
    // baseUrl is unused for cli transport. We invoke the CLI binary as a
    // subprocess and pipe the prompt via stdin / -p; auth is handled by the
    // CLI itself, so no API key is needed at the host level.
    baseUrl: '',
    binaryPath: 'claude',
    apiKeyRequired: false,
    transport: 'cli',
    models: [
      { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7 (via CLI)',   contextTokens: 1_000_000, vision: true },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via CLI)', contextTokens: 200_000,   vision: true },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (via CLI)', contextTokens: 200_000,   vision: true },
      { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 (via CLI)',  contextTokens: 200_000,   vision: true },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRequired: true,
    models: [
      { id: 'gpt-4o',      label: 'GPT-4o',      vision: true },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
      { id: 'o1',          label: 'o1' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRequired: true,
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', vision: true },
      { id: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro',   vision: true },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', vision: true },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyRequired: false,
    models: [
      { id: 'llama3.1:8b',  label: 'Llama 3.1 8B' },
      { id: 'llama3.1:70b', label: 'Llama 3.1 70B' },
      { id: 'mistral:7b',   label: 'Mistral 7B' },
      { id: 'qwen2.5:7b',   label: 'Qwen 2.5 7B' },
      { id: 'llava:latest', label: 'LLaVA (vision)',     vision: true },
      { id: 'minicpm-v:8b', label: 'MiniCPM-V 8B (vision)', vision: true },
    ],
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    // OpenAI-compatible endpoint hosted by ollama.com; needs an API key.
    baseUrl: 'https://ollama.com/v1',
    apiKeyRequired: true,
    models: [
      { id: 'gpt-oss:20b',                label: 'gpt-oss 20B' },
      { id: 'gpt-oss:120b',               label: 'gpt-oss 120B' },
      { id: 'qwen3-coder:480b-cloud',     label: 'Qwen3 Coder 480B (cloud)' },
      { id: 'deepseek-v3.1:671b-cloud',   label: 'DeepSeek V3.1 671B (cloud)' },
      { id: 'kimi-k2:1t-cloud',           label: 'Kimi K2 1T (cloud)' },
      { id: 'llama3.1:405b-cloud',        label: 'Llama 3.1 405B (cloud)' },
      { id: 'llava:34b-cloud',            label: 'LLaVA 34B (cloud, vision)', vision: true },
    ],
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyRequired: false,
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (vLLM)' },
      { id: 'mistralai/Mistral-7B-Instruct-v0.3',    label: 'Mistral 7B (vLLM)' },
    ],
  },
]

// Default to the CLI sidecar so a fresh install works for any operator that
// already has `claude` on PATH — no API key, no Ollama download required.
// Operators that prefer the HTTP Anthropic route can switch in Settings.
export const DEFAULT_SUPPLIER_ID = 'claude-code-cli'
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-5'
