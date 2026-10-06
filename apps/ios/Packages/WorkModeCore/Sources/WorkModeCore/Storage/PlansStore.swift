import Foundation

/// One scheduled DeviceActivity and what the monitor extension must do when it fires.
public struct PlanEntry: Codable, Equatable, Sendable {
    public var shiftId: String
    public var plan: RestrictionPlan
    public var activity: ActivityPlan
    /// Set for `.break` activities: how restrictions change for the break.
    public var breakBehaviour: BreakBehaviour?

    public init(shiftId: String, plan: RestrictionPlan, activity: ActivityPlan, breakBehaviour: BreakBehaviour? = nil) {
        self.shiftId = shiftId
        self.plan = plan
        self.activity = activity
        self.breakBehaviour = breakBehaviour
    }
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

    /// Activities in a stable order (by start instant, then name) for scheduling and comparison.
    public var activities: [ActivityPlan] {
        entries.values.map(\.activity).sorted { a, b in
            let aStart = a.startComponents.resolvedDate() ?? .distantPast
            let bStart = b.startComponents.resolvedDate() ?? .distantPast
            return aStart == bStart ? a.name < b.name : aStart < bStart
        }
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
            return try JSONDecoder.workMode.decode(PlansFile.self, from: data)
        } catch {
            WorkModeLog.storage.error("plans.json unreadable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    public func write(_ file: PlansFile) throws {
        try fileStore.write(try JSONEncoder.workMode.encode(file), to: fileName)
    }

    /// The entry for a DeviceActivity name (what the monitor extension looks up in `intervalDidStart`).
    public func entry(forActivityNamed name: String) -> PlanEntry? {
        read()?.entries[name]
    }

    public func clear() throws {
        try fileStore.delete(fileName)
    }
}
