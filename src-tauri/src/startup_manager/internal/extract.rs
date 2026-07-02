// First-run extraction: atomic writes, fsync, and manifest checksum validation
// Extracts embedded seed assets to workspace with atomicity guarantees

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use super::embedded_assets::{get_embedded_asset, list_embedded_assets, MANIFEST_JSON};
use super::assets::EmbeddedAssetPack;

/// Extraction result details
#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub extracted_files: usize,
    pub skipped_files: usize,
    pub workspace_path: PathBuf,
    pub marker_path: PathBuf,
}

/// Extraction errors
#[derive(Debug)]
pub enum ExtractionError {
    InvalidPath(String),
    IoError(String),
    ChecksumMismatch { path: String, expected: String, actual: String },
    PermissionDenied(String),
    DiskFull(String),
    Other(String),
}

impl std::fmt::Display for ExtractionError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ExtractionError::InvalidPath(msg) => write!(f, "Invalid workspace path: {}", msg),
            ExtractionError::IoError(msg) => write!(f, "I/O error: {}", msg),
            ExtractionError::ChecksumMismatch { path, expected, actual } => {
                write!(f, "Checksum mismatch for {}: expected {}, got {}", path, expected, actual)
            }
            ExtractionError::PermissionDenied(msg) => write!(f, "Permission denied: {}", msg),
            ExtractionError::DiskFull(msg) => write!(f, "Disk full: {}", msg),
            ExtractionError::Other(msg) => write!(f, "Extraction error: {}", msg),
        }
    }
}

impl std::error::Error for ExtractionError {}

/// Responsible for atomically extracting embedded assets to the workspace
pub struct Extractor {
    workspace_path: PathBuf,
    marker_path: PathBuf,
}

impl Extractor {
    /// Create a new extractor for the given workspace directory
    pub fn new<P: AsRef<Path>>(workspace_path: P) -> Result<Self, ExtractionError> {
        let workspace_path = workspace_path.as_ref().to_path_buf();
        
        // Validate the path is not malicious (no .. traversal)
        if workspace_path.as_os_str().to_string_lossy().contains("..") {
            return Err(ExtractionError::InvalidPath(
                "Path contains .. traversal".to_string()
            ));
        }
        
        // Create workspace directory if it doesn't exist
        fs::create_dir_all(&workspace_path)
            .map_err(|e| ExtractionError::IoError(
                format!("Failed to create workspace directory: {}", e)
            ))?;
        
        // Marker file indicates successful extraction
        let marker_path = workspace_path.join(".shirika").join("extraction.marker");
        
        Ok(Extractor {
            workspace_path,
            marker_path,
        })
    }
    
    /// Check if extraction has already been completed
    pub fn is_extracted(&self) -> bool {
        self.marker_path.exists()
    }
    
    /// Get the marker file path
    pub fn marker_path(&self) -> &Path {
        &self.marker_path
    }
    
    /// Get the workspace path
    pub fn workspace_path(&self) -> &Path {
        &self.workspace_path
    }
    
    /// Extract all embedded assets to the workspace
    /// Returns ExtractionResult with counts of extracted/skipped files
    pub fn extract(&self) -> Result<ExtractionResult, ExtractionError> {
        // Parse the embedded manifest
        let pack = EmbeddedAssetPack::new(MANIFEST_JSON)
            .map_err(|e| ExtractionError::Other(format!("Failed to parse manifest: {}", e)))?;
        
        let mut extracted_count = 0;
        let mut skipped_count = 0;
        
        // Extract each embedded asset
        for asset_path in list_embedded_assets() {
            if let Some(asset) = get_embedded_asset(asset_path) {
                let target_path = self.workspace_path.join(asset_path);
                
                // Skip if file already exists (user-authored content protection)
                if target_path.exists() {
                    skipped_count += 1;
                    continue;
                }
                
                // Extract with atomic write
                self.extract_asset_atomic(&target_path, asset.content, asset.sha256)?;
                extracted_count += 1;
            }
        }
        
        // Write extraction marker (indicates extraction is complete)
        self.write_marker()?;
        
        Ok(ExtractionResult {
            extracted_files: extracted_count,
            skipped_files: skipped_count,
            workspace_path: self.workspace_path.clone(),
            marker_path: self.marker_path.clone(),
        })
    }
    
