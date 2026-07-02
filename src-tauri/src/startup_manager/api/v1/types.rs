/// Startup lifecycle state enumeration.
/// Represents the current operational mode of the startup-manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum StartupMode {
    /// First-time installation: no prior state exists.
    /// The system initializes from scratch with no existing configuration or data.
    Fresh = 0,

    /// Application upgrade: existing state is present and compatible.
    /// The system migrates from a previous version to the current version.
    Upgrade = 1,

    /// Recovery/repair: existing state requires repair or validation.
    /// The system detects corruption or inconsistency and attempts recovery.
    Repair = 2,

    /// No operation: idle state or explicit no-op.
    /// The system skips startup procedures (used for dry-run or verification).
    None = 3,
}

impl StartupMode {
    /// Returns the numeric representation of the startup mode.
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }

    /// Converts a u8 to a StartupMode, returning None for invalid values.
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(StartupMode::Fresh),
            1 => Some(StartupMode::Upgrade),
            2 => Some(StartupMode::Repair),
            3 => Some(StartupMode::None),
            _ => None,
        }
    }

    /// Returns the string representation of the startup mode.
    pub fn as_str(&self) -> &'static str {
        match self {
            StartupMode::Fresh => "fresh",
            StartupMode::Upgrade => "upgrade",
            StartupMode::Repair => "repair",
            StartupMode::None => "none",
        }
    }
}

impl std::fmt::Display for StartupMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl std::str::FromStr for StartupMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "fresh" => Ok(StartupMode::Fresh),
            "upgrade" => Ok(StartupMode::Upgrade),
            "repair" => Ok(StartupMode::Repair),
            "none" => Ok(StartupMode::None),
            _ => Err(format!("Invalid startup mode: {}", s)),
        }
    }
}

/// Startup lifecycle state and metadata.
/// Contains the current mode and contextual information about the startup process.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StartupLifecycle {
    /// The current startup mode.
    pub mode: StartupMode,

    /// Optional reason or context for the current mode.
    /// Useful for logging and debugging state transitions.
    pub reason: Option<String>,

    /// Timestamp when the current state was entered (milliseconds since epoch).
    pub timestamp_ms: u64,
}

impl StartupLifecycle {
    /// Creates a new StartupLifecycle with the given mode.
    pub fn new(mode: StartupMode) -> Self {
        Self {
            mode,
            reason: None,
            timestamp_ms: current_timestamp_ms(),
        }
    }

    /// Creates a new StartupLifecycle with a reason.
    pub fn with_reason(mode: StartupMode, reason: impl Into<String>) -> Self {
        Self {
            mode,
            reason: Some(reason.into()),
            timestamp_ms: current_timestamp_ms(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_startup_mode_as_u8() {
        assert_eq!(StartupMode::Fresh.as_u8(), 0);
        assert_eq!(StartupMode::Upgrade.as_u8(), 1);
        assert_eq!(StartupMode::Repair.as_u8(), 2);
        assert_eq!(StartupMode::None.as_u8(), 3);
    }

    #[test]
    fn test_startup_mode_from_u8() {
        assert_eq!(StartupMode::from_u8(0), Some(StartupMode::Fresh));
        assert_eq!(StartupMode::from_u8(1), Some(StartupMode::Upgrade));
        assert_eq!(StartupMode::from_u8(2), Some(StartupMode::Repair));
        assert_eq!(StartupMode::from_u8(3), Some(StartupMode::None));
        assert_eq!(StartupMode::from_u8(99), None);
    }

    #[test]
    fn test_startup_mode_as_str() {
        assert_eq!(StartupMode::Fresh.as_str(), "fresh");
        assert_eq!(StartupMode::Upgrade.as_str(), "upgrade");
        assert_eq!(StartupMode::Repair.as_str(), "repair");
        assert_eq!(StartupMode::None.as_str(), "none");
    }

    #[test]
    fn test_startup_mode_display() {
        assert_eq!(StartupMode::Fresh.to_string(), "fresh");
        assert_eq!(StartupMode::Upgrade.to_string(), "upgrade");
        assert_eq!(StartupMode::Repair.to_string(), "repair");
        assert_eq!(StartupMode::None.to_string(), "none");
    }

    #[test]
    fn test_startup_mode_from_str() {
        assert_eq!("fresh".parse::<StartupMode>().unwrap(), StartupMode::Fresh);
        assert_eq!("UPGRADE".parse::<StartupMode>().unwrap(), StartupMode::Upgrade);
        assert_eq!("repair".parse::<StartupMode>().unwrap(), StartupMode::Repair);
        assert_eq!("none".parse::<StartupMode>().unwrap(), StartupMode::None);
        assert!("invalid".parse::<StartupMode>().is_err());
    }
}
