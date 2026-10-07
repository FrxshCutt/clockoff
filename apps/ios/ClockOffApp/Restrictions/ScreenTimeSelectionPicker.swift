import FamilyControls
import SwiftUI
import UIKit
import WorkModeCore
import WorkModeScreenTime

/// The employee's app picker. Apple's `FamilyActivityPicker` returns opaque tokens: the app cannot pre-select
/// the categories the policy names, cannot read which apps were chosen, and never sends the selection anywhere.
/// It is saved to the App Group (`SelectionStore`) so the DeviceActivityMonitor extension can shield with it;
/// only the counts are reported (§12).
///
/// `kind == .work` is the full set shielded during shifts; `kind == .breakKept` is the subset that stays
/// shielded during a RELAX_CATEGORIES break (a second pass through the picker, because tokens cannot be
/// filtered by category on the device).
struct SelectionPickerSheet: View {
    let kind: SelectionKind
    let policyCategories: [RestrictionCategory]
    let onSave: (FamilyActivitySelection) -> Void
    let onCancel: () -> Void

    @State private var selection: FamilyActivitySelection

    init(kind: SelectionKind, policyCategories: [RestrictionCategory], initial: FamilyActivitySelection, onSave: @escaping (FamilyActivitySelection) -> Void, onCancel: @escaping () -> Void) {
        self.kind = kind
        self.policyCategories = policyCategories
        self.onSave = onSave
        self.onCancel = onCancel
        _selection = State(initialValue: initial)
    }

    private var isEmpty: Bool {
        selection.applicationTokens.isEmpty && selection.categoryTokens.isEmpty && selection.webDomainTokens.isEmpty
    }

    private var title: String {
        switch kind {
        case .work: return "Apps to block on shift"
        case .breakKept: return "Keep blocked on breaks"
        }
    }

    private var guidance: String {
        switch kind {
        case .work:
            let names = policyCategories.map(\.label)
            return names.isEmpty
                ? "Choose the apps and categories to pause while you're on shift. Your choices stay on this iPhone."
                : "Your workplace blocks \(names.joined(separator: ", ")). Pick those categories (and any apps you'd add). Your choices stay on this iPhone."
        case .breakKept:
            return "Pick the apps and categories that should stay paused during breaks. Everything else you chose for shifts is allowed while you're on a break."
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text(guidance)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                FamilyActivityPicker(selection: $selection)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(selection) }
                        .disabled(isEmpty)
                        .accessibilityHint(isEmpty ? "Choose at least one app or category" : "")
                }
            }
        }
        .interactiveDismissDisabled()
    }
}

extension Notification.Name {
    /// Posted on the main thread after a selection is saved (`userInfo[SelectionChangeNotification.kindKey]`
    /// = `SelectionKind.rawValue`). `WorkModeController` reconciles so a shift already in progress is shielded.
    static let workModeSelectionDidChange = Notification.Name("online.clockoff.selectionDidChange")
}

enum SelectionChangeNotification {
    static let kindKey = "kind"
}

/// `SelectionConfiguring` over Apple's picker. `configureSelection()` presents `SelectionPickerSheet` on the
/// top-most view controller and returns the counts stored so far; the sheet saves into the App Group and posts
/// `.workModeSelectionDidChange`, after which `hasSelection()` is true.
final class ScreenTimeSelectionConfigurator: SelectionConfiguring {
    let actionTitle = "Choose apps"

    private let selections: SelectionStore
    private let flags: SharedFlags?
    private let policyCategories: () -> [RestrictionCategory]

    /// - Parameter policyCategories: the resolved policy's categories, shown as guidance in the picker.
    init(selections: SelectionStore, flags: SharedFlags?, policyCategories: @escaping () -> [RestrictionCategory] = { [] }) {
        self.selections = selections
        self.flags = flags
        self.policyCategories = policyCategories
    }

    func configureSelection() throws -> SelectionCounts {
        try configureSelection(kind: .work)
    }

    func configureSelection(kind: SelectionKind) throws -> SelectionCounts {
        DispatchQueue.main.async { [self] in self.present(kind: kind) }
        return selections.summary(kind).counts
    }

    @MainActor
    private func present(kind: SelectionKind) {
        guard let presenter = Self.topViewController() else {
            WorkModeLog.restrictions.error("cannot present the Screen Time picker: no window")
            return
        }
        var host: UIHostingController<SelectionPickerSheet>?
        let sheet = SelectionPickerSheet(
            kind: kind,
            policyCategories: policyCategories(),
            initial: SelectionCodec.load(kind, from: selections),
            onSave: { [weak self] selection in
                self?.save(selection, kind: kind)
                host?.dismiss(animated: true)
            },
            onCancel: { host?.dismiss(animated: true) }
        )
        let controller = UIHostingController(rootView: sheet)
        controller.modalPresentationStyle = .formSheet
        host = controller
        presenter.present(controller, animated: true)
    }

    private func save(_ selection: FamilyActivitySelection, kind: SelectionKind) {
        do {
            let summary = try SelectionCodec.save(selection, kind: kind, to: selections)
            if kind == .breakKept { flags?.selectionIncomplete = false }
            WorkModeLog.restrictions.info("selection saved (\(kind.rawValue, privacy: .public)): \(summary.categoryCount) categories, \(summary.applicationCount) apps, \(summary.webDomainCount) websites")
            NotificationCenter.default.post(name: .workModeSelectionDidChange, object: nil, userInfo: [SelectionChangeNotification.kindKey: kind.rawValue])
        } catch {
            WorkModeLog.restrictions.error("saving the selection failed: \(String(describing: error), privacy: .public)")
        }
    }

    @MainActor
    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
