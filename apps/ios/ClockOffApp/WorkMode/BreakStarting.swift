import Foundation
import WorkModeCore

/// The networking seam `WorkModeController` uses for breaks. The app-flows engineer may supply their own
/// implementation (retries, telemetry); `MobileAPIBreakClient` is the plain adapter over `MobileAPI`.
///
/// Errors: throw `APIError`. A transient error (`isTransient`, or `credentialsUnavailable`) makes the controller
/// start the break offline from the cached policy and queue it for replay; any other error (a server refusal such
/// as `BREAK_TOO_SOON`) is shown to the employee and nothing is started.
protocol BreakStarting: AnyObject {
    /// `POST /breaks/start`. Idempotent on `clientBreakId`; `requestedAt` is the device time of the tap.
    func startBreak(clientBreakId: String, shiftId: String, requestedAt: Date, requestedDurationMinutes: Int?) async throws -> BreakSession
    /// `POST /breaks/:id/end` for a break the server knows (`id` is the server's session id).
    func endBreak(id: String, endedAt: Date, reason: MobileBreakEndReason) async throws
}

/// `BreakStarting` over the mobile API client.
final class MobileAPIBreakClient: BreakStarting {
    private let api: MobileAPI

    init(api: MobileAPI) {
        self.api = api
    }

    func startBreak(clientBreakId: String, shiftId: String, requestedAt: Date, requestedDurationMinutes: Int?) async throws -> BreakSession {
        let response = try await api.startBreak(StartBreakRequest(
            clientBreakId: clientBreakId,
            shiftId: shiftId,
            requestedAt: requestedAt,
            requestedDurationMinutes: requestedDurationMinutes
        ))
        return response.breakSession
    }

    func endBreak(id: String, endedAt: Date, reason: MobileBreakEndReason) async throws {
        _ = try await api.endBreak(breakSessionId: id, EndBreakRequest(endedAt: endedAt, reason: reason))
    }
}
