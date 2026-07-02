//! Pure-Rust BGE-small-en-v1.5 sentence embeddings via candle.
//!
//! The chat retrieval pipeline (B-020 / AS-5) needs to produce a 384-dim
//! vector per node body at save time and per query string at chat time.
//! Spec §6.6 locks `Xenova/bge-small-en-v1.5`; we use the canonical
//! `BAAI/bge-small-en-v1.5` weights from Hugging Face (identical model,
//! different upload).
//!
//! Why candle and not fastembed/ort: the `ort` crate, which fastembed
//! depends on, has no pre-built ONNX Runtime binary for
//! `x86_64-pc-windows-gnu` (the project's pinned target). Building ORT
//! from source is a multi-hour C++ ordeal. candle is pure Rust and
//! builds cleanly on the GNU toolchain — see TRP B-020 §3.4.
//!
//! Why we don't use a UI-side WASM embedder: the MCP stdio sidecar
//! (`chunky --mcp-stdio`) doesn't have a UI thread to RPC into,
//! and the chat agent's `search_nodes` tool needs to embed the query
//! inside the sidecar process.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use tokenizers::Tokenizer;

/// 384-dim output for bge-small-en-v1.5. Spec §10 locks this dimension
/// so `node_vec` and downstream consumers can rely on it.
pub const EMBEDDING_DIM: usize = 384;

/// Maximum input tokens fed into BERT. bge-small-en-v1.5 supports up
/// to 512; longer text is truncated. The tokenizer is configured with
/// matching `Truncation` parameters at load time.
const MAX_INPUT_TOKENS: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("model directory not found: {0}")]
    ModelDirMissing(PathBuf),
    #[error("missing required model file: {0}")]
    ModelFileMissing(PathBuf),
    #[error("tokeniser load failed: {0}")]
    TokenizerLoad(String),
    #[error("tokeniser encode failed: {0}")]
    TokenizerEncode(String),
    #[error("model load failed: {0}")]
    ModelLoad(String),
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("output had {got} dims, expected {expected}")]
    DimMismatch { got: usize, expected: usize },
}

/// Loaded bge-small-en-v1.5 ready to embed text. Cheap to call repeatedly
/// — model weights are memory-mapped from the safetensors file; per-call
/// allocations are bounded by `MAX_INPUT_TOKENS`.
///
/// Wraps the inner state in a `Mutex` because candle's `BertModel`
/// holds tensor storage that isn't `Sync`. Embed calls are serialised
/// inside the mutex; for our query volume (per save + per chat turn)
/// this is fine. If contention ever shows up, pool multiple instances.
pub struct Embedder {
    inner: Mutex<EmbedderInner>,
}

struct EmbedderInner {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl Embedder {
    /// Resolve a model directory. Priority:
    ///   1. `CHUNKY_EMBEDDING_MODEL_DIR` env var (dev override)
    ///   2. `<exe-dir>/models/bge-small-en-v1.5`
    ///   3. `<exe-dir>/../embedded/models/bge-small-en-v1.5` (dev / cargo run)
    /// Returns the first path that exists.
    pub fn default_model_dir() -> Option<PathBuf> {
        if let Ok(env_dir) = std::env::var("CHUNKY_EMBEDDING_MODEL_DIR") {
            let p = PathBuf::from(env_dir);
            if p.exists() {
                return Some(p);
            }
        }
        let exe = std::env::current_exe().ok()?;
        let exe_dir = exe.parent()?.to_path_buf();
        // Search order — first hit wins:
        //   1. Sibling `models/` (release layout when we drop resources beside exe)
        //   2. Sibling `embedded/models/` (Tauri's `resources` copy on Windows/Linux)
        //   3. Dev cargo layout: `target/debug/` → `../embedded/models/…`
        //   4. Dev cargo layout: `target/debug/deps/` → `../../embedded/models/…`
        //   5. macOS bundle: `<Contents/MacOS>/../Resources/embedded/models/…`
        //   6. macOS bundle (Tauri resources): `<Contents/MacOS>/../Resources/_up_/embedded/…`
        let candidates = [
            exe_dir.join("models").join("bge-small-en-v1.5"),
            exe_dir.join("embedded").join("models").join("bge-small-en-v1.5"),
            exe_dir.join("..").join("embedded").join("models").join("bge-small-en-v1.5"),
            exe_dir
                .join("..")
                .join("..")
                .join("embedded")
                .join("models")
                .join("bge-small-en-v1.5"),
            exe_dir
                .join("..")
                .join("Resources")
                .join("embedded")
                .join("models")
                .join("bge-small-en-v1.5"),
            exe_dir
                .join("..")
                .join("Resources")
                .join("_up_")
                .join("embedded")
                .join("models")
                .join("bge-small-en-v1.5"),
        ];
        candidates.into_iter().find(|p| p.exists())
    }

