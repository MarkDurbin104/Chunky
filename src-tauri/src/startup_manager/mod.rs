// Startup manager: handles startup lock-file semantics and single-instance coordination
// Ensures only one instance performs extraction at a time via advisory file locking.

pub mod api;
pub mod internal;

pub use internal::lock::{StartupLock, LockError};
pub use api::v1::{StartupMethods, StartupEvent, PathRegistry, PathRegistryError};
