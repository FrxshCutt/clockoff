import Foundation
import ClockOffCore

/// The single state card on Home, derived from `WorkModeController.state` (never from the schedule directly, so
/// the card and the shields can never disagree). Pure, so it is unit-tested per state.
struct HomeCardModel: Equatable {
    enum Kind: Equatable {
        case unknown
        case offShift
        case startingSoon
        case working
        case onBreak
        case pausedByManager
        case actionRequired
        case syncDelayed
    }

    enum Action: Equatable {
        case startBreak
        case endBreak
        case openSetup
        case repair
    }

    let kind: Kind
    let title: String
    let headline: String
    let details: [String]
    let action: Action?
    let actionTitle: String?
    /// Why the primary action is unavailable (e.g. "Next break available at 11:15").
    let note: String?
    /// Live countdown target (a shift start or break end) and its label.
    let countdownTo: Date?
    let countdownLabel: String?
    let systemImage: String

    static func make(state: UIWorkState, cache: CachedState, now: Date, timeZone: TimeZone) -> HomeCardModel {
        let time = TimeFormatting(timeZone: timeZone, now: now)
        switch state {
        case .unknown:
            return HomeCardModel(kind: .unknown, title: "WORK MODE", headline: "Checking your schedule…", details: [],
                                 action: nil, actionTitle: nil, note: nil, countdownTo: nil, countdownLabel: nil, systemImage: "hourglass")

        case .offShift(let next):
            let nextText = next.map { "Next shift \(time.dayAndClockRange($0.startsAt, $0.endsAt))" } ?? "No upcoming shifts"
            return HomeCardModel(kind: .offShift, title: "OFF SHIFT", headline: "\(nextText) · Work Mode inactive",
                                 details: ["Your apps work as normal."], action: nil, actionTitle: nil, note: nil,
                                 countdownTo: nil, countdownLabel: nil, systemImage: "moon.zzz.fill")

        case .startingSoon(let shift):
            return HomeCardModel(kind: .startingSoon, title: "STARTING SOON",
                                 headline: "Shift \(time.range(shift.startsAt, shift.endsAt))",
                                 details: ["Work Mode turns on automatically."], action: nil, actionTitle: nil, note: nil,
                                 countdownTo: shift.startsAt, countdownLabel: "Work Mode starts in", systemImage: "clock.badge.exclamationmark.fill")

        case .working(let shift, let endsAt, let allowance, let relaxedByManager):
            var details = ["Shift \(time.range(shift.startsAt, endsAt))", restrictedLine(cache: cache)]
            if relaxedByManager { details.append("Your manager has temporarily allowed some apps.") }
            let rules = cache.breakPolicy?.rules
            if let allowance, let rules, rules.breaksEnabled {
                details.append("Breaks: \(allowance.breaksRemaining) of \(rules.maxBreaksPerShift) left · \(allowance.minutesRemaining) min remaining")
            }
            let canStart = rules?.breaksEnabled == true && rules?.employeeTriggeredAllowed == true && allowance?.canStartNow == true
            return HomeCardModel(kind: .working, title: "WORK MODE ACTIVE",
                                 headline: "Distracting apps are blocked until \(time.clock(endsAt)).",
                                 details: details,
                                 action: canStart ? .startBreak : nil,
                                 actionTitle: canStart ? "Start Break" : nil,
                                 note: canStart ? nil : breakUnavailableReason(rules: rules, allowance: allowance, time: time),
                                 countdownTo: nil, countdownLabel: nil, systemImage: "lock.shield.fill")

        case .onBreak(let session, let endsAt, _):
            var details = [relaxedLine(session: session, cache: cache)]
            let minutes = Int((session.plannedEndsAt.timeIntervalSince(session.startedAt) / 60).rounded(.up))
            if BreakRules.isBelowDeviceActivityInterval(durationMinutes: minutes) {
                details.append("Keep the app open to end your break exactly on time.")
            }
            return HomeCardModel(kind: .onBreak, title: "BREAK ACTIVE", headline: "Work Mode resumes at \(time.clock(endsAt)).",
                                 details: details, action: .endBreak, actionTitle: "End Break Early", note: nil,
                                 countdownTo: endsAt, countdownLabel: "Break ends in", systemImage: "cup.and.saucer.fill")

        case .pausedByManager(_, let resumesAt):
            let resume = resumesAt.map { "Resumes at \(time.clock($0))." } ?? "Your manager will resume it."
            return HomeCardModel(kind: .pausedByManager, title: "WORK MODE PAUSED",
                                 headline: "Your manager has paused Work Mode.", details: ["Apps are not blocked right now. \(resume)"],
                                 action: nil, actionTitle: nil, note: nil, countdownTo: nil, countdownLabel: nil, systemImage: "pause.circle.fill")

        case .actionRequired(let reason):
            let action: Action
            let actionTitle: String
            switch reason {
            case .screenTimeNotAllowed, .appsNotChosen:
                action = .openSetup
                actionTitle = "Open Setup"
            case .enforcementFailed:
                action = .repair
                actionTitle = "Try again"
            }
            return HomeCardModel(kind: .actionRequired, title: "ACTION REQUIRED", headline: reason.message, details: [],
                                 action: action, actionTitle: actionTitle, note: nil, countdownTo: nil, countdownLabel: nil,
                                 systemImage: "exclamationmark.triangle.fill")

        case .syncDelayed(let lastSyncAt):
            let last = lastSyncAt.map { "Last synced \(time.relative($0))." } ?? "This phone hasn't synced yet."
            return HomeCardModel(kind: .syncDelayed, title: "SYNC DELAYED", headline: last,
                                 details: ["Connect to the internet and pull down to refresh. Your saved schedule still applies."],
                                 action: nil, actionTitle: nil, note: nil, countdownTo: nil, countdownLabel: nil, systemImage: "arrow.triangle.2.circlepath")
        }
    }

