use std::fs::{File, OpenOptions};
use std::io::Result as IoResult;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH, Duration};

#[derive(Debug)]
pub struct StartupLock {
    lock_file: PathBuf,
    file: Option<File>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockError {
    /// Lock file is held by another process
    LockHeld,
    /// Lock file exists but cannot be verified as stale/fresh (I/O error)
    IoError,
    /// Lock acquisition exceeded the specified timeout
    Timeout,
    /// Lock was not acquired (tried to release without holding)
    NotHeld,
    /// Stale lock detected; explicit recovery required
    StaleDetected,
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::LockHeld => write!(f, "lock file is held by another process"),
            LockError::IoError => write!(f, "I/O error accessing lock file"),
            LockError::Timeout => write!(f, "lock acquisition exceeded timeout"),
            LockError::NotHeld => write!(f, "lock not held"),
            LockError::StaleDetected => write!(f, "stale lock detected; explicit recovery required"),
        }
    }
}

impl std::error::Error for LockError {}

impl StartupLock {
    /// Create a new startup lock reference for the given path.
    /// Does not acquire the lock yet.
    pub fn new<P: AsRef<Path>>(lock_file: P) -> Self {
        StartupLock {
            lock_file: lock_file.as_ref().to_path_buf(),
            file: None,
        }
    }

