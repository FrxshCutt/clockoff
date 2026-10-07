import Foundation

/// The mobile API (§5, `/api/mobile/v1`) as the app sees it. `APIClient` is the production implementation;
/// view-model tests substitute a stub. Every method throws `APIError`.
public protocol MobileAPI: AnyObject {
    /// True when tokens are stored (the phone has joined and has not been signed out). Also true when the
    /// token store cannot be read right now: unreadable is not absent.
    func hasCredentials() -> Bool

    /// `POST /join/lookup` (public).
    func joinLookup(_ request: JoinLookupRequest) async throws -> JoinLookupResponse
    /// `POST /join/confirm` (public). Stores the returned tokens before returning.
    func joinConfirm(_ request: JoinConfirmRequest) async throws -> JoinConfirmResponse
    /// `POST /auth/refresh` (public). Stores and returns the rotated pair.
    func refresh() async throws -> TokenPair
    /// `POST /auth/logout`. Always deletes the local tokens, even when the request fails.
    func logout() async throws
    /// `POST /leave-workplace`. Deletes the local tokens on success.
    func leaveWorkplace() async throws
    /// `GET /me`.
    func me() async throws -> MeResponse
    /// `GET /schedule?from&to` (at most 62 days).
    func schedule(from: Date, to: Date) async throws -> ScheduleResponse
    /// `GET /sync`.
    func sync() async throws -> SyncBundle
    /// `POST /device/state`.
    func reportDeviceState(_ report: DeviceStateReport) async throws -> DeviceStateResponse
    /// `POST /events` (1…200 events).
    func postEvents(_ events: [DeviceEvent]) async throws -> DeviceEventsResponse
    /// `POST /breaks/start`.
    func startBreak(_ request: StartBreakRequest) async throws -> BreakResponse
    /// `POST /breaks/:id/end`.
    func endBreak(breakSessionId: String, _ request: EndBreakRequest) async throws -> BreakResponse
    /// `POST /device/push-token`.
    func registerPushToken(_ request: PushTokenRequest) async throws
}

/// Paths of the mobile API, relative to its root: Info.plist `API_BASE_URL`, e.g.
/// `https://app.clockoff.online/api/mobile/v1`. `Endpoint.url(apiRoot:)` appends them to that root.
public enum MobileAPIPath {
    /// Where the server mounts the mobile API. `API_BASE_URL` already ends with it, so the client never
    /// prepends it; it is used only to find the web app's root on the same server (help pages).
    public static let mountPath = "/api/mobile/v1"

    public static let joinLookup = "/join/lookup"
    public static let joinConfirm = "/join/confirm"
    public static let refresh = "/auth/refresh"
    public static let logout = "/auth/logout"
    public static let leaveWorkplace = "/leave-workplace"
    public static let me = "/me"
    public static let schedule = "/schedule"
    public static let sync = "/sync"
    public static let deviceState = "/device/state"
    public static let events = "/events"
    public static let startBreak = "/breaks/start"
    public static let pushToken = "/device/push-token"

    public static func endBreak(_ breakSessionId: String) -> String {
        let escaped = breakSessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? breakSessionId
        return "/breaks/\(escaped)/end"
    }
}
