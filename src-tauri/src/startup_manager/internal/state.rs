use crate::startup_manager::api::v1::types::{StartupLifecycle, StartupMode};
use std::sync::{Arc, Mutex};

/// Startup state machine that manages lifecycle transitions.
/// 
/// The state machine enforces explicit transitions between startup modes.
/// No implicit transitions are allowed; all state changes must be explicit
/// and go through the transition mechanism.
/// 
/// Transitions are fail-closed: invalid transitions are rejected with an error.
pub struct StateMachine {
    /// Current lifecycle state, protected by a mutex for thread-safe access.
    lifecycle: Arc<Mutex<StartupLifecycle>>,
}

impl StateMachine {
    /// Creates a new state machine in the given initial mode.
    pub fn new(initial_mode: StartupMode) -> Self {
        Self {
            lifecycle: Arc::new(Mutex::new(StartupLifecycle::new(initial_mode))),
        }
    }

    /// Creates a new state machine with an initial mode and reason.
    pub fn with_reason(initial_mode: StartupMode, reason: impl Into<String>) -> Self {
        Self {
            lifecycle: Arc::new(Mutex::new(
                StartupLifecycle::with_reason(initial_mode, reason),
            )),
        }
    }

    /// Returns the current startup mode.
    pub fn current_mode(&self) -> StartupMode {
        self.lifecycle.lock().unwrap().mode
    }

    /// Returns a clone of the current lifecycle state.
    pub fn current_lifecycle(&self) -> StartupLifecycle {
        self.lifecycle.lock().unwrap().clone()
    }

    /// Transitions from the current mode to a new mode if valid.
    /// Returns Ok(()) if the transition is allowed, Err otherwise.
    pub fn transition(&self, new_mode: StartupMode) -> Result<(), StateTransitionError> {
        self.transition_with_reason(new_mode, None)
    }

    /// Transitions with an optional reason.
    pub fn transition_with_reason(
        &self,
        new_mode: StartupMode,
        reason: Option<String>,
    ) -> Result<(), StateTransitionError> {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        let current = lifecycle.mode;

        // Check if the transition is valid
        if !is_valid_transition(current, new_mode) {
            return Err(StateTransitionError::InvalidTransition {
                from: current,
                to: new_mode,
            });
        }

        // Update to the new state
        lifecycle.mode = new_mode;
        lifecycle.reason = reason;
        lifecycle.timestamp_ms = current_timestamp_ms();

        Ok(())
    }
}

impl Clone for StateMachine {
    fn clone(&self) -> Self {
        Self {
            lifecycle: Arc::clone(&self.lifecycle),
        }
    }
}

/// Checks if a transition from one mode to another is valid.
/// 
/// Valid transitions are:
/// - Fresh → Upgrade, Repair, None
/// - Upgrade → Repair, None
/// - Repair → Upgrade, None
/// - None → Fresh, Upgrade, Repair
/// 
/// Invalid transitions (self-loops) are not allowed.
fn is_valid_transition(from: StartupMode, to: StartupMode) -> bool {
    match (from, to) {
        // Same mode is not allowed
        (m1, m2) if m1 == m2 => false,

        // From Fresh
        (StartupMode::Fresh, StartupMode::Upgrade) => true,
        (StartupMode::Fresh, StartupMode::Repair) => true,
        (StartupMode::Fresh, StartupMode::None) => true,

        // From Upgrade
        (StartupMode::Upgrade, StartupMode::Repair) => true,
        (StartupMode::Upgrade, StartupMode::None) => true,
        (StartupMode::Upgrade, StartupMode::Fresh) => false,

        // From Repair
        (StartupMode::Repair, StartupMode::Upgrade) => true,
        (StartupMode::Repair, StartupMode::None) => true,
        (StartupMode::Repair, StartupMode::Fresh) => false,

        // From None
        (StartupMode::None, StartupMode::Fresh) => true,
        (StartupMode::None, StartupMode::Upgrade) => true,
        (StartupMode::None, StartupMode::Repair) => true,

        // The compiler cannot prove the guard above covers every same-mode
        // pair; explicit wildcard for any remaining case (which only fires
        // for self-loops anyway).
        _ => false,
    }
}

/// Error type for state machine operations.
#[derive(Debug, Clone)]
pub enum StateTransitionError {
    /// Attempted an invalid state transition.
    InvalidTransition {
        from: StartupMode,
        to: StartupMode,
    },
}

impl std::fmt::Display for StateTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateTransitionError::InvalidTransition { from, to } => {
                write!(
                    f,
                    "Invalid state transition from {} to {}",
                    from, to
                )
            }
        }
    }
}

