import Foundation
import WorkModeCore

/// Employee-facing copy for join/lookup failures (screens 3–4).
enum JoinErrorMessages {
    static let invalidCompanyCode = "We couldn't find a workplace with that code. Check the code your manager gave you and try again."
    static let employeeNotFound = "Ask your manager to add you"
    static let ambiguousMatch = "More than one person has this name — ask your manager for your employee code"
    static let employeeAlreadyLinked = "This profile is already connected to a device — contact your manager"
    static let invalidInviteCode = "That employee code isn't right. Check it with your manager and try again."
    static let employeeInactive = "Your profile isn't active at this workplace — contact your manager."
    static let rateLimited = "Too many attempts. Wait a minute and try again."
    static let network = "Can't reach ClockOff. Check your internet connection and try again."
    static let serverUnavailable = "ClockOff isn't responding right now. Please try again in a few minutes."
    static let generic = "Something went wrong. Please try again."

    static func message(for error: Error) -> String {
        guard let error = error as? APIError else { return generic }
        switch error.code {
        case .invalidCompanyCode:
            return invalidCompanyCode
        case .employeeNotFound:
            return employeeNotFound
        case .ambiguousMatch:
            return ambiguousMatch
        case .employeeAlreadyLinked:
            return employeeAlreadyLinked
        case .invalidInviteCode:
            return invalidInviteCode
        case .employeeInactive:
            return employeeInactive
        case .rateLimited:
            return rateLimited
        case .networkError:
            return network
        case .validationError:
            return "Check your details and try again."
        default:
            // NETWORK_ERROR is handled above, so a transient error here is a 5xx: the phone is online.
            return error.isTransient ? serverUnavailable : generic
        }
    }
}
