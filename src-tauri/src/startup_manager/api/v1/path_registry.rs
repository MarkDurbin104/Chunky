use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Runtime path registry: exposes resolved application data directories.
///
/// Provides typed, validated access to runtime paths used by all modules.
/// All paths are resolved at startup and immutable thereafter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathRegistry {
    /// Application data root directory (e.g., ~/.shirika, %APPDATA%\shirika).
    /// This is the base directory resolved based on the platform at runtime.
    app_data_root: PathBuf,

    /// Knowledge base root directory (appDataRoot/kb).
    /// Stores canonical knowledge base content.
    kb_root: PathBuf,

    /// Draft root directory (appDataRoot/draft).
    /// Stores draft and in-progress content.
    draft_root: PathBuf,

    /// Index root directory (appDataRoot/index).
    /// Stores computed index structures and analysis results.
    index_root: PathBuf,

    /// Logs root directory (appDataRoot/logs).
    /// Stores application logs.
    logs_root: PathBuf,

    /// Temporary root directory (appDataRoot/tmp).
    /// Stores temporary files with no persistence guarantee.
    tmp_root: PathBuf,
}

impl PathRegistry {
    /// Creates a new PathRegistry with resolved paths under the given appDataRoot.
    ///
    /// # Arguments
    /// * `app_data_root` - Base application data directory (must exist and be writable)
    ///
    /// # Example
    /// ```ignore
    /// let registry = PathRegistry::new(PathBuf::from("/home/user/.shirika"))?;
    /// ```
    pub fn new(app_data_root: impl Into<PathBuf>) -> Result<Self, PathRegistryError> {
        let app_data_root = app_data_root.into();

        // Validate that appDataRoot exists and is a directory
        if !app_data_root.exists() {
            return Err(PathRegistryError::AppDataRootNotFound(
                app_data_root.clone(),
            ));
        }

        if !app_data_root.is_dir() {
            return Err(PathRegistryError::AppDataRootNotDirectory(
                app_data_root.clone(),
            ));
        }

        let kb_root = app_data_root.join("kb");
        let draft_root = app_data_root.join("draft");
        let index_root = app_data_root.join("index");
        let logs_root = app_data_root.join("logs");
        let tmp_root = app_data_root.join("tmp");

        Ok(Self {
            app_data_root,
            kb_root,
            draft_root,
            index_root,
            logs_root,
            tmp_root,
        })
    }

    /// Returns the application data root path.
    pub fn app_data_root(&self) -> &PathBuf {
        &self.app_data_root
    }

    /// Returns the knowledge base root path.
    pub fn kb_root(&self) -> &PathBuf {
        &self.kb_root
    }

    /// Returns the draft root path.
    pub fn draft_root(&self) -> &PathBuf {
        &self.draft_root
    }

    /// Returns the index root path.
    pub fn index_root(&self) -> &PathBuf {
        &self.index_root
    }

    /// Returns the logs root path.
    pub fn logs_root(&self) -> &PathBuf {
        &self.logs_root
    }

    /// Returns the temporary root path.
    pub fn tmp_root(&self) -> &PathBuf {
        &self.tmp_root
    }
}

/// Errors that can occur during path registry operations.
#[derive(Debug, Clone)]
pub enum PathRegistryError {
    /// Application data root directory does not exist.
    AppDataRootNotFound(PathBuf),

    /// Application data root path exists but is not a directory.
    AppDataRootNotDirectory(PathBuf),
}

impl std::fmt::Display for PathRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathRegistryError::AppDataRootNotFound(path) => {
                write!(f, "application data root not found: {}", path.display())
            }
            PathRegistryError::AppDataRootNotDirectory(path) => {
                write!(
                    f,
                    "application data root is not a directory: {}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for PathRegistryError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_path_registry_new() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().to_path_buf();

        let registry = PathRegistry::new(path.clone()).unwrap();

        assert_eq!(registry.app_data_root(), &path);
        assert_eq!(registry.kb_root(), &path.join("kb"));
        assert_eq!(registry.draft_root(), &path.join("draft"));
        assert_eq!(registry.index_root(), &path.join("index"));
        assert_eq!(registry.logs_root(), &path.join("logs"));
        assert_eq!(registry.tmp_root(), &path.join("tmp"));
    }

    #[test]
    fn test_path_registry_app_data_root_not_found() {
        let non_existent = PathBuf::from("/tmp/non_existent_shirika_test_dir_12345");
        let result = PathRegistry::new(non_existent.clone());

        assert!(result.is_err());
        match result.unwrap_err() {
            PathRegistryError::AppDataRootNotFound(path) => {
                assert_eq!(path, non_existent);
            }
            _ => panic!("Expected AppDataRootNotFound"),
        }
    }

    #[test]
    fn test_path_registry_app_data_root_not_directory() {
        let temp_dir = TempDir::new().unwrap();
        let temp_file = temp_dir.path().join("test_file.txt");
        fs::write(&temp_file, "test").unwrap();

        let result = PathRegistry::new(temp_file.clone());

        assert!(result.is_err());
        match result.unwrap_err() {
            PathRegistryError::AppDataRootNotDirectory(path) => {
                assert_eq!(path, temp_file);
            }
            _ => panic!("Expected AppDataRootNotDirectory"),
        }
    }

    #[test]
    fn test_path_registry_serialization() {
        let temp_dir = TempDir::new().unwrap();
        let registry = PathRegistry::new(temp_dir.path()).unwrap();

        let json = serde_json::to_string(&registry).unwrap();
        let deserialized: PathRegistry = serde_json::from_str(&json).unwrap();

        assert_eq!(registry.app_data_root(), deserialized.app_data_root());
        assert_eq!(registry.kb_root(), deserialized.kb_root());
        assert_eq!(registry.draft_root(), deserialized.draft_root());
    }
}
