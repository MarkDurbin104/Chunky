use crate::startup_manager::api::v1::types::StartupMode;
use serde::{Deserialize, Serialize};

/// Startup v1 event types for pub/sub and audit logging.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StartupEvent {
    /// Initialization started.
    InitializeStarted {
        mode: StartupMode,
        reason: Option<String>,
        timestamp_ms: u64,
    },

    /// Initialization completed successfully.
    InitializeCompleted {
        mode: StartupMode,
        timestamp_ms: u64,
    },

    /// Initialization failed.
    InitializeFailed {
        mode: StartupMode,
        error: String,
        timestamp_ms: u64,
    },

    /// State query executed.
    StateQueried {
        mode: StartupMode,
        timestamp_ms: u64,
    },

    /// Repair started.
    RepairStarted {
        validate_only: bool,
        timestamp_ms: u64,
    },

    /// Repair completed with issues found.
    RepairCompleted {
        success: bool,
        issues_found: Vec<String>,
        timestamp_ms: u64,
    },

    /// Repair failed with error.
    RepairFailed {
        error: String,
        timestamp_ms: u64,
    },

    /// State transition occurred.
    StateTransitioned {
        from: StartupMode,
        to: StartupMode,
        reason: Option<String>,
        timestamp_ms: u64,
    },
}

impl StartupEvent {
    /// Returns the timestamp of the event.
    pub fn timestamp_ms(&self) -> u64 {
        match self {
            StartupEvent::InitializeStarted { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::InitializeCompleted { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::InitializeFailed { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::StateQueried { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::RepairStarted { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::RepairCompleted { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::RepairFailed { timestamp_ms, .. } => *timestamp_ms,
            StartupEvent::StateTransitioned { timestamp_ms, .. } => *timestamp_ms,
        }
    }

    /// Returns the event type name as a string.
    pub fn event_type(&self) -> &'static str {
        match self {
            StartupEvent::InitializeStarted { .. } => "initialize_started",
            StartupEvent::InitializeCompleted { .. } => "initialize_completed",
            StartupEvent::InitializeFailed { .. } => "initialize_failed",
            StartupEvent::StateQueried { .. } => "state_queried",
            StartupEvent::RepairStarted { .. } => "repair_started",
            StartupEvent::RepairCompleted { .. } => "repair_completed",
            StartupEvent::RepairFailed { .. } => "repair_failed",
            StartupEvent::StateTransitioned { .. } => "state_transitioned",
        }
    }

    /// Describes which external event should be emitted for this internal event.
    ///
    /// This is used by the event bus to transform internal events into external
    /// events consumable by the UI and observability systems.
    ///
    /// Returns Some((event_name, mode_str, error_reason)) for external events,
    /// or None if this event should not be exposed externally.
    pub fn external_event_info(&self) -> Option<(&'static str, Option<String>, Option<String>)> {
        match self {
            StartupEvent::InitializeCompleted { mode, .. } => {
                Some(("startup.initialized", Some(format!("{:?}", mode)), None))
            }
            StartupEvent::InitializeFailed { error, .. } => {
                Some(("startup.failed", None, Some(error.clone())))
            }
            StartupEvent::RepairStarted { .. } => {
                Some(("startup.repair_started", None, None))
            }
            StartupEvent::RepairFailed { error, .. } => {
                Some(("startup.failed", None, Some(error.clone())))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_timestamp_extraction() {
        let event = StartupEvent::InitializeStarted {
            mode: StartupMode::Fresh,
            reason: None,
            timestamp_ms: 12345,
        };
        assert_eq!(event.timestamp_ms(), 12345);
    }

    #[test]
    fn test_event_type_names() {
        let events = vec![
            (
                StartupEvent::InitializeStarted {
                    mode: StartupMode::Fresh,
                    reason: None,
                    timestamp_ms: 0,
                },
                "initialize_started",
            ),
            (
                StartupEvent::InitializeCompleted {
                    mode: StartupMode::Upgrade,
                    timestamp_ms: 0,
                },
                "initialize_completed",
            ),
            (
                StartupEvent::StateQueried {
                    mode: StartupMode::Fresh,
                    timestamp_ms: 0,
                },
                "state_queried",
            ),
            (
                StartupEvent::RepairStarted {
                    validate_only: false,
                    timestamp_ms: 0,
                },
                "repair_started",
            ),
        ];

        for (event, expected_type) in events {
            assert_eq!(event.event_type(), expected_type);
        }
    }

    #[test]
    fn test_event_serialization() {
        let event = StartupEvent::InitializeStarted {
            mode: StartupMode::Fresh,
            reason: Some("First setup".to_string()),
            timestamp_ms: 1234567890,
        };
        let json = serde_json::to_string(&event).expect("Failed to serialize");
        assert!(json.contains("initialize_started"));
        assert!(json.contains("First setup"));
    }

    #[test]
    fn test_external_event_info() {
        let initialized = StartupEvent::InitializeCompleted {
            mode: StartupMode::Fresh,
            timestamp_ms: 12345,
        };
        let info = initialized.external_event_info();
        assert!(info.is_some());
        let (event_name, mode, error) = info.unwrap();
        assert_eq!(event_name, "startup.initialized");
        assert!(mode.is_some());
        assert!(error.is_none());

        let failed = StartupEvent::InitializeFailed {
            mode: StartupMode::Fresh,
            error: "IO error".to_string(),
            timestamp_ms: 12345,
        };
        let info = failed.external_event_info();
        assert!(info.is_some());
        let (event_name, mode, error) = info.unwrap();
        assert_eq!(event_name, "startup.failed");
        assert!(mode.is_none());
        assert_eq!(error.unwrap(), "IO error");

        let repair_started = StartupEvent::RepairStarted {
            validate_only: false,
            timestamp_ms: 12345,
        };
        let info = repair_started.external_event_info();
        assert!(info.is_some());
        let (event_name, _, _) = info.unwrap();
        assert_eq!(event_name, "startup.repair_started");

        let state_queried = StartupEvent::StateQueried {
            mode: StartupMode::Fresh,
            timestamp_ms: 12345,
        };
        assert!(state_queried.external_event_info().is_none());
    }
}