    /// Load the model from a directory containing `model.safetensors`,
    /// `tokenizer.json`, and `config.json`. CPU-only — candle has CUDA
    /// support but we don't depend on it.
    pub fn load(model_dir: &Path) -> Result<Self, EmbeddingError> {
        if !model_dir.exists() {
            return Err(EmbeddingError::ModelDirMissing(model_dir.to_path_buf()));
        }

        let config_path = model_dir.join("config.json");
        let tokenizer_path = model_dir.join("tokenizer.json");
        let weights_path = model_dir.join("model.safetensors");

        for p in [&config_path, &tokenizer_path, &weights_path] {
            if !p.exists() {
                return Err(EmbeddingError::ModelFileMissing(p.clone()));
            }
        }

        let config_bytes = std::fs::read(&config_path)
            .map_err(|e| EmbeddingError::ModelLoad(format!("read config.json: {e}")))?;
        let config: Config = serde_json::from_slice(&config_bytes)
            .map_err(|e| EmbeddingError::ModelLoad(format!("parse config.json: {e}")))?;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| EmbeddingError::TokenizerLoad(e.to_string()))?;
        // Truncate long inputs at BERT's max sequence length so we
        // never feed the model an oversize tensor.
        let _ = tokenizer.with_truncation(Some(tokenizers::TruncationParams {
            max_length: MAX_INPUT_TOKENS,
            ..Default::default()
        }));

        let device = Device::Cpu;
        // SAFETY: mmap is safe to call on a well-formed safetensors file
        // that we control. The lifetime of the mapping is tied to the
        // VarBuilder which the BertModel owns; both live for the
        // lifetime of the Embedder.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path.clone()], DTYPE, &device)
                .map_err(|e| EmbeddingError::ModelLoad(format!("VarBuilder: {e}")))?
        };
        let model = BertModel::load(vb, &config)
            .map_err(|e| EmbeddingError::ModelLoad(format!("BertModel::load: {e}")))?;

        Ok(Embedder {
            inner: Mutex::new(EmbedderInner {
                model,
                tokenizer,
                device,
            }),
        })
    }

    /// Embed a single string. Returns an L2-normalised 384-dim vector
    /// suitable for cosine similarity (`vec_cosine_distance` in
    /// sqlite-vec is `1 - cosine_sim`).
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| EmbeddingError::Inference(format!("mutex: {e}")))?;
        let encoding = inner
            .tokenizer
            .encode(text, true)
            .map_err(|e| EmbeddingError::TokenizerEncode(e.to_string()))?;
        let token_ids = encoding.get_ids().to_vec();
        let attention_mask = encoding.get_attention_mask().to_vec();

        let token_ids_tensor = Tensor::new(token_ids.as_slice(), &inner.device)
            .map_err(|e| EmbeddingError::Inference(format!("token ids tensor: {e}")))?
            .unsqueeze(0)
            .map_err(|e| EmbeddingError::Inference(format!("unsqueeze ids: {e}")))?;
        let token_type_ids = token_ids_tensor
            .zeros_like()
            .map_err(|e| EmbeddingError::Inference(format!("token_type_ids: {e}")))?;
        let attention_mask_tensor = Tensor::new(attention_mask.as_slice(), &inner.device)
            .map_err(|e| EmbeddingError::Inference(format!("attn mask tensor: {e}")))?
            .unsqueeze(0)
            .map_err(|e| EmbeddingError::Inference(format!("unsqueeze mask: {e}")))?;

        let output = inner
            .model
            .forward(
                &token_ids_tensor,
                &token_type_ids,
                Some(&attention_mask_tensor),
            )
            .map_err(|e| EmbeddingError::Inference(format!("forward: {e}")))?;

        // BGE: take the [CLS] token (position 0) and L2-normalise.
        // The model returns last_hidden_state of shape (batch, seq_len, hidden).
        // Equivalent recipe to sentence-transformers' BGE inference path.
        let cls = output
            .i((.., 0, ..))
            .map_err(|e| EmbeddingError::Inference(format!("cls slice: {e}")))?;
        let norm = cls
            .sqr()
            .and_then(|x| x.sum_keepdim(1))
            .and_then(|x| x.sqrt())
            .map_err(|e| EmbeddingError::Inference(format!("norm: {e}")))?;
        let normalised = cls
            .broadcast_div(&norm)
            .map_err(|e| EmbeddingError::Inference(format!("divide: {e}")))?;
        let flattened = normalised
            .squeeze(0)
            .map_err(|e| EmbeddingError::Inference(format!("squeeze: {e}")))?
            .to_dtype(DType::F32)
            .map_err(|e| EmbeddingError::Inference(format!("to_f32: {e}")))?
            .to_vec1::<f32>()
            .map_err(|e| EmbeddingError::Inference(format!("to_vec1: {e}")))?;

        if flattened.len() != EMBEDDING_DIM {
            return Err(EmbeddingError::DimMismatch {
                got: flattened.len(),
                expected: EMBEDDING_DIM,
            });
        }
        Ok(flattened)
    }
}

// IndexOp shim — the `i((..,0,..))` indexing API used above lives
// in `candle_core::IndexOp`. Bring it into scope alongside the rest.
use candle_core::IndexOp;
