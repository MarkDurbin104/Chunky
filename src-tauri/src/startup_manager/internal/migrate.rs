use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::fs;
use sha2::{Sha256, Digest};

/// Migration tracking error enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    /// Could not read migration file
    FileNotFound,
    /// Migration content differs from recorded checksum
    ChecksumMismatch,
    /// Invalid migration version (must be positive integer)
    InvalidVersion,
    /// Migration SQL is empty
    EmptyMigration,
    /// Migration already applied
    AlreadyApplied,
    /// Database operation failed
    DbError,
    /// Invalid migration path (traversal attack)
    InvalidPath,
    /// Migration version already exists with different content
    DuplicateVersion,
    /// Invalid UTF-8 in migration file
    InvalidUtf8,
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::FileNotFound => write!(f, "migration file not found"),
            MigrationError::ChecksumMismatch => write!(f, "migration checksum mismatch (file modified?)"),
            MigrationError::InvalidVersion => write!(f, "migration version must be positive integer"),
            MigrationError::EmptyMigration => write!(f, "migration SQL is empty"),
            MigrationError::AlreadyApplied => write!(f, "migration already applied"),
            MigrationError::DbError => write!(f, "database operation failed"),
            MigrationError::InvalidPath => write!(f, "invalid migration path (traversal attack)"),
            MigrationError::DuplicateVersion => write!(f, "duplicate migration version with different content"),
            MigrationError::InvalidUtf8 => write!(f, "invalid UTF-8 in migration file"),
        }
    }
}

impl std::error::Error for MigrationError {}

/// Applied migration record from schema_migrations table
#[derive(Debug, Clone)]
pub struct AppliedMigration {
    pub version: u32,
    pub name: String,
    pub checksum: String,
    pub applied_at: i64,
}

/// Pending migration to be executed
#[derive(Debug, Clone)]
pub struct Migration {
    pub version: u32,
    pub name: String,
    pub sql: String,
    pub checksum: String,
}

impl Migration {
    /// Create a new migration from version, name, and SQL content
    pub fn new(version: u32, name: &str, sql: &str) -> Result<Self, MigrationError> {
        if version == 0 {
            return Err(MigrationError::InvalidVersion);
        }
        if sql.trim().is_empty() {
            return Err(MigrationError::EmptyMigration);
        }

        let checksum = compute_checksum(sql);
        Ok(Migration {
            version,
            name: name.to_string(),
            sql: sql.to_string(),
            checksum,
        })
    }

    /// Compute checksum of migration SQL (SHA-256 hex)
    pub fn compute_checksum(&self) -> String {
        compute_checksum(&self.sql)
    }

    /// Verify that migration content matches its stored checksum
    pub fn verify_checksum(&self, stored_checksum: &str) -> bool {
        self.compute_checksum() == stored_checksum
    }
}

/// Migration runner: executes migrations with tracking
/// Generic over database connection type to allow different database drivers
pub struct MigrationRunner<Conn> {
    migrations_dir: PathBuf,
    conn: Conn,
}

impl<Conn> MigrationRunner<Conn> {
    /// Create a new migration runner
    pub fn new<P: AsRef<Path>>(migrations_dir: P, conn: Conn) -> Result<Self, MigrationError> {
        let migrations_dir = migrations_dir.as_ref().to_path_buf();
        
        // Validate migrations directory path (prevent traversal)
        if migrations_dir.to_string_lossy().contains("..") {
            return Err(MigrationError::InvalidPath);
        }

        Ok(MigrationRunner {
            migrations_dir,
            conn,
        })
    }

    /// Get reference to underlying connection
    pub fn conn(&self) -> &Conn {
        &self.conn
    }

    /// Get mutable reference to underlying connection
    pub fn conn_mut(&mut self) -> &mut Conn {
        &mut self.conn
    }

    /// Consume runner and return connection
    pub fn into_conn(self) -> Conn {
        self.conn
    }

    /// Get the migrations directory path
    pub fn migrations_dir(&self) -> &Path {
        &self.migrations_dir
    }
}

/// Trait for database connection to execute migrations
/// Implementors must support:
/// - Creating schema_migrations table
/// - Recording applied migrations
/// - Querying applied migrations
/// - Executing arbitrary SQL in transactions
pub trait MigrationDb {
    /// Initialize the schema_migrations table if not exists
    /// Table schema:
    /// CREATE TABLE IF NOT EXISTS schema_migrations (
    ///     version INTEGER PRIMARY KEY,
    ///     name TEXT NOT NULL,
    ///     checksum TEXT NOT NULL,
    ///     applied_at INTEGER NOT NULL
    /// );
    fn init_migrations_table(&mut self) -> Result<(), MigrationError>;

    /// Get list of already-applied migrations, sorted by version ASC
    fn get_applied_migrations(&self) -> Result<Vec<AppliedMigration>, MigrationError>;

    /// Execute a migration in a transaction
    /// Must:
    /// 1. Run the migration SQL
    /// 2. Record in schema_migrations
    /// 3. Atomically commit or rollback on error
    fn execute_migration(&mut self, migration: &Migration) -> Result<(), MigrationError>;

    /// Verify that a migration's checksum matches the recorded value
    /// Returns error if mismatch detected (indicates file was modified)
    fn verify_migration_checksum(&self, version: u32, expected_checksum: &str) -> Result<bool, MigrationError>;
}

