// DEBUG ONLY — see DiagnosticsSnapshot.swift. `DiagnosticsReport.title` is the marker string
// Scripts/verify-release.sh looks for in Release binaries.
#if DEBUG
import Foundation
import ClockOffCore

struct DiagnosticsRow: Equatable {
    var label: String
    var value: String
    /// Something the tester should look at (permission missing, activity not registered, …).
    var attention: Bool = false
}

struct DiagnosticsSection: Equatable, Identifiable {
    var title: String
    var rows: [DiagnosticsRow]
    var id: String { title }
}

/// Pure formatting of a `DiagnosticsSnapshot`: the sections the screen renders and the plain-text report
/// "Copy diagnostics to clipboard" copies. Both use the same labels. Prints counts, states, activity names
/// (shift / break ids) and times only — never app names, category names, tokens, or who the employee is.
enum DiagnosticsReport {
    /// Header of the copied report; also the Release-build marker (must stay longer than 15 UTF-8 bytes so
    /// Swift stores it as a C string the verifier can find).
    static let title = "ClockOff Diagnostics"
    static let privacyNote = "Counts and states only: no app or category names."

    enum SectionTitle {
        static let snapshot = "Snapshot"
        static let screenTime = "Screen Time access"
        static let selection = "App selection"
        static let engine = "Work Mode engine"
        static let activities = "DeviceActivity schedules"
        static let plans = "plans.json"
        static let shields = "Shield stores"
        static let appGroup = "App Group"
        static let sync = "Sync"
    }

    static func sections(_ snapshot: DiagnosticsSnapshot) -> [DiagnosticsSection] {
        let time = DiagnosticsTimeFormat(timeZone: snapshot.timeZone, now: snapshot.capturedAt)
        return [
            DiagnosticsSection(title: SectionTitle.snapshot, rows: [
                DiagnosticsRow(label: "Updated", value: time.absolute(snapshot.capturedAt)),
                DiagnosticsRow(label: "App version", value: snapshot.appVersion),
                DiagnosticsRow(label: "Time zone", value: snapshot.timeZone.identifier),
            ]),
            screenTimeSection(snapshot.authorization),
            selectionSection(snapshot.selection),
            engineSection(snapshot.engine, shieldStores: snapshot.shieldStores, time: time),
            activitiesSection(snapshot.schedules, time: time),
            plansSection(snapshot.schedules, appGroup: snapshot.appGroup, time: time),
            shieldSection(snapshot.shieldStores, provider: snapshot.authorization.provider),
            appGroupSection(snapshot.appGroup, time: time),
            syncSection(snapshot.sync, time: time),
        ]
    }