    /// Atomically write an asset file using temp file + fsync + rename pattern
    /// This ensures that either the full file is written or nothing is written
    fn extract_asset_atomic(
        &self,
        target_path: &Path,
        content: &str,
        expected_sha256: &str,
    ) -> Result<(), ExtractionError> {
        // Create parent directory if needed
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| {
                    match e.kind() {
                        io::ErrorKind::PermissionDenied => {
                            ExtractionError::PermissionDenied(parent.to_string_lossy().to_string())
                        }
                        io::ErrorKind::StorageFull => {
                            ExtractionError::DiskFull(parent.to_string_lossy().to_string())
                        }
                        _ => ExtractionError::IoError(format!("Failed to create directory: {}", e)),
                    }
                })?;
        }
        
        // Create temporary file in the same directory for atomic rename
        let temp_path = if let Some(parent) = target_path.parent() {
            parent.to_path_buf()
        } else {
            PathBuf::from(".")
        };
        
        let mut temp_file = tempfile::NamedTempFile::new_in(temp_path)
            .map_err(|e| {
                match e.kind() {
                    io::ErrorKind::PermissionDenied => {
                        ExtractionError::PermissionDenied(temp_path.to_string_lossy().to_string())
                    }
                    io::ErrorKind::StorageFull => {
                        ExtractionError::DiskFull(temp_path.to_string_lossy().to_string())
                    }
                    _ => ExtractionError::IoError(format!("Failed to create temp file: {}", e)),
                }
            })?;
        
        // Write content to temp file
        temp_file.write_all(content.as_bytes())
            .map_err(|e| {
                match e.kind() {
                    io::ErrorKind::StorageFull => {
                        ExtractionError::DiskFull(temp_path.to_string_lossy().to_string())
                    }
                    _ => ExtractionError::IoError(format!("Failed to write file: {}", e)),
                }
            })?;
        
        // Verify checksum before fsync
        let actual_sha256 = compute_sha256(content.as_bytes());
        if actual_sha256 != expected_sha256 {
            return Err(ExtractionError::ChecksumMismatch {
                path: target_path.to_string_lossy().to_string(),
                expected: expected_sha256.to_string(),
                actual: actual_sha256,
            });
        }
        
        // Sync to disk before rename
        let file = temp_file.as_file();
        file.sync_all()
            .map_err(|e| ExtractionError::IoError(format!("Failed to sync file: {}", e)))?;
        
        // Atomic rename from temp to final location
        let temp_path_buf = temp_file.path().to_path_buf();
        fs::rename(&temp_path_buf, target_path)
            .map_err(|e| {
                match e.kind() {
                    io::ErrorKind::PermissionDenied => {
                        ExtractionError::PermissionDenied(target_path.to_string_lossy().to_string())
                    }
                    _ => ExtractionError::IoError(format!("Failed to rename file: {}", e)),
                }
            })?;
        
        Ok(())
    }
    
    /// Write the extraction marker file to indicate completion
    fn write_marker(&self) -> Result<(), ExtractionError> {
        // Create .shirika directory if needed
        if let Some(parent) = self.marker_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| ExtractionError::IoError(
                    format!("Failed to create marker directory: {}", e)
                ))?;
        }
        
        // Write marker with completion timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let marker_content = format!("extraction_completed={}", timestamp);
        
        fs::write(&self.marker_path, marker_content)
            .map_err(|e| ExtractionError::IoError(
                format!("Failed to write marker file: {}", e)
            ))?;
        
        Ok(())
    }
}

/// Compute SHA-256 hash of data
fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    
    #[test]
    fn test_extractor_new_creates_directory() {
        let temp_dir = TempDir::new().unwrap();
        let workspace = temp_dir.path().join("workspace");
        
        let extractor = Extractor::new(&workspace);
        assert!(extractor.is_ok());
        assert!(workspace.exists());
    }
    
    #[test]
    fn test_extractor_invalid_path_with_traversal() {
        let extractor = Extractor::new("../../../etc/passwd");
        assert!(extractor.is_err());
    }
    
    #[test]
    fn test_is_extracted_false_initially() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        assert!(!extractor.is_extracted());
    }
    
    #[test]
    fn test_is_extracted_true_after_marker() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        // Write marker manually
        fs::create_dir_all(extractor.marker_path().parent().unwrap()).unwrap();
        fs::write(extractor.marker_path(), "test").unwrap();
        
        assert!(extractor.is_extracted());
    }
    
    #[test]
    fn test_extract_skips_existing_files() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        // Create an existing file that would be extracted
        let existing_file = temp_dir.path().join("config").join("shirika.toml");
        fs::create_dir_all(existing_file.parent().unwrap()).unwrap();
        fs::write(&existing_file, "existing content").unwrap();
        
        // Extract should skip this file
        let result = extractor.extract().unwrap();
        assert_eq!(result.skipped_files, 1);
        assert!(result.extracted_files > 0);
    }
    
    #[test]
    fn test_extract_creates_marker() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        extractor.extract().unwrap();
        assert!(extractor.is_extracted());
        assert!(extractor.marker_path().exists());
    }
    
    #[test]
    fn test_checksum_verification() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        // Test with correct checksum
        let content = "test content";
        let hash = compute_sha256(content.as_bytes());
        let target = temp_dir.path().join("test.txt");
        
        let result = extractor.extract_asset_atomic(&target, content, &hash);
        assert!(result.is_ok());
        assert!(target.exists());
    }
    
    #[test]
    fn test_checksum_mismatch_detected() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        let content = "test content";
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        let target = temp_dir.path().join("test.txt");
        
        let result = extractor.extract_asset_atomic(&target, content, wrong_hash);
        assert!(matches!(result, Err(ExtractionError::ChecksumMismatch { .. })));
        assert!(!target.exists());
    }
    
    #[test]
    fn test_parent_directory_creation() {
        let temp_dir = TempDir::new().unwrap();
        let extractor = Extractor::new(temp_dir.path()).unwrap();
        
        let nested_path = temp_dir.path().join("a").join("b").join("c").join("file.txt");
        let result = extractor.extract_asset_atomic(&nested_path, "content", 
            "0f4f1ab970302dcd2b26b97d53ce4f8da1a4ab2b77b44b5c1aaed3d2c5b1a87b");
        
        assert!(result.is_ok());
        assert!(nested_path.exists());
    }
}