/// Migration discovery: find all migration files in migrations directory
/// File naming convention: NNNN_name.sql (e.g., 0001_init.sql, 0002_add_users.sql)
pub fn discover_migrations<P: AsRef<Path>>(migrations_dir: P) -> Result<Vec<Migration>, MigrationError> {
    let migrations_dir = migrations_dir.as_ref();
    
    if !migrations_dir.exists() {
        return Ok(vec![]);
    }

    let mut migrations = Vec::new();
    let mut versions = HashMap::new();

    // Read all .sql files from migrations directory
    for entry in fs::read_dir(migrations_dir).map_err(|_| MigrationError::DbError)? {
        let entry = entry.map_err(|_| MigrationError::DbError)?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) == Some("sql") {
            let filename = path.file_name().unwrap().to_string_lossy().to_string();
            
            // Parse version from filename (first 4 digits)
            let version_str = &filename[..4.min(filename.len())];
            let version = version_str.parse::<u32>()
                .map_err(|_| MigrationError::InvalidVersion)?;

            if version == 0 {
                return Err(MigrationError::InvalidVersion);
            }

            // Extract name from filename (everything after NNNN_)
            let name = if filename.len() > 5 && &filename[4..5] == "_" {
                filename[5..].replace(".sql", "").replace("_", " ")
            } else {
                return Err(MigrationError::InvalidVersion);
            };

            // Read migration file
            let sql = fs::read_to_string(&path)
                .map_err(|_| MigrationError::FileNotFound)?;

            let migration = Migration::new(version, &name, &sql)?;

            // Detect duplicate versions with different content
            if let Some(existing) = versions.get(&version) {
                if existing != &migration.checksum {
                    return Err(MigrationError::DuplicateVersion);
                }
            }
            versions.insert(version, migration.checksum.clone());

            migrations.push(migration);
        }
    }

    // Sort migrations by version
    migrations.sort_by_key(|m| m.version);

    Ok(migrations)
}

/// Compute SHA-256 checksum of migration SQL (hex string)
fn compute_checksum(sql: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_new_valid() {
        let migration = Migration::new(1, "init", "CREATE TABLE users (id INT);").unwrap();
        assert_eq!(migration.version, 1);
        assert_eq!(migration.name, "init");
        assert!(!migration.checksum.is_empty());
    }

    #[test]
    fn test_migration_new_zero_version() {
        let result = Migration::new(0, "init", "CREATE TABLE users (id INT);");
        assert!(matches!(result, Err(MigrationError::InvalidVersion)));
    }

    #[test]
    fn test_migration_new_empty_sql() {
        let result = Migration::new(1, "init", "   ");
        assert!(matches!(result, Err(MigrationError::EmptyMigration)));
    }

    #[test]
    fn test_migration_checksum_stable() {
        let sql = "CREATE TABLE users (id INT);";
        let m1 = Migration::new(1, "init", sql).unwrap();
        let m2 = Migration::new(2, "other", sql).unwrap();
        assert_eq!(m1.checksum, m2.checksum);
    }

    #[test]
    fn test_migration_checksum_differs() {
        let m1 = Migration::new(1, "init", "CREATE TABLE users (id INT);").unwrap();
        let m2 = Migration::new(1, "init", "CREATE TABLE users (id TEXT);").unwrap();
        assert_ne!(m1.checksum, m2.checksum);
    }

    #[test]
    fn test_migration_verify_checksum_match() {
        let migration = Migration::new(1, "init", "CREATE TABLE users (id INT);").unwrap();
        let checksum = migration.compute_checksum();
        assert!(migration.verify_checksum(&checksum));
    }

    #[test]
    fn test_migration_verify_checksum_mismatch() {
        let migration = Migration::new(1, "init", "CREATE TABLE users (id INT);").unwrap();
        assert!(!migration.verify_checksum("invalid_checksum"));
    }

    #[test]
    fn test_migration_runner_new_valid_path() {
        struct DummyConn;
        let runner = MigrationRunner::new("/tmp/migrations", DummyConn);
        assert!(runner.is_ok());
    }

    #[test]
    fn test_migration_runner_new_traversal_rejected() {
        struct DummyConn;
        let runner = MigrationRunner::new("../migrations", DummyConn);
        assert!(matches!(runner, Err(MigrationError::InvalidPath)));
    }

    #[test]
    fn test_compute_checksum_deterministic() {
        let sql = "CREATE TABLE users (id INT);";
        let cs1 = compute_checksum(sql);
        let cs2 = compute_checksum(sql);
        assert_eq!(cs1, cs2);
    }

    #[test]
    fn test_compute_checksum_different_content() {
        let cs1 = compute_checksum("CREATE TABLE users (id INT);");
        let cs2 = compute_checksum("CREATE TABLE users (id TEXT);");
        assert_ne!(cs1, cs2);
    }

    #[test]
    fn test_applied_migration_construct() {
        let applied = AppliedMigration {
            version: 1,
            name: "init".to_string(),
            checksum: "abc123".to_string(),
            applied_at: 1234567890,
        };
        assert_eq!(applied.version, 1);
        assert_eq!(applied.name, "init");
    }

    #[test]
    fn test_migration_error_display() {
        assert_eq!(
            MigrationError::FileNotFound.to_string(),
            "migration file not found"
        );
        assert_eq!(
            MigrationError::ChecksumMismatch.to_string(),
            "migration checksum mismatch (file modified?)"
        );
        assert_eq!(
            MigrationError::InvalidVersion.to_string(),
            "migration version must be positive integer"
        );
    }
}
