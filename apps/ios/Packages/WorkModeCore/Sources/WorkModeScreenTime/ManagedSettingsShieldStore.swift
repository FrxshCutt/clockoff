import FamilyControls
import Foundation
import ManagedSettings
import WorkModeCore

// WorkModeScreenTime — the thin layer that touches Apple's ManagedSettings / FamilyControls types. Shared by the
// app (`AppleScreenTimeRestrictionProvider`) and the DeviceActivityMonitor extension so both apply shields the
// same way. Everything decision-shaped stays in WorkModeCore (`ShieldApplier`, `MonitorEventHandler`).

extension ManagedSettingsStore.Name {
    /// Full shield set during a shift.
    public static let work = Self("com.workmode.shields.work")
    /// The "kept" subset during a RELAX_CATEGORIES break.
    public static let breakRelaxed = Self("com.workmode.shields.breakRelaxed")

    public static func forRole(_ role: ShieldStoreRole) -> ManagedSettingsStore.Name {
        switch role {
        case .work: return .work
        case .breakRelaxed: return .breakRelaxed
        }
    }
}

/// `ShieldStoring` over a named `ManagedSettingsStore`. The payload is a JSON-encoded `FamilyActivitySelection`
/// (`SelectionCodec`); its opaque tokens are handed straight to the shield settings and never inspected.
public final class ManagedSettingsShieldStore: ShieldStoring {
    public let name: ManagedSettingsStore.Name
    private let store: ManagedSettingsStore

    public init(name: ManagedSettingsStore.Name) {
        self.name = name
        store = ManagedSettingsStore(named: name)
    }

    public func applyShields(selectionPayload: Data) throws {
        let selection = try SelectionCodec.decode(selectionPayload)
        apply(selection)
    }

    public func apply(_ selection: FamilyActivitySelection) {
        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
        store.shield.webDomains = selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens
        if selection.categoryTokens.isEmpty {
            store.shield.applicationCategories = nil
            store.shield.webDomainCategories = nil
        } else {
            store.shield.applicationCategories = .specific(selection.categoryTokens, except: Set())
            store.shield.webDomainCategories = .specific(selection.categoryTokens, except: Set())
        }
    }

    /// `clearAllSettings()`: every shield (and any other setting) in this named store is removed.
    public func clearShields() {
        store.clearAllSettings()
    }

    /// Read back from the store itself, so a claim of "shields up" is never based on memory.
    public var isShielding: Bool {
        if let applications = store.shield.applications, !applications.isEmpty { return true }
        if let domains = store.shield.webDomains, !domains.isEmpty { return true }
        if store.shield.applicationCategories != nil { return true }
        if store.shield.webDomainCategories != nil { return true }
        return false
    }
}

/// The two named stores Work Mode uses.
public final class ScreenTimeShieldStores: ShieldStoreProviding {
    public let work = ManagedSettingsShieldStore(name: .work)
    public let breakRelaxed = ManagedSettingsShieldStore(name: .breakRelaxed)

    public init() {}

    public func store(for role: ShieldStoreRole) -> ShieldStoring {
        switch role {
        case .work: return work
        case .breakRelaxed: return breakRelaxed
        }
    }
}

extension ShieldApplier {
    /// The applier over the real ManagedSettings stores and the App Group selection files.
    public static func screenTime(fileStore: AppGroupFileStore, flags: SharedFlags? = nil) -> ShieldApplier {
        ShieldApplier(stores: ScreenTimeShieldStores(), selections: SelectionStore(fileStore: fileStore), flags: flags)
    }
}
