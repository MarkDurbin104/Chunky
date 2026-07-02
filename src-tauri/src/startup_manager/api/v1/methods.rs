use crate::startup_manager::api::v1::events::StartupEvent;
use crate::startup_manager::api::v1::types::{StartupLifecycle, StartupMode};
use crate::startup_manager::internal::orchestrator::Orchestrator;

/// Request envelope for initialize method.
#[derive(Debug, Clone)]
pub struct InitializeRequest {
    pub mode: StartupMode,
    pub reason: Option<String>,
}

/// Response envelope for initialize method.
#[derive(Debug, Clone)]
pub struct InitializeResponse {
    pub success: bool,
    pub lifecycle: StartupLifecycle,
    pub error: Option<String>,
}

/// Request envelope for getState method.
#[derive(Debug, Clone)]
pub struct GetStateRequest;

/// Response envelope for getState method.
#[derive(Debug, Clone)]
pub struct GetStateResponse {
    pub lifecycle: StartupLifecycle,
}

/// Request envelope for repair method.
#[derive(Debug, Clone)]
pub struct RepairRequest {
    pub validate_only: bool,
}

/// Response envelope for repair method.
#[derive(Debug, Clone)]
pub struct RepairResponse {
    pub success: bool,
    pub lifecycle: StartupLifecycle,
    pub issues_found: Vec<String>,
    pub error: Option<String>,
}

/// Startup v1 API methods.
pub struct StartupMethods {
    orchestrator: Orchestrator,
}

impl StartupMethods {
    /// Creates a new StartupMethods instance with the given orchestrator.
    pub fn new(orchestrator: Orchestrator) -> Self {
        Self { orchestrator }
    }

    /// Initializes the startup process with the given mode.
    ///
    /// This method begins the startup lifecycle, transitioning from the initial
    /// state to the specified startup mode. It emits initialization events.
    pub fn initialize(
        &self,
        request: InitializeRequest,
    ) -> Result<InitializeResponse, String> {
        let timestamp_ms = current_timestamp_ms();

        // Emit event: initialization started
        self.orchestrator.emit_event(StartupEvent::InitializeStarted {
            mode: request.mode,
            reason: request.reason.clone(),
            timestamp_ms,
        });

        // Attempt to initialize via orchestrator
        match self
            .orchestrator
            .initialize(request.mode, request.reason.clone())
        {
            Ok(lifecycle) => {
                // Emit event: initialization completed
                self.orchestrator.emit_event(StartupEvent::InitializeCompleted {
                    mode: lifecycle.mode,
                    timestamp_ms: current_timestamp_ms(),
                });

                Ok(InitializeResponse {
                    success: true,
                    lifecycle,
                    error: None,
                })
            }
            Err(e) => {
                let err_msg = e.to_string();
                // Emit event: initialization failed
                self.orchestrator.emit_event(StartupEvent::InitializeFailed {
                    mode: request.mode,
                    error: err_msg.clone(),
                    timestamp_ms: current_timestamp_ms(),
                });

                Err(err_msg)
            }
        }
    }

    /// Returns the current startup state.
    ///
    /// This is a read-only query that returns the current lifecycle state
    /// without modifying any internal state. Emits a state-queried event.
    pub fn get_state(&self, _request: GetStateRequest) -> Result<GetStateResponse, String> {
        let lifecycle = self.orchestrator.get_state().map_err(|e| e.to_string())?;
        let timestamp_ms = current_timestamp_ms();

        // Emit event: state queried
        self.orchestrator.emit_event(StartupEvent::StateQueried {
            mode: lifecycle.mode,
            timestamp_ms,
        });

        Ok(GetStateResponse { lifecycle })
    }

    /// Repairs the startup state, optionally validating without changes.
    ///
    /// This method detects and repairs inconsistencies in the startup state.
    /// If validate_only is true, no repairs are made, only issues are reported.
    pub fn repair(&self, request: RepairRequest) -> Result<RepairResponse, String> {
        let timestamp_ms = current_timestamp_ms();

        // Emit event: repair started
        self.orchestrator.emit_event(StartupEvent::RepairStarted {
            validate_only: request.validate_only,
            timestamp_ms,
        });

        // Perform repair via orchestrator
        match self
            .orchestrator
            .repair(request.validate_only)
        {
            Ok((lifecycle, issues)) => {
                let success = issues.is_empty();
                // Emit event: repair completed
                self.orchestrator.emit_event(StartupEvent::RepairCompleted {
                    success,
                    issues_found: issues.clone(),
                    timestamp_ms: current_timestamp_ms(),
                });

                Ok(RepairResponse {
                    success,
                    lifecycle,
                    issues_found: issues,
                    error: None,
                })
            }
            Err(e) => {
                let err_msg = e.to_string();
                // Emit event: repair failed
                self.orchestrator.emit_event(StartupEvent::RepairFailed {
                    error: err_msg.clone(),
                    timestamp_ms: current_timestamp_ms(),
                });

                Err(err_msg)
            }
        }
    }
}

/// Returns the current timestamp in milliseconds since epoch.
fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

