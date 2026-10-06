import Foundation

/// The two `ManagedSettingsStore`s Work Mode writes to.
public enum ShieldStoreRole: String, CaseIterable, Codable, Sendable {
    /// `ManagedSettingsStore(named: .work)`: the full shield set during a shift.
    case work
    /// `ManagedSettingsStore(named: .breakRelaxed)`: the "kept" subset during a RELAX_CATEGORIES break.
    case breakRelaxed
}

/// A shield store abstracted away from ManagedSettings so `ShieldApplier` can be unit-tested in the simulator.
/// The real adapter decodes the opaque payload (a `FamilyActivitySelection`) and sets `shield.applications`,
/// `shield.applicationCategories` and `shield.webDomains`; `isShielding` reads those back.
public protocol ShieldStoring: AnyObject {
    func applyShields(selectionPayload: Data) throws
    func clearShields()
    /// True when the store currently holds any shield (read back from the store, never from memory).
    var isShielding: Bool { get }
}

public protocol ShieldStoreProviding: AnyObject {
    func store(for role: ShieldStoreRole) -> ShieldStoring
}

/// In-memory `ShieldStoring` for tests (and the mock provider): records the payload it was given.
public final class InMemoryShieldStore: ShieldStoring {
    private let lock = NSLock()
    private var payload: Data?
    public private(set) var applyCount = 0
    public private(set) var clearCount = 0
    /// When set, `applyShields` throws it (simulates an undecodable payload).
    public var applyError: Error?

    public init() {}

    public func applyShields(selectionPayload: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        if let applyError { throw applyError }
        payload = selectionPayload
        applyCount += 1
    }

    public func clearShields() {
        lock.lock()
        defer { lock.unlock() }
        payload = nil
        clearCount += 1
    }

    public var isShielding: Bool {
        lock.lock()
        defer { lock.unlock() }
        return payload != nil
    }

    public var appliedPayload: Data? {
        lock.lock()
        defer { lock.unlock() }
        return payload
    }
}

public final class InMemoryShieldStores: ShieldStoreProviding {
    public let work = InMemoryShieldStore()
    public let breakRelaxed = InMemoryShieldStore()

    public init() {}

    public func store(for role: ShieldStoreRole) -> ShieldStoring {
        switch role {
        case .work: return work
        case .breakRelaxed: return breakRelaxed
        }
    }
}

/// What `ShieldApplier` did.
public enum ShieldApplication: Equatable, Sendable {
    /// Work selection on the work store; break store cleared.
    case work
    /// Every shield lifted for a RELAX_ALL break.
    case breakRelaxedAll
    /// The `breakKept` selection on the break store; work store cleared.
    case breakRelaxedCategories
    /// Shields kept up. `fallback` is true when RELAX_CATEGORIES had no `breakKept` selection to apply.
    case breakKeptRestrictions(fallback: Bool)
    case cleared
}

/// Which stores currently hold shields.
public struct ShieldSnapshot: Equatable, Sendable {
    public var workShielding: Bool
    public var breakShielding: Bool

    public init(workShielding: Bool, breakShielding: Bool) {
        self.workShielding = workShielding
        self.breakShielding = breakShielding
    }

    public var anyShielding: Bool { workShielding || breakShielding }
}

/// Maps Work Mode's intent (work / break behaviour / clear) onto the two shield stores using the persisted
/// selections. Shared by the app's provider and the DeviceActivityMonitor extension so both apply exactly the
/// same thing. Idempotent: applying the same intent twice leaves the stores unchanged.
///
/// RELAX_CATEGORIES uses two selections: the employee picks the full work set and, separately, the subset that
/// stays blocked on breaks (`breakKept`). Apple's tokens are opaque, so the app cannot derive one from the
/// other by category. Without a `breakKept` selection the break falls back to KEEP_RESTRICTIONS and the
/// `selectionIncomplete` flag is raised for the UI.
public struct ShieldApplier {
    public let stores: ShieldStoreProviding
    public let selections: SelectionStore
    public let flags: SharedFlags?

    public init(stores: ShieldStoreProviding, selections: SelectionStore, flags: SharedFlags? = nil) {
        self.stores = stores
        self.selections = selections
        self.flags = flags
    }

    /// Full shield set: work selection → work store, break store cleared. Throws `.noSelection` without one.
    @discardableResult
    public func applyWork() throws -> ShieldApplication {
        guard let payload = selections.payload(.work) else { throw RestrictionProviderError.noSelection }
        try stores.store(for: .work).applyShields(selectionPayload: payload)
        stores.store(for: .breakRelaxed).clearShields()
        return .work
    }

    @discardableResult
    public func applyBreak(_ behaviour: BreakBehaviour) throws -> ShieldApplication {
        switch behaviour {
        case .relaxAll:
            stores.store(for: .work).clearShields()
            stores.store(for: .breakRelaxed).clearShields()
            return .breakRelaxedAll
        case .relaxCategories:
            guard let kept = selections.payload(.breakKept) else {
                // No second selection: keep everything blocked rather than lift more than the policy allows.
                flags?.selectionIncomplete = true
                try applyWork()
                return .breakKeptRestrictions(fallback: true)
            }
            flags?.selectionIncomplete = false
            try stores.store(for: .breakRelaxed).applyShields(selectionPayload: kept)
            stores.store(for: .work).clearShields()
            return .breakRelaxedCategories
        case .keepRestrictions:
            // No change when the work shields are already up; otherwise make sure they are.
            if !stores.store(for: .work).isShielding {
                try applyWork()
            }
            return .breakKeptRestrictions(fallback: false)
        }
    }

    /// Clears both stores. Never fails.
    @discardableResult
    public func clearAll() -> ShieldApplication {
        stores.store(for: .work).clearShields()
        stores.store(for: .breakRelaxed).clearShields()
        return .cleared
    }

    public func snapshot() -> ShieldSnapshot {
        ShieldSnapshot(
            workShielding: stores.store(for: .work).isShielding,
            breakShielding: stores.store(for: .breakRelaxed).isShielding
        )
    }
}
