// Recovery logic for failed or incomplete extractions
// Handles detection and repair of extraction failures

use std::fs;
use std::path::{Path, PathBuf};
use super::extract::{Extractor, ExtractionError};

/// Recovery status after checking for issues
#[derive(Debug, Clone)]
pub struct RecoveryStatus {
    pub needs_recovery: bool,
    pub issues: Vec<String>,
}

/// Recovery operations for extraction failures
pub struct ExtractionRecovery {
    workspace_path: PathBuf,
}

impl ExtractionRecovery {
    /// Create a new recovery handler for the given workspace
    pub fn new<P: AsRef<Path>>(workspace_path: P) -> Self {
        ExtractionRecovery {
            workspace_path: workspace_path.as_ref().to_path_buf(),
        }
    }
    
    /// Validate the extraction state and detect any issues
    pub fn validate(&self) -> Result<RecoveryStatus, ExtractionError> {
        let mut issues = Vec::new();
        
        // Check if extraction marker exists
        let marker_path = self.workspace_path.join(".shirika").join("extraction.marker");
        if !marker_path.exists() {
            issues.push("Extraction marker file not found".to_string());
        }
        
        // Check if .shirika directory exists and is writable
        let shirika_dir = self.workspace_path.join(".shirika");
        if !shirika_dir.exists() {
            issues.push("Shirika directory not found".to_string());
        }
        
        // Check for orphaned temp files from failed extractions
        if let Ok(entries) = fs::read_dir(&self.workspace_path) {
            for entry in entries.flatten() {
                if let Ok(name) = entry.file_name().into_string() {
                    // Look for temp file patterns (.tmp, .partial, etc.)
                    if name.starts_with('.') && 
                       (name.ends_with(".tmp") || name.ends_with(".partial") || name.ends_with(".tmp~")) {
                        issues.push(format!("Found orphaned temp file: {}", name));
                    }
                }
            }
        }
        
        Ok(RecoveryStatus {
            needs_recovery: !issues.is_empty(),
            issues,
        })
    }
    
    /// Attempt to recover from extraction failure
    /// This may involve:
    /// - Cleaning up orphaned temp files
    /// - Removing incomplete extractions
    /// - Restarting extraction
    pub fn recover(&self) -> Result<RecoveryReport, ExtractionError> {
        let mut cleaned_files = Vec::new();
        let mut recovered = false;
        
        // Clean up orphaned temp files
        if let Ok(entries) = fs::read_dir(&self.workspace_path) {
            for entry in entries.flatten() {
                if let Ok(name) = entry.file_name().into_string() {
                    if name.starts_with('.') && 
                       (name.ends_with(".tmp") || name.ends_with(".partial") || name.ends_with(".tmp~")) {
                        if let Ok(path) = entry.path().into_os_string().into_string() {
                            if fs::remove_file(&path).is_ok() {
                                cleaned_files.push(path);
                            }
                        }
                    }
                }
            }
        }
        
        // Try to restart extraction
        let extractor = Extractor::new(&self.workspace_path)?;
        match extractor.extract() {
            Ok(_) => {
                recovered = true;
            }
            Err(e) => {
                return Err(ExtractionError::Other(
                    format!("Recovery extraction failed: {}", e)
                ));
            }
        }
        
        Ok(RecoveryReport {
            recovered,
            cleaned_files,
        })
    }
    
    /// Clean up after failed extraction without full recovery attempt
    /// Removes incomplete state markers
    pub fn cleanup(&self) -> Result<(), ExtractionError> {
        // Remove marker file to allow re-extraction
        let marker_path = self.workspace_path.join(".shirika").join("extraction.marker");
        if marker_path.exists() {
            fs::remove_file(&marker_path)
                .map_err(|e| ExtractionError::IoError(
                    format!("Failed to remove marker file: {}", e)
                ))?;
        }
        
        Ok(())
    }
    
    /// Check if extraction can be retried (no blocking issues)
    pub fn can_retry(&self) -> bool {
        // If workspace exists and is writable, we can retry
        if !self.workspace_path.exists() {
            return false;
        }
        
        // Check if we can write to the workspace
        match fs::metadata(&self.workspace_path) {
            Ok(meta) => !meta.permissions().readonly(),
            Err(_) => false,
        }
    }
}

/// Result of recovery attempt
#[derive(Debug, Clone)]
pub struct RecoveryReport {
    pub recovered: bool,
    pub cleaned_files: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    
    #[test]
    fn test_recovery_new() {
        let temp_dir = TempDir::new().unwrap();
        let recovery = ExtractionRecovery::new(temp_dir.path());
        assert_eq!(recovery.workspace_path, temp_dir.path());
    }
    
    #[test]
    fn test_validate_detects_missing_marker() {
        let temp_dir = TempDir::new().unwrap();
        let recovery = ExtractionRecovery::new(temp_dir.path());
        
        let status = recovery.validate().unwrap();
        assert!(status.needs_recovery);
        assert!(status.issues.iter().any(|i| i.contains("marker")));
    }
    
    #[test]
    fn test_can_retry_with_writable_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let recovery = ExtractionRecovery::new(temp_dir.path());
        
        assert!(recovery.can_retry());
    }
    
    #[test]
    fn test_can_retry_with_nonexistent_workspace() {
        let recovery = ExtractionRecovery::new("/nonexistent/path/12345");
        assert!(!recovery.can_retry());
    }
    
    #[test]
    fn test_cleanup_removes_marker() {
        let temp_dir = TempDir::new().unwrap();
        let recovery = ExtractionRecovery::new(temp_dir.path());
        
        // Create marker
        let marker_dir = temp_dir.path().join(".shirika");
        fs::create_dir_all(&marker_dir).unwrap();
        let marker_path = marker_dir.join("extraction.marker");
        fs::write(&marker_path, "test").unwrap();
        
        assert!(marker_path.exists());
        recovery.cleanup().unwrap();
        assert!(!marker_path.exists());
    }
    
    #[test]
    fn test_validate_detects_orphaned_temp_files() {
        let temp_dir = TempDir::new().unwrap();
        
        // Create orphaned temp files
        fs::write(temp_dir.path().join(".temp.tmp"), "orphaned").unwrap();
        fs::write(temp_dir.path().join(".extract.partial"), "orphaned").unwrap();
        
        let recovery = ExtractionRecovery::new(temp_dir.path());
        let status = recovery.validate().unwrap();
        
        assert!(status.needs_recovery);
        assert!(status.issues.iter().any(|i| i.contains("temp")));
    }
}
