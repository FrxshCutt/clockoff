import Foundation
import ClockOffCore

/// Human copy for the counts of a Screen Time selection ("3 categories, 1 app and 1 website").
/// Only counts exist here — the app never knows (or sends) which apps were chosen.
enum SelectionCountsText {
    static func describe(_ counts: SelectionCounts) -> String {
        let parts = [
            plural(counts.categories, "category", "categories"),
            plural(counts.applications, "app", "apps"),
            plural(counts.webDomains, "website", "websites"),
        ]
        return ListFormatter.localizedString(byJoining: parts)
    }

    static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n) \(n == 1 ? one : many)"
    }
}
