import Foundation

/// Device events implied by a change of the applied engine state. Shared by the app (sync/foreground, the
/// `WorkModeController`) and the DeviceActivityMonitor extension. Both record the state they applied in
/// `CachedState.engineState`, so whichever observes a transition first emits it and the other sees none.
public enum WorkModeEvents {
    /// States in which Work Mode is in force (shields up, or relaxed only by a policy-compliant break).
    public static func isActive(_ state: WorkModeState) -> Bool {
        WorkModeEngine.isActiveState(state)
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
    /// inactive state. `previous` nil means nothing was applied yet. `reason` is an UPPER_SNAKE_CASE code
    /// (e.g. `RECONCILE`, `INTERVAL_STARTED`) carried in the event metadata.
    public static func transitionEvents(from previous: WorkModeState?, to current: ExpectedState, at instant: Date, reason: String? = nil) -> [DeviceEvent] {
        let wasActive = previous.map(isActive) ?? false
        let isNowActive = isActive(current.state)
        if !wasActive && isNowActive {
            return [DeviceEvent(
                type: .workModeStarted,
                occurredAt: instant,
                metadata: DeviceEventMetadata(shiftId: current.activeShift?.id, reason: reason, engineState: current.state)
            )]
        }
        if wasActive && !isNowActive && !isIndeterminate(current.state) {
            return [DeviceEvent(
                type: .workModeEnded,
                occurredAt: instant,
                metadata: DeviceEventMetadata(reason: reason, engineState: current.state)
            )]
        }
        return []
    }

    /// Metadata naming a break for BREAK_* events. A break that exists only on this device (started offline)
    /// has no server id yet, so only its `clientBreakId` is sent; the server joins the two once it has the row.
    public static func breakMetadata(for session: BreakSession, isLocal: Bool, reason: String? = nil, engineState: WorkModeState? = nil) -> DeviceEventMetadata {
        DeviceEventMetadata(
            shiftId: session.shiftId,
            breakSessionId: isLocal ? nil : session.id,
            clientBreakId: session.clientBreakId.isEmpty ? nil : session.clientBreakId.lowercased(),
            reason: reason,
            engineState: engineState
        )
    }
}
