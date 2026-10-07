import Foundation

/// One scheduled DeviceActivity and what the monitor extension must do when it fires.
public struct PlanEntry: Codable, Equatable, Sendable {
    public var shiftId: String
    public var plan: RestrictionPlan
    public var activity: ActivityPlan
    /// Set for `.break` activities: how restrictions change for the break.
    public var breakBehaviour: BreakBehaviour?
    /// Shift activities: the version encoded in the activity name (sum of the merged shifts' versions).
    public var version: Int?
    /// Shift activities: every shift merged into this interval (the first is `shiftId`).
    public var shiftIds: [String]?
    /// Break activities: the client break id the activity is keyed on.
    public var clientBreakId: String?

    public init(
        shiftId: String,
        plan: RestrictionPlan,
        activity: ActivityPlan,
        breakBehaviour: BreakBehaviour? = nil,
        version: Int? = nil,
        shiftIds: [String]? = nil,
        clientBreakId: String? = nil
    ) {
        self.shiftId = shiftId
        self.plan = plan
        self.activity = activity
        self.breakBehaviour = breakBehaviour
        self.version = version
        self.shiftIds = shiftIds
        self.clientBreakId = clientBreakId
    }

    /// The true end of what this activity covers (`plannedEnd`, else the registered interval end).
    public var plannedEnd: Date? { activity.plannedEnd ?? activity.intervalEnd }
}

/// Contents of `plans.json`: activity name → plan, plus the shield copy the ShieldConfiguration extension shows.
public struct PlansFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var generatedAt: Date
    public var organisationName: String?
    public var entries: [String: PlanEntry]

    public init(generatedAt: Date, organisationName: String?, entries: [String: PlanEntry]) {
        schemaVersion = PlansFile.currentSchemaVersion
        self.generatedAt = generatedAt
        self.organisationName = organisationName
        self.entries = entries
    }

    public init(generatedAt: Date, organisationName: String?, entries: [PlanEntry]) {
        self.init(generatedAt: generatedAt, organisationName: organisationName,
                  entries: Dictionary(entries.map { ($0.activity.name, $0) }, uniquingKeysWith: { first, _ in first }))
    }

    /// Activities in a stable order (by start instant, then name) for scheduling and comparison.
    public var activities: [ActivityPlan] {
        entries.values.map(\.activity).sorted { a, b in
            let aStart = a.intervalStart ?? .distantPast
            let bStart = b.intervalStart ?? .distantPast
            return aStart == bStart ? a.name < b.name : aStart < bStart
        }
    }

    /// Shift entries whose planned interval covers `instant` (earliest start first).
    public func shiftEntries(covering instant: Date) -> [PlanEntry] {
        entries.values
            .filter { entry in
                guard entry.activity.kind == .shift, let start = entry.activity.intervalStart, let end = entry.plannedEnd else { return false }
                return start <= instant && instant < end
            }
            .sorted { ($0.activity.intervalStart ?? .distantPast) < ($1.activity.intervalStart ?? .distantPast) }
    }

    /// The break entries (there is at most one running break, but a stale one may linger until the next plan).
    public var breakEntries: [PlanEntry] {
        entries.values.filter { $0.activity.kind == .break }
    }
}

/// Writer (app) / reader (extensions) of `plans.json` in the App Group container.
public final class PlansStore {
    public static let defaultFileName = "plans.json"

    private let fileStore: AppGroupFileStore
    private let fileName: String

    public init(fileStore: AppGroupFileStore, fileName: String = PlansStore.defaultFileName) {
        self.fileStore = fileStore
        self.fileName = fileName
    }

    public func read() -> PlansFile? {
        do {
            guard let data = try fileStore.read(fileName) else { return nil }
            return try JSONDecoder.clockOff.decode(PlansFile.self, from: data)
        } catch {
            ClockOffLog.storage.error("plans.json unreadable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    public func write(_ file: PlansFile) throws {
        try fileStore.write(try JSONEncoder.clockOff.encode(file), to: fileName)
    }

    /// Coordinated read-modify-write (the file is created if missing). Returns the saved file.
    @discardableResult
    public func update(generatedAt: Date = Date(), _ mutate: (inout PlansFile) throws -> Void) throws -> PlansFile {
        var saved = PlansFile(generatedAt: generatedAt, organisationName: nil, entries: [:])
        try fileStore.update(fileName) { data in
            var file = (data.flatMap { try? JSONDecoder.clockOff.decode(PlansFile.self, from: $0) })
                ?? PlansFile(generatedAt: generatedAt, organisationName: nil, entries: [:])
            try mutate(&file)
            file.schemaVersion = PlansFile.currentSchemaVersion
            saved = file
            return try JSONEncoder.clockOff.encode(file)
        }
        return saved
    }

    /// Adds or replaces one entry (a break activity registered while the shift plan stays as it is).
    public func upsert(_ entry: PlanEntry, at date: Date = Date()) throws {
        try update(generatedAt: date) { file in
            file.entries[entry.activity.name] = entry
            file.generatedAt = date
        }
    }

    public func remove(activityNamed name: String, at date: Date = Date()) throws {
        try update(generatedAt: date) { file in
            file.entries.removeValue(forKey: name)
            file.generatedAt = date
        }
    }

    /// The entry for a DeviceActivity name (what the monitor extension looks up in `intervalDidStart`).
    public func entry(forActivityNamed name: String) -> PlanEntry? {
        read()?.entries[name]
    }

    public func clear() throws {
        try fileStore.delete(fileName)
    }
}
