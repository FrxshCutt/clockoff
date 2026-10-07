import FamilyControls
import Foundation
import ClockOffCore

extension RestrictionAuthorizationStatus {
    /// Maps FamilyControls' `AuthorizationStatus` onto ClockOff's three states. `approvedWithDataAccess`
    /// counts as approved; a value this build does not know is treated as not determined (never as approved).
    public init(_ status: AuthorizationStatus) {
        switch status {
        case .notDetermined:
            self = .notDetermined
        case .approved:
            self = .approved
        case .denied:
            self = .denied
        @unknown default:
            self = .notDetermined
        }
    }
}