impl std::error::Error for StateTransitionError {}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_machine_creation() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert_eq!(sm.current_mode(), StartupMode::Fresh);
    }

    #[test]
    fn test_state_machine_with_reason() {
        let sm = StateMachine::with_reason(StartupMode::Fresh, "First time setup");
        assert_eq!(sm.current_mode(), StartupMode::Fresh);
        let lifecycle = sm.current_lifecycle();
        assert_eq!(lifecycle.reason.as_deref(), Some("First time setup"));
    }

    #[test]
    fn test_valid_transition_fresh_to_upgrade() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert!(sm.transition(StartupMode::Upgrade).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Upgrade);
    }

    #[test]
    fn test_valid_transition_fresh_to_repair() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert!(sm.transition(StartupMode::Repair).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Repair);
    }

    #[test]
    fn test_valid_transition_fresh_to_none() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert!(sm.transition(StartupMode::None).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::None);
    }

    #[test]
    fn test_valid_transition_upgrade_to_repair() {
        let sm = StateMachine::new(StartupMode::Upgrade);
        assert!(sm.transition(StartupMode::Repair).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Repair);
    }

    #[test]
    fn test_valid_transition_upgrade_to_none() {
        let sm = StateMachine::new(StartupMode::Upgrade);
        assert!(sm.transition(StartupMode::None).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::None);
    }

    #[test]
    fn test_valid_transition_repair_to_upgrade() {
        let sm = StateMachine::new(StartupMode::Repair);
        assert!(sm.transition(StartupMode::Upgrade).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Upgrade);
    }

    #[test]
    fn test_valid_transition_repair_to_none() {
        let sm = StateMachine::new(StartupMode::Repair);
        assert!(sm.transition(StartupMode::None).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::None);
    }

    #[test]
    fn test_valid_transition_none_to_fresh() {
        let sm = StateMachine::new(StartupMode::None);
        assert!(sm.transition(StartupMode::Fresh).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Fresh);
    }

    #[test]
    fn test_valid_transition_none_to_upgrade() {
        let sm = StateMachine::new(StartupMode::None);
        assert!(sm.transition(StartupMode::Upgrade).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Upgrade);
    }

    #[test]
    fn test_valid_transition_none_to_repair() {
        let sm = StateMachine::new(StartupMode::None);
        assert!(sm.transition(StartupMode::Repair).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Repair);
    }

    #[test]
    fn test_invalid_transition_upgrade_to_fresh() {
        let sm = StateMachine::new(StartupMode::Upgrade);
        let result = sm.transition(StartupMode::Fresh);
        assert!(result.is_err());
        assert_eq!(sm.current_mode(), StartupMode::Upgrade);
    }

    #[test]
    fn test_invalid_transition_repair_to_fresh() {
        let sm = StateMachine::new(StartupMode::Repair);
        let result = sm.transition(StartupMode::Fresh);
        assert!(result.is_err());
        assert_eq!(sm.current_mode(), StartupMode::Repair);
    }

    #[test]
    fn test_invalid_self_transition() {
        let sm = StateMachine::new(StartupMode::Fresh);
        let result = sm.transition(StartupMode::Fresh);
        assert!(result.is_err());
        assert_eq!(sm.current_mode(), StartupMode::Fresh);
    }

    #[test]
    fn test_transition_with_reason() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert!(sm
            .transition_with_reason(StartupMode::Upgrade, Some("Version 2.0 upgrade".to_string()))
            .is_ok());
        let lifecycle = sm.current_lifecycle();
        assert_eq!(lifecycle.mode, StartupMode::Upgrade);
        assert_eq!(lifecycle.reason.as_deref(), Some("Version 2.0 upgrade"));
    }

    #[test]
    fn test_multiple_transitions() {
        let sm = StateMachine::new(StartupMode::Fresh);
        assert!(sm.transition(StartupMode::Upgrade).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Upgrade);
        assert!(sm.transition(StartupMode::Repair).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::Repair);
        assert!(sm.transition(StartupMode::None).is_ok());
        assert_eq!(sm.current_mode(), StartupMode::None);
    }

    #[test]
    fn test_cloned_state_machine_shares_state() {
        let sm1 = StateMachine::new(StartupMode::Fresh);
        let sm2 = sm1.clone();

        assert!(sm1.transition(StartupMode::Upgrade).is_ok());
        assert_eq!(sm2.current_mode(), StartupMode::Upgrade);
    }
}
