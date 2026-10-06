import Foundation

/// Stable error code from the API (`API_ERROR_CODES` in packages/shared/src/errors.ts) or one of the
/// client-side codes below. A struct rather than an enum so a code added on the server never breaks
/// decoding; switch with a `default` branch.
public struct APIErrorCode: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        self.rawValue = value
    }

    public var description: String { rawValue }

    // Generic
    public static let validationError: APIErrorCode = "VALIDATION_ERROR"
    public static let unauthenticated: APIErrorCode = "UNAUTHENTICATED"
    public static let forbidden: APIErrorCode = "FORBIDDEN"
    public static let notFound: APIErrorCode = "NOT_FOUND"
    public static let conflict: APIErrorCode = "CONFLICT"
    public static let rateLimited: APIErrorCode = "RATE_LIMITED"
    public static let payloadTooLarge: APIErrorCode = "PAYLOAD_TOO_LARGE"
    public static let internalError: APIErrorCode = "INTERNAL_ERROR"
    // Tokens
    public static let invalidToken: APIErrorCode = "INVALID_TOKEN"
    public static let tokenExpired: APIErrorCode = "TOKEN_EXPIRED"
    public static let tokenReused: APIErrorCode = "TOKEN_REUSED"
    // Employees / join
    public static let employeeNotFound: APIErrorCode = "EMPLOYEE_NOT_FOUND"
    public static let employeeInactive: APIErrorCode = "EMPLOYEE_INACTIVE"
    public static let employeeAlreadyLinked: APIErrorCode = "EMPLOYEE_ALREADY_LINKED"
    public static let employeeNotLinked: APIErrorCode = "EMPLOYEE_NOT_LINKED"
    public static let invalidCompanyCode: APIErrorCode = "INVALID_COMPANY_CODE"
    public static let ambiguousMatch: APIErrorCode = "AMBIGUOUS_MATCH"
    public static let invalidInviteCode: APIErrorCode = "INVALID_INVITE_CODE"
    public static let deviceInactive: APIErrorCode = "DEVICE_INACTIVE"
    // Breaks
    public static let breaksDisabled: APIErrorCode = "BREAKS_DISABLED"
    public static let breakLimitReached: APIErrorCode = "BREAK_LIMIT_REACHED"
    public static let breakTooSoon: APIErrorCode = "BREAK_TOO_SOON"
    public static let breakTooLong: APIErrorCode = "BREAK_TOO_LONG"
    public static let breakAlreadyActive: APIErrorCode = "BREAK_ALREADY_ACTIVE"
    public static let breakNotActive: APIErrorCode = "BREAK_NOT_ACTIVE"
    public static let notOnShift: APIErrorCode = "NOT_ON_SHIFT"
    public static let employeeBreaksNotAllowed: APIErrorCode = "EMPLOYEE_BREAKS_NOT_ALLOWED"
    // Devices / sync
    public static let clockSkew: APIErrorCode = "CLOCK_SKEW"
    public static let unknownEventType: APIErrorCode = "UNKNOWN_EVENT_TYPE"

    // Client-side codes (never sent by the server).
    /// The request never got an HTTP response (offline, DNS, TLS, timeout).
    public static let networkError: APIErrorCode = "NETWORK_ERROR"
    /// A 2xx body did not match the expected shape.
    public static let decodingError: APIErrorCode = "DECODING_ERROR"
    /// A request body could not be encoded.
    public static let encodingError: APIErrorCode = "ENCODING_ERROR"
    /// A non-HTTP or otherwise unusable response, or an error body without the `{ error }` envelope.
    public static let invalidResponse: APIErrorCode = "INVALID_RESPONSE"
    /// No tokens are stored: the device is not joined (or was signed out).
    public static let notSignedIn: APIErrorCode = "NOT_SIGNED_IN"
    /// Tokens may exist but could not be read (Keychain locked or failing). NOT an authentication failure:
    /// the session is intact, so local enforcement continues and the request can be retried later.
    public static let credentialsUnavailable: APIErrorCode = "CREDENTIALS_UNAVAILABLE"
    public static let cancelled: APIErrorCode = "CANCELLED"
}

/// `{ error: { code, message, details? } }` — the body of every non-2xx API response.
public struct APIErrorEnvelope: Codable, Equatable, Sendable {
    public struct Body: Codable, Equatable, Sendable {
        public var code: String
        public var message: String

        public init(code: String, message: String) {
            self.code = code
            self.message = message
        }
    }

    public var error: Body

    public init(error: Body) {
        self.error = error
    }
}

/// Structured error thrown by `APIClient` for every failure: server errors carry the server's code and
/// HTTP status; client-side failures use the client codes above with `status == 0`.
public struct APIError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public var code: APIErrorCode
    public var message: String
    /// HTTP status, or 0 when no HTTP response was received.
    public var status: Int
    /// Seconds from a `Retry-After` header (429/503), when present.
    public var retryAfter: TimeInterval?

    public init(code: APIErrorCode, message: String, status: Int, retryAfter: TimeInterval? = nil) {
        self.code = code
        self.message = message
        self.status = status
        self.retryAfter = retryAfter
    }

    public var errorDescription: String? { message }

    public var description: String { "APIError(\(code.rawValue), status: \(status), message: \(message))" }

    /// True when the session is gone and the user must join again (tokens were cleared).
    public var isAuthenticationFailure: Bool {
        [.unauthenticated, .tokenReused, .tokenExpired, .invalidToken, .deviceInactive, .notSignedIn].contains(code)
    }

    /// True when the request never reached a definitive answer (offline, timeout, 5xx).
    public var isTransient: Bool {
        code == .networkError || (500...599).contains(status)
    }

    /// True when the server refused the request body itself (400 / 413 / 415 / 422, e.g. VALIDATION_ERROR,
    /// UNKNOWN_EVENT_TYPE, PAYLOAD_TOO_LARGE): sending the same body again can never succeed. Authentication,
    /// conflicts and rate limiting are not included.
    public var isPermanentRejection: Bool {
        [400, 413, 415, 422].contains(status)
    }

    /// `isPermanentRejection` for any error (false for non-`APIError`s), e.g. `EventOutbox.flush(isPermanentFailure:)`.
    public static func isPermanentRejection(_ error: Error) -> Bool {
        (error as? APIError)?.isPermanentRejection ?? false
    }

    public static func credentialsUnavailable() -> APIError {
        APIError(code: .credentialsUnavailable, message: "Your sign-in can't be read right now. Unlock your iPhone and try again.", status: 0)
    }

    public static func notSignedIn() -> APIError {
        APIError(code: .notSignedIn, message: "This device is not connected to a workplace.", status: 0)
    }

    public static func network(_ error: Error) -> APIError {
        APIError(code: .networkError, message: "Can't reach Work Mode. Check your internet connection.", status: 0)
    }
}
