import Foundation

/// Device events implied by a change of the applied engine state. Shared by the app (sync/foreground) and,
/// in a later stage, the DeviceActivityMonitor extension. Both record the state they applied in
/// `CachedState.engineState`, so whichever observes a transition first emits it and the other sees none.
public enum WorkModeEvents {
    /// States in which Work Mode is in force (shields up, or relaxed only by a policy-compliant break).
    public static func isActive(_ state: WorkModeState) -> Bool {
        switch state {
        case .working, .shiftEnding, .onBreak:
            return true
        case .offShift, .shiftStartingSoon, .managerOverride, .permissionError, .syncError, .unknown:
            return false
        }
    }

    /// True for states that say nothing about whether the shift ended (they must not emit WORK_MODE_ENDED).
    private static func isIndeterminate(_ state: WorkModeState) -> Bool {
        switch state {
        case .permissionError, .syncError, .unknown:
            return true
        case .offShift, .shiftStartingSoon, .working, .onBreak, .shiftEnding, .managerOverride:
            return false
        }
    }

    /// WORK_MODE_STARTED when entering an active state, WORK_MODE_ENDED when leaving one for a determinate
    /// inactive state. `previous` nil means nothing was applied yet.
    public static func transitionEvents(from previous: WorkModeState?, to current: ExpectedState, at instant: Date) -> [DeviceEvent] {
        let wasActive = previous.map(isActive) ?? false
        let isNowActive = isActive(current.state)
        if !wasActive && isNowActive {
            return [DeviceEvent(
                type: .workModeStarted,
                occurredAt: instant,
                metadata: DeviceEventMetadata(shiftId: current.activeShift?.id, engineState: current.state)
            )]
        }
        if wasActive && !isNowActive && !isIndeterminate(current.state) {
            return [DeviceEvent(
                type: .workModeEnded,
                occurredAt: instant,
                metadata: DeviceEventMetadata(engineState: current.state)
            )]
        }
        return []
    }
}
