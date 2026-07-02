use crate::startup_manager::api::v1::events::StartupEvent;
use crate::startup_manager::api::v1::types::{StartupLifecycle, StartupMode};
use crate::startup_manager::internal::state::{StateMachine, StateTransitionError};
use std::sync::{Arc, Mutex};

/// Event publisher callback type for startup events.
type EventPublisher = Arc<Mutex<Box<dyn Fn(StartupEvent) + Send + Sync>>>;

/// Orchestrator coordinates startup initialization, state queries, and repairs.
///
/// It manages the state machine lifecycle and publishes events for all operations.
/// This is the central hub that delegates to internal components.
pub struct Orchestrator {
    state_machine: StateMachine,
    event_publisher: Option<EventPublisher>,
}

impl Orchestrator {
    /// Creates a new orchestrator with the given initial startup mode.
    pub fn new(initial_mode: StartupMode) -> Self {
        Self {
            state_machine: StateMachine::new(initial_mode),
            event_publisher: None,
        }
    }

    /// Creates a new orchestrator with an initial mode and reason.
    pub fn with_reason(initial_mode: StartupMode, reason: impl Into<String>) -> Self {
        Self {
            state_machine: StateMachine::with_reason(initial_mode, reason),
            event_publisher: None,
        }
    }

    /// Sets a custom event publisher callback.
    ///
    /// The publisher will be called for all events emitted by the orchestrator.
    /// If no publisher is set, events are silently discarded (no-op).
    pub fn set_event_publisher<F>(&mut self, publisher: F)
    where
        F: Fn(StartupEvent) + Send + Sync + 'static,
    {
        self.event_publisher = Some(Arc::new(Mutex::new(Box::new(publisher))));
    }

    /// Emits an event if a publisher is registered.
    pub fn emit_event(&self, event: StartupEvent) {
        if let Some(publisher) = &self.event_publisher {
            if let Ok(publisher) = publisher.lock() {
                publisher(event);
            }
        }
    }

    /// Initializes the startup process, transitioning to the given mode.
    pub fn initialize(
        &self,
        mode: StartupMode,
        reason: Option<String>,
    ) -> Result<StartupLifecycle, OrchestratorError> {
        // Attempt state transition
        self.state_machine
            .transition_with_reason(mode, reason.clone())
            .map_err(|e| OrchestratorError::StateTransitionFailed(e.to_string()))?;

        // Emit state transition event
        let lifecycle = self.state_machine.current_lifecycle();
        self.emit_event(StartupEvent::StateTransitioned {
            from: lifecycle.mode,
            to: mode,
            reason,
            timestamp_ms: lifecycle.timestamp_ms,
        });

        Ok(lifecycle)
    }

    /// Queries and returns the current startup state.
    pub fn get_state(&self) -> Result<StartupLifecycle, OrchestratorError> {
        Ok(self.state_machine.current_lifecycle())
    }

    /// Repairs the startup state.
    ///
    /// If validate_only is false, performs repairs on detected issues.
    /// If validate_only is true, only detects issues without repairing.
    ///
    /// Returns Ok((lifecycle, issues_found)) where issues_found is a list
    /// of problems detected (and repaired if validate_only is false).
    pub fn repair(
        &self,
        validate_only: bool,
    ) -> Result<(StartupLifecycle, Vec<String>), OrchestratorError> {
        // Get current state
        let lifecycle = self.state_machine.current_lifecycle();

        // Detect issues in current state
        let mut issues = vec![];

        // Check for state consistency
        // Note: This is a simplified validation. In a real system, this would
        // check for file corruption, missing state directories, incompatible
        // versions, etc.
        if let Some(reason) = &lifecycle.reason {
            if reason.is_empty() {
                issues.push("Empty reason string in lifecycle".to_string());
            }
        }

        // If we detected issues and validate_only is false, repair them
        if !issues.is_empty() && !validate_only {
            // Attempt to transition to Repair mode for recovery
            if lifecycle.mode != StartupMode::Repair {
                self.state_machine
                    .transition_with_reason(
                        StartupMode::Repair,
                        Some("Auto-repair triggered by validation".to_string()),
                    )
                    .map_err(|e| OrchestratorError::RepairFailed(e.to_string()))?;
            }
        }

        // Return the (possibly updated) lifecycle and detected issues
        let final_lifecycle = self.state_machine.current_lifecycle();
        Ok((final_lifecycle, issues))
    }
}

impl Clone for Orchestrator {
    fn clone(&self) -> Self {
        Self {
            state_machine: self.state_machine.clone(),
            event_publisher: self.event_publisher.clone(),
        }
    }
}

/// Error type for orchestrator operations.
#[derive(Debug, Clone)]
pub enum OrchestratorError {
    /// State transition failed.
    StateTransitionFailed(String),

    /// Repair operation failed.
    RepairFailed(String),

    /// General orchestrator error.
    Other(String),
}

impl std::fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrchestratorError::StateTransitionFailed(msg) => write!(f, "State transition failed: {}", msg),
            OrchestratorError::RepairFailed(msg) => write!(f, "Repair failed: {}", msg),
            OrchestratorError::Other(msg) => write!(f, "Orchestrator error: {}", msg),
        }
    }
}

impl std::error::Error for OrchestratorError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orchestrator_creation() {
        let orch = Orchestrator::new(StartupMode::Fresh);
        assert_eq!(orch.get_state().unwrap().mode, StartupMode::Fresh);
    }

    #[test]
    fn test_orchestrator_with_reason() {
        let orch = Orchestrator::with_reason(StartupMode::Fresh, "Initial setup");
        let state = orch.get_state().unwrap();
        assert_eq!(state.mode, StartupMode::Fresh);
        assert_eq!(state.reason.as_deref(), Some("Initial setup"));
    }

    #[test]
    fn test_orchestrator_initialization() {
        let orch = Orchestrator::new(StartupMode::Fresh);
        let result = orch.initialize(StartupMode::Upgrade, None);
        assert!(result.is_ok());
        assert_eq!(orch.get_state().unwrap().mode, StartupMode::Upgrade);
    }

    #[test]
    fn test_orchestrator_event_emission() {
        let orch = Orchestrator::new(StartupMode::Fresh);
        let events = Arc::new(Mutex::new(vec![]));
        let events_clone = Arc::clone(&events);

        {
            let mut orch_mut = orch.clone();
            orch_mut.set_event_publisher(move |event| {
                events_clone.lock().unwrap().push(event.event_type().to_string());
            });

            orch_mut.emit_event(StartupEvent::InitializeStarted {
                mode: StartupMode::Fresh,
                reason: None,
                timestamp_ms: 0,
            });
        }

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0], "initialize_started");
    }

    #[test]
    fn test_orchestrator_repair() {
        let orch = Orchestrator::new(StartupMode::Fresh);
        let (lifecycle, issues) = orch.repair(true).unwrap();
        assert_eq!(lifecycle.mode, StartupMode::Fresh);
        // No issues should be found in a fresh state with valid setup
        assert!(issues.is_empty());
    }

    #[test]
    fn test_orchestrator_clone_shares_state() {
        let orch1 = Orchestrator::new(StartupMode::Fresh);
        let orch2 = orch1.clone();

        orch1.initialize(StartupMode::Upgrade, None).unwrap();
        assert_eq!(orch2.get_state().unwrap().mode, StartupMode::Upgrade);
    }
}