    /// "mm:ss" (or "h:mm:ss") until `target`; "00:00" once it has passed.
    static func countdown(to target: Date, from now: Date) -> String {
        let total = max(0, Int(target.timeIntervalSince(now).rounded(.up)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, seconds) }
        return String(format: "%02d:%02d", minutes, seconds)
    }

    /// Why "Start Break" is not offered right now.
    static func breakUnavailableReason(rules: BreakPolicyRules?, allowance: BreakAllowance?, time: TimeFormatting) -> String? {
        guard let rules, rules.breaksEnabled, rules.maxBreakDurationMinutes > 0 else {
            return "Breaks aren't available in ClockOff at your workplace."
        }
        guard rules.employeeTriggeredAllowed else { return "Only scheduled or manager breaks are allowed at your workplace." }
        guard let allowance else { return "Break allowance not available yet — pull down to sync." }
        if allowance.breaksRemaining <= 0 { return "No breaks left this shift." }
        if allowance.minutesRemaining < 1 { return "No break minutes left this shift." }
        if let next = allowance.nextEligibleAt, next > time.now { return "Next break available at \(time.clock(next))." }
        return "A break can't start right now."
    }

    private static func restrictedLine(cache: CachedState) -> String {
        let labels = cache.policy.map { RestrictionCategory.canonical($0.restrictionConfig.categories).map(\.label) } ?? []
        return labels.isEmpty ? "Restricted: the apps you chose" : "Restricted: \(labels.joined(separator: ", "))"
    }

    private static func relaxedLine(session: BreakSession, cache: CachedState) -> String {
        switch session.restrictionBehaviour {
        case .relaxAll:
            return "Relaxed: all apps are allowed during this break."
        case .keepRestrictions:
            return "Apps stay blocked during this break."
        case .relaxCategories:
            let labels = RestrictionCategory.canonical(session.relaxedCategories).map(\.label)
            return labels.isEmpty ? "Apps stay blocked during this break." : "Relaxed: \(labels.joined(separator: ", "))"
        }
    }
}

/// "Work Mode should be active — tap to repair": the last reconcile expected shields but could not prove them.
struct HomeRepairPrompt: Equatable {
    static let message = "Work Mode should be active — tap to repair"

    let message: String

    static func make(outcome: WorkModeController.ReconcileOutcome?) -> HomeRepairPrompt? {
        guard let outcome, let expected = outcome.expected, expected.restrictionsShouldBeActive,
              let applied = outcome.appliedState, applied == .unknown else { return nil }
        return HomeRepairPrompt(message: message)
    }
}

/// Employee-facing copy for a refused break (cached policy or server).
enum BreakErrorMessages {
    static func message(for error: Error) -> String {
        if let refusal = error as? BreakRefusal { return refusal.message }
        if let apiError = error as? APIError {
            if apiError.isTransient { return "Couldn't reach ClockOff. Your break was recorded on this phone and will sync later." }
            return apiError.message
        }
        return "Something went wrong. Please try again."
    }
}

extension TimeFormatting {
    /// "Tue 7 Oct 09:00 – 15:00" / "tomorrow 09:00 – 15:00".
    func dayAndClockRange(_ start: Date, _ end: Date) -> String {
        let dayText = day(start)
        let prefix = dayText == "Today" || dayText == "Tomorrow" ? dayText.lowercased() : dayText
        return "\(prefix) \(range(start, end))"
    }
}