    /// The plain-text report (one `Label: value` line per row, `[!]` after rows that need attention).
    static func text(_ snapshot: DiagnosticsSnapshot) -> String {
        var lines = [title, privacyNote]
        for section in sections(snapshot) {
            lines.append("")
            lines.append("== \(section.title) ==")
            for row in section.rows {
                lines.append("\(row.label): \(row.value)\(row.attention ? " [!]" : "")")
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    // MARK: Sections

    private static func screenTimeSection(_ authorization: DiagnosticsSnapshot.Authorization) -> DiagnosticsSection {
        DiagnosticsSection(title: SectionTitle.screenTime, rows: [
            DiagnosticsRow(label: "Family Controls", value: authorizationText(authorization.familyControls),
                           attention: authorization.familyControls != .approved),
            DiagnosticsRow(label: "Reported to workplace", value: authorization.reportedPermission.rawValue,
                           attention: !authorization.reportedPermission.isApproved),
            DiagnosticsRow(label: "Restriction provider", value: providerText(authorization.provider)),
        ])
    }

    private static func selectionSection(_ selection: DiagnosticsSnapshot.Selection) -> DiagnosticsSection {
        let work = selection.work ?? .zero
        let kept: DiagnosticsRow
        if let counts = selection.breakKept {
            kept = DiagnosticsRow(label: "Kept blocked on breaks", value: countsText(counts))
        } else if selection.breakKeptRequired {
            kept = DiagnosticsRow(label: "Kept blocked on breaks", value: "Not chosen (the break policy needs it)", attention: true)
        } else {
            kept = DiagnosticsRow(label: "Kept blocked on breaks", value: "Not needed by the break policy")
        }
        return DiagnosticsSection(title: SectionTitle.selection, rows: [
            DiagnosticsRow(label: "Selection saved", value: selection.work == nil ? "No" : "Yes", attention: selection.work == nil),
            DiagnosticsRow(label: "Apps", value: "\(work.applications)"),
            DiagnosticsRow(label: "Categories", value: "\(work.categories)"),
            DiagnosticsRow(label: "Web domains", value: "\(work.webDomains)"),
            kept,
        ])
    }

    private static func engineSection(_ engine: DiagnosticsSnapshot.Engine, shieldStores: [DiagnosticsSnapshot.ShieldStore]?,
                                      time: DiagnosticsTimeFormat) -> DiagnosticsSection {
        let expected = engine.expected
        var rows = [
            DiagnosticsRow(label: "Shown in the app", value: screenStateText(engine.screenState), attention: isAttention(engine.screenState)),
            DiagnosticsRow(label: "Engine state", value: expected?.state.rawValue ?? "Not evaluated yet"),
            DiagnosticsRow(label: "Reason", value: reason(engine, time: time)),
        ]
        if let expected {
            rows.append(DiagnosticsRow(label: "Effective restriction", value: expected.effectiveRestriction.rawValue))
            rows.append(DiagnosticsRow(label: "Restrictions should be active", value: yesNo(expected.restrictionsShouldBeActive)))
            rows.append(DiagnosticsRow(label: "Next change", value: expected.nextTransitionAt.map(time.stamp) ?? "None scheduled"))
        }
        let provider = engine.providerState
        let shieldsUp = shieldStores.map { $0.contains(where: \.isShielding) } ?? WorkModeEngine.isActiveState(provider.state)
        let disagrees = expected.map { expected in
            expected.restrictionsShouldBeActive
                // Work Mode failed: the engine expects shields and the stores do not hold them.
                ? WorkModeEngine.isActiveState(expected.state) && !WorkModeEngine.isActiveState(provider.state)
                // Shields left behind: none are expected (off shift, RELAX_ALL break, lifting override) but some are up.
                : shieldsUp
        } ?? false
        rows.append(DiagnosticsRow(label: "Shield stores read back as", value: "\(provider.state.rawValue) (source: \(sourceText(provider.source)))",
                                   attention: disagrees))
        rows.append(DiagnosticsRow(label: "Last reconcile", value: engine.lastReconcileAt.map(time.stamp) ?? "Never"))
        rows.append(DiagnosticsRow(label: "Last reconcile result", value: engine.lastReconcile.map(reconcileText) ?? "None yet"))
        return DiagnosticsSection(title: SectionTitle.engine, rows: rows)
    }

    private static func activitiesSection(_ schedules: DiagnosticsSnapshot.Schedules, time: DiagnosticsTimeFormat) -> DiagnosticsSection {
        var rows: [DiagnosticsRow] = []
        if let registered = schedules.registered {
            rows.append(DiagnosticsRow(label: "Registered with iOS", value: registered.isEmpty ? "None" : countText(registered.count, "activity", "activities")))
            let planned = Set((schedules.planned ?? []).map(\.name))
            for activity in registered {
                var value = time.window(activity.start, activity.end)
                if activity.repeats { value += " · repeats" }
                if let warning = activity.warningMinutes, warning > 0 { value += " · warning \(warning) min" }
                let missing = !planned.contains(activity.name)
                if missing { value += " · not in plans.json" }
                rows.append(DiagnosticsRow(label: activity.name, value: value, attention: missing))
            }
        } else {
            rows.append(DiagnosticsRow(label: "Registered with iOS", value: "Unavailable (provider cannot be inspected)", attention: true))
        }
        rows.append(DiagnosticsRow(label: "Re-registration pending", value: yesNo(schedules.needsReschedule), attention: schedules.needsReschedule))
        return DiagnosticsSection(title: SectionTitle.activities, rows: rows)
    }

    private static func plansSection(_ schedules: DiagnosticsSnapshot.Schedules, appGroup: DiagnosticsSnapshot.AppGroupContents,
                                     time: DiagnosticsTimeFormat) -> DiagnosticsSection {
        var rows = [
            DiagnosticsRow(label: "File modified", value: appGroup.plansFileModifiedAt.map(time.stamp) ?? "No file"),
            DiagnosticsRow(label: "Generated at", value: appGroup.plansGeneratedAt.map(time.stamp) ?? "—"),
        ]
        guard let planned = schedules.planned else {
            rows.append(DiagnosticsRow(label: "Entries", value: "None"))
            return DiagnosticsSection(title: SectionTitle.plans, rows: rows)
        }
        rows.append(DiagnosticsRow(label: "Entries", value: "\(planned.count)"))
        let registered = schedules.registered.map { Set($0.map(\.name)) }
        for entry in planned {
            var value = "\(entry.kind.rawValue) · \(time.window(entry.start, entry.end))"
            var attention = false
            if let registered, !registered.contains(entry.name) {
                let ended = entry.end.map { $0 <= time.now } ?? false
                value += ended ? " · not registered (already over)" : " · not registered with iOS"
                attention = !ended
            }
            rows.append(DiagnosticsRow(label: entry.name, value: value, attention: attention))
        }
        return DiagnosticsSection(title: SectionTitle.plans, rows: rows)
    }

    private static func shieldSection(_ stores: [DiagnosticsSnapshot.ShieldStore]?, provider: DiagnosticsSnapshot.ProviderKind) -> DiagnosticsSection {
        guard let stores else {
            return DiagnosticsSection(title: SectionTitle.shields, rows: [
                DiagnosticsRow(label: "Source", value: "Unavailable (provider cannot be inspected)", attention: true),
            ])
        }
        var rows = [DiagnosticsRow(label: "Source", value: provider == .simulated ? "Simulated (development)" : "ManagedSettings (live)")]
        for store in stores {
            let name = storeName(store.role)
            rows.append(DiagnosticsRow(label: name, value: store.isShielding ? "Shielding" : "Empty"))
            rows.append(DiagnosticsRow(label: "\(storeShortName(store.role)) sets", value: [
                "applications \(tokenCount(store.applications))",
                "applicationCategories \(policyText(store.applicationCategories))",
                "webDomains \(tokenCount(store.webDomains))",
                "webDomainCategories \(policyText(store.webDomainCategories))",
            ].joined(separator: " · ")))
        }
        return DiagnosticsSection(title: SectionTitle.shields, rows: rows)
    }

    private static func appGroupSection(_ group: DiagnosticsSnapshot.AppGroupContents, time: DiagnosticsTimeFormat) -> DiagnosticsSection {
        let engineState = group.recordedEngineState.map {
            "\($0.state.rawValue) · written by \(sourceText($0.source))\($0.updatedAt.map { " · \(time.stamp($0))" } ?? "")"
        }
        let callback = group.lastMonitorCallback.map {
            "\($0.kind) · \($0.activityName) · \(time.stamp($0.at)) · \($0.outcome)"
        }
        return DiagnosticsSection(title: SectionTitle.appGroup, rows: [
            DiagnosticsRow(label: "Container", value: group.isSharedContainer ? "Shared App Group" : "Private fallback (the extensions can't read it)",
                           attention: !group.isSharedContainer),
            DiagnosticsRow(label: "state.json modified", value: group.stateFileModifiedAt.map(time.stamp) ?? "No file"),
            DiagnosticsRow(label: "Engine state in state.json", value: engineState ?? "None"),
            DiagnosticsRow(label: "Last extension callback", value: callback ?? "None yet"),
            DiagnosticsRow(label: "Outbox", value: group.outboxCount == 0 ? "Empty" : "\(countText(group.outboxCount, "event", "events")) waiting"),
            DiagnosticsRow(label: "Offline breaks queued", value: "\(group.queuedBreakCount)"),
            DiagnosticsRow(label: "Selection incomplete flag", value: yesNo(group.selectionIncomplete), attention: group.selectionIncomplete),
        ])
    }

    private static func syncSection(_ sync: DiagnosticsSnapshot.Sync, time: DiagnosticsTimeFormat) -> DiagnosticsSection {
        DiagnosticsSection(title: SectionTitle.sync, rows: [
            DiagnosticsRow(label: "Last sync", value: sync.lastSyncAt.map(time.stamp) ?? "Never", attention: sync.lastSyncAt == nil),
            DiagnosticsRow(label: "Server last reached", value: sync.lastServerContactAt.map(time.stamp) ?? "Never"),
            DiagnosticsRow(label: "Last sync error", value: sync.lastSyncErrorCode ?? "None", attention: sync.lastSyncErrorCode != nil),
            DiagnosticsRow(label: "Policy version", value: sync.policyVersion ?? "None"),
            DiagnosticsRow(label: "Schedule version", value: sync.scheduleVersion.map(String.init) ?? "None"),
            DiagnosticsRow(label: "Clock skew", value: clockSkewText(sync.clockSkewSeconds),
                           attention: sync.clockSkewSeconds.map { abs($0) > BreakRules.clockSkewAttentionThresholdSeconds } ?? false),
            DiagnosticsRow(label: "Last check-in", value: sync.lastCheckInAt.map(time.stamp) ?? "Never"),
            DiagnosticsRow(label: "API host", value: sync.apiHost),
        ])
    }

    // MARK: Engine reason

    /// Why the engine computed its state, from the `ExpectedState` (shift / break / override windows).
    static func reason(_ engine: DiagnosticsSnapshot.Engine, time: DiagnosticsTimeFormat) -> String {
        guard engine.isJoined else { return "Not joined to a workplace: nothing to enforce" }
        guard let expected = engine.expected else { return "No reconcile has run yet" }
        switch expected.state {
        case .working:
            let start = expected.workingInterval?.startsAt ?? expected.activeShift?.startsAt
            let end = expected.workingInterval?.endsAt ?? expected.activeShift?.endsAt
            var text = "Shift in progress \(time.window(start, end))"
            if expected.relaxation?.source == .override { text += "; a manager exception relaxes part of the policy" }
            return text
        case .shiftEnding:
            let end = expected.workingInterval?.endsAt ?? expected.activeShift?.endsAt
            return "Shift in its end warning; ends \(end.map(time.stamp) ?? "at an unknown time")"
        case .onBreak:
            guard let activeBreak = expected.activeBreak else { return "On a break (no break details)" }
            let behaviour = expected.relaxation?.restrictionBehaviour.rawValue ?? "unknown behaviour"
            return "Break running \(time.window(activeBreak.startedAt, activeBreak.endsAt)), \(behaviour)"
        case .shiftStartingSoon:
            let start = expected.workingInterval?.startsAt ?? expected.upcomingShift?.startsAt
            return "Pre-shift warning; shift starts \(start.map(time.stamp) ?? "soon")"
        case .managerOverride:
            guard let override = expected.activeOverride else { return "Manager override (no details)" }
            return "Manager override \(override.type.rawValue) until \(time.stamp(override.expiresAt))"
        case .permissionError:
            return "Screen Time permission is \(expected.permissionState.rawValue)"
        case .offShift:
            if let next = expected.upcomingShift { return "No shift now; next shift \(time.window(next.startsAt, next.endsAt))" }
            return "No shift now and none upcoming in the cached schedule"
        case .syncError:
            return "No usable schedule (sync error)"
        case .unknown:
            return "The engine could not decide (UNKNOWN)"
        }
    }

    // MARK: Text helpers

    static func screenStateText(_ state: UIWorkState) -> String {
        switch state {
        case .unknown: return "Unknown (not joined or not evaluated)"
        case .offShift: return "Off shift"
        case .startingSoon: return "Starting soon"
        case .working(_, _, _, let relaxedByManager): return relaxedByManager ? "Work Mode active (manager exception)" : "Work Mode active"
        case .onBreak: return "On break"
        case .pausedByManager: return "Paused by manager"
        case .actionRequired(let reason):
            switch reason {
            case .screenTimeNotAllowed(let permission): return "Action required: Screen Time access \(permission.rawValue)"
            case .appsNotChosen: return "Action required: no apps chosen"
            case .enforcementFailed: return "Action required: enforcement failed"
            }
        case .syncDelayed: return "Sync delayed"
        }
    }

    private static func isAttention(_ state: UIWorkState) -> Bool {
        switch state {
        case .actionRequired, .syncDelayed: return true
        case .unknown, .offShift, .startingSoon, .working, .onBreak, .pausedByManager: return false
        }
    }

    static func authorizationText(_ status: RestrictionAuthorizationStatus) -> String {
        switch status {
        case .approved: return "Approved"
        case .denied: return "Denied"
        case .notDetermined: return "Not determined"
        }
    }

    private static func providerText(_ provider: DiagnosticsSnapshot.ProviderKind) -> String {
        switch provider {
        case .screenTime: return "Apple Screen Time"
        case .simulated: return "Simulated (development)"
        case .unavailable: return "Unavailable"
        }
    }

    private static func sourceText(_ source: RestrictionEngineStateSource) -> String {
        switch source {
        case .appEngine: return "app"
        case .monitorExtension: return "monitor extension"
        case .provider: return "provider"
        case .cache: return "cache"
        case .none: return "nothing yet"
        }
    }

    private static func reconcileText(_ reconcile: DiagnosticsSnapshot.Reconcile) -> String {
        var parts: [String] = []
        if reconcile.closedBreak { parts.append("closed an expired break") }
        let applied = reconcile.appliedState?.rawValue ?? "—"
        if reconcile.isChange, let action = reconcile.action {
            parts.append("\(action.rawValue) → \(applied)")
        } else {
            parts.append("no change (\(applied))")
        }
        if let reason = reconcile.decisionReason { parts.append(reason) }
        return parts.joined(separator: " · ")
    }

    private static func storeName(_ role: ShieldStoreRole) -> String {
        switch role {
        case .work: return "Work store (.work)"
        case .breakRelaxed: return "Break store (.breakRelaxed)"
        }
    }

    private static func storeShortName(_ role: ShieldStoreRole) -> String {
        switch role {
        case .work: return "Work store"
        case .breakRelaxed: return "Break store"
        }
    }

    private static func tokenCount(_ count: Int?) -> String {
        count.map { "\($0)" } ?? "nil"
    }

    private static func policyText(_ policy: DiagnosticsSnapshot.CategoryPolicy?) -> String {
        guard let policy else { return "nil" }
        switch policy {
        case .none: return "none"
        case .specific(let categories, let exceptions): return "specific(\(categories))\(exceptions > 0 ? " except \(exceptions)" : "")"
        case .all(let exceptions): return "all\(exceptions > 0 ? " except \(exceptions)" : "")"
        }
    }

    static func countsText(_ counts: SelectionCounts) -> String {
        [countText(counts.applications, "app", "apps"), countText(counts.categories, "category", "categories"),
         countText(counts.webDomains, "web domain", "web domains")].joined(separator: ", ")
    }

    static func clockSkewText(_ seconds: Int?) -> String {
        guard let seconds else { return "Unknown (no check-in yet)" }
        if seconds == 0 { return "0 s (in step with the server)" }
        return seconds > 0 ? "+\(seconds) s (device ahead of server)" : "\(seconds) s (device behind server)"
    }

    private static func countText(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n) \(n == 1 ? one : many)"
    }

    private static func yesNo(_ value: Bool) -> String {
        value ? "Yes" : "No"
    }
}

/// Deterministic times for the report: absolute in the device's zone plus a short relative part.
struct DiagnosticsTimeFormat {
    let timeZone: TimeZone
    let now: Date

    private func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }

    /// "2026-10-07 14:05:12 +01:00".
    func absolute(_ date: Date) -> String {
        formatter("yyyy-MM-dd HH:mm:ss xxx").string(from: date)
    }

    /// "2026-10-07 14:05:12 +01:00 (3 min ago)".
    func stamp(_ date: Date) -> String {
        "\(absolute(date)) (\(relative(date)))"
    }

    /// "now", "in 12 min", "3 min ago", "2 h 5 min ago", "1 d 3 h ago".
    func relative(_ date: Date) -> String {
        let delta = date.timeIntervalSince(now)
        let seconds = Int(abs(delta).rounded())
        if seconds < 5 { return "now" }
        let text = DiagnosticsTimeFormat.duration(seconds)
        return delta > 0 ? "in \(text)" : "\(text) ago"
    }

    static func duration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) s" }
        if seconds < 3600 { return "\(seconds / 60) min" }
        if seconds < 86_400 {
            let minutes = (seconds % 3600) / 60
            return minutes == 0 ? "\(seconds / 3600) h" : "\(seconds / 3600) h \(minutes) min"
        }
        let hours = (seconds % 86_400) / 3600
        return hours == 0 ? "\(seconds / 86_400) d" : "\(seconds / 86_400) d \(hours) h"
    }

    /// "2026-10-07 14:00 → 14:30 +01:00 · starts in 12 min" (the end keeps its date when it is another day).
    func window(_ start: Date?, _ end: Date?) -> String {
        guard let start, let end else {
            let known = start ?? end
            return known.map { "\(formatter("yyyy-MM-dd HH:mm xxx").string(from: $0)) (start or end unknown)" } ?? "unknown time"
        }
        let day = formatter("yyyy-MM-dd")
        let endText = day.string(from: start) == day.string(from: end)
            ? formatter("HH:mm xxx").string(from: end)
            : formatter("yyyy-MM-dd HH:mm xxx").string(from: end)
        let range = "\(formatter("yyyy-MM-dd HH:mm").string(from: start)) → \(endText)"
        let status: String
        if now < start {
            status = "starts \(relative(start))"
        } else if now < end {
            status = "running, ends \(relative(end))"
        } else {
            status = "ended \(relative(end))"
        }
        return "\(range) · \(status)"
    }
}
#endif