    /// Acquire the lock with a timeout.
    /// Returns an error if the lock is held, stale, or timeout expires.
    pub fn acquire(&mut self, timeout: Duration) -> Result<(), LockError> {
        if self.file.is_some() {
            return Err(LockError::NotHeld); // Already holding a lock
        }

        let start = SystemTime::now();
        let deadline = start + timeout;

        loop {
            match self.try_acquire() {
                Ok(()) => return Ok(()),
                Err(LockError::LockHeld) => {
                    if SystemTime::now() >= deadline {
                        return Err(LockError::Timeout);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Try to acquire the lock immediately without blocking.
    fn try_acquire(&mut self) -> Result<(), LockError> {
        // Create parent directories if needed
        if let Some(parent) = self.lock_file.parent() {
            std::fs::create_dir_all(parent).map_err(|_| LockError::IoError)?;
        }

        // Windows: exclusive create-new semantics. If another process
        // already holds the file, create_new fails → treat as held.
        // Unix path uses create+flock instead so multiple processes can
        // open the file but only one holds the advisory lock.
        #[cfg(windows)]
        {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&self.lock_file)
            {
                Ok(f) => {
                    self.file = Some(f);
                    let _ = self.write_timestamp();
                    Ok(())
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Could be a stale lock — allow the caller's
                    // recover_stale path to reclaim it.
                    Err(LockError::LockHeld)
                }
                Err(_) => Err(LockError::IoError),
            }
        }

        #[cfg(unix)]
        {
            let file = OpenOptions::new()
                .write(true)
                .create(true)
                .open(&self.lock_file)
                .map_err(|_| LockError::IoError)?;
            if self.try_flock(&file) {
                self.file = Some(file);
                let _ = self.write_timestamp();
                Ok(())
            } else {
                Err(LockError::LockHeld)
            }
        }
    }

    /// Attempt advisory lock via flock. Unix only — Windows path in
    /// `try_acquire` uses `create_new` for exclusion instead.
    #[cfg(unix)]
    fn try_flock(&self, file: &File) -> bool {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0
        }
    }

    /// Write the current timestamp to the lock file for staleness detection.
    fn write_timestamp(&self) -> IoResult<()> {
        use std::io::Write;
        if let Some(ref file) = self.file {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_else(|_| String::from("0"));
            let mut f = file;
            f.write_all(timestamp.as_bytes())?;
            f.sync_all()?;
        }
        Ok(())
    }

    /// Check if an existing lock file is stale (older than threshold).
    /// Returns true if the lock is stale, false if fresh, and Err if unable to determine.
    pub fn is_stale(&self, threshold: Duration) -> Result<bool, LockError> {
        let metadata = std::fs::metadata(&self.lock_file).map_err(|_| LockError::IoError)?;
        let modified = metadata
            .modified()
            .map_err(|_| LockError::IoError)?;

        let age = SystemTime::now()
            .duration_since(modified)
            .map_err(|_| LockError::IoError)?;

        Ok(age > threshold)
    }

    /// Explicitly recover from a stale lock. Removes the stale lock file.
    /// No silent override: caller must explicitly request recovery.
    pub fn recover_stale(&mut self, threshold: Duration) -> Result<(), LockError> {
        if !self.lock_file.exists() {
            return Ok(());
        }

        // Verify the lock is actually stale before removing it
        if !self.is_stale(threshold)? {
            return Err(LockError::LockHeld);
        }

        // Remove the stale lock file
        std::fs::remove_file(&self.lock_file).map_err(|_| LockError::IoError)?;

        // Now acquire the lock
        self.try_acquire()
    }

    /// Release the lock, if held.
    pub fn release(&mut self) -> Result<(), LockError> {
        // `file` is used on unix to LOCK_UN via flock, and always dropped at
        // end of scope (which closes the fd on both platforms — Windows
        // releases the lock automatically on close).
        if let Some(_file) = self.file.take() {
            #[cfg(unix)]
            {
                use std::os::unix::io::AsRawFd;
                unsafe {
                    libc::flock(_file.as_raw_fd(), libc::LOCK_UN);
                }
            }

            // Remove lock file after release
            let _ = std::fs::remove_file(&self.lock_file);
            Ok(())
        } else {
            Err(LockError::NotHeld)
        }
    }

    /// Check if this lock is currently held (by us).
    pub fn is_held(&self) -> bool {
        self.file.is_some()
    }

    /// Get the lock file path.
    pub fn path(&self) -> &Path {
        &self.lock_file
    }
}

impl Drop for StartupLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Platform-portable test directory. Uses the system temp dir + a
    /// process-unique subfolder so parallel test runs don't collide.
    fn test_dir() -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("chunky_lock_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d
    }

    #[test]
    fn test_lock_new() {
        let path = test_dir().join("test_new.lock");
        let lock = StartupLock::new(&path);
        assert!(!lock.is_held());
        assert_eq!(lock.path(), path.as_path());
    }

    #[test]
    fn test_lock_acquire_release() {
        let lock_path = test_dir().join("lock1.lock");

        let mut lock = StartupLock::new(&lock_path);
        assert!(!lock.is_held());

        // Acquire
        assert!(lock.acquire(Duration::from_secs(1)).is_ok());
        assert!(lock.is_held());

        // Release
        assert!(lock.release().is_ok());
        assert!(!lock.is_held());

        // Cleanup
        let _ = fs::remove_file(&lock_path);
    }

    #[test]
    fn test_lock_already_held() {
        let lock_path = test_dir().join("lock2.lock");

        let mut lock = StartupLock::new(&lock_path);
        assert!(lock.acquire(Duration::from_secs(1)).is_ok());

        // Try to acquire again without releasing (should fail)
        // Note: In our implementation, this returns NotHeld because self.file is Some
        // but we check at the start of acquire()
        assert_eq!(lock.acquire(Duration::from_secs(1)), Err(LockError::NotHeld));

        let _ = lock.release();
        let _ = fs::remove_file(&lock_path);
    }

    #[test]
    fn test_lock_exclusive() {
        let lock_path = test_dir().join("lock3.lock");

        let mut lock1 = StartupLock::new(&lock_path);
        let mut lock2 = StartupLock::new(&lock_path);

        // First lock acquires successfully
        assert!(lock1.acquire(Duration::from_secs(1)).is_ok());
        assert!(lock1.is_held());

        // Second lock cannot acquire (held by first)
        let result = lock2.acquire(Duration::from_millis(100));
        assert_eq!(result, Err(LockError::Timeout));
        assert!(!lock2.is_held());

        let _ = lock1.release();
        let _ = fs::remove_file(&lock_path);
    }

    #[test]
    fn test_stale_lock_detection() {
        let lock_path = test_dir().join("lock4.lock");

        // Create a lock file manually
        let _ = fs::File::create(&lock_path);

        let lock = StartupLock::new(&lock_path);
        
        // Lock should not be stale with a very short threshold
        assert_eq!(lock.is_stale(Duration::from_secs(0)), Ok(true));
        
        // Lock should not be stale with a very long threshold
        assert_eq!(lock.is_stale(Duration::from_secs(3600)), Ok(false));

        let _ = fs::remove_file(&lock_path);
    }

    #[test]
    fn test_stale_lock_recovery() {
        let lock_path = test_dir().join("lock5.lock");

        // Create an old lock file
        let _ = fs::File::create(&lock_path);
        std::thread::sleep(Duration::from_millis(10));

        let mut lock = StartupLock::new(&lock_path);
        
        // Lock should be detectable as stale
        assert_eq!(lock.is_stale(Duration::from_secs(0)), Ok(true));

        // Recover from stale lock
        assert!(lock.recover_stale(Duration::from_secs(0)).is_ok());
        assert!(lock.is_held());

        let _ = lock.release();
        let _ = fs::remove_file(&lock_path);
    }

    #[test]
    fn test_release_without_acquire() {
        let mut lock = StartupLock::new(test_dir().join("test_release.lock"));
        assert!(matches!(lock.release(), Err(LockError::NotHeld)));
    }
}
