import Foundation
import XCTest
@testable import WorkModeApp
import WorkModeCore

/// Stubbed `MobileAPI`: each endpoint answers from a closure; every call is recorded.
final class StubMobileAPI: MobileAPI {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _deviceStateReports: [DeviceStateReport] = []
    private var _postedEvents: [DeviceEvent] = []
    private var _lookupRequests: [JoinLookupRequest] = []
    private var _confirmRequests: [JoinConfirmRequest] = []

    var credentials = true
    var lookupHandler: (JoinLookupRequest) throws -> JoinLookupResponse = { _ in throw StubMobileAPI.notStubbed("joinLookup") }
    var confirmHandler: (JoinConfirmRequest) throws -> JoinConfirmResponse = { _ in throw StubMobileAPI.notStubbed("joinConfirm") }
    var syncHandler: () throws -> SyncBundle = { throw StubMobileAPI.notStubbed("sync") }
    var meHandler: () throws -> MeResponse = { throw StubMobileAPI.notStubbed("me") }
    var deviceStateHandler: (DeviceStateReport) throws -> DeviceStateResponse = { _ in
        DeviceStateResponse(serverTime: Date(), clockSkewSeconds: 0)
    }
    var eventsHandler: ([DeviceEvent]) throws -> DeviceEventsResponse = { events in
        DeviceEventsResponse(accepted: events.count, duplicates: 0)
    }
    var leaveHandler: () throws -> Void = {}
    var syncDelayNanoseconds: UInt64 = 0

    static func notStubbed(_ name: String) -> APIError {
        APIError(code: "NOT_STUBBED", message: "\(name) not stubbed", status: 0)
    }

    var calls: [String] { locked { _calls } }
    var deviceStateReports: [DeviceStateReport] { locked { _deviceStateReports } }
    var postedEvents: [DeviceEvent] { locked { _postedEvents } }
    var lookupRequests: [JoinLookupRequest] { locked { _lookupRequests } }
    var confirmRequests: [JoinConfirmRequest] { locked { _confirmRequests } }

    func hasCredentials() -> Bool { credentials }

    func joinLookup(_ request: JoinLookupRequest) async throws -> JoinLookupResponse {
        locked { _calls.append("joinLookup"); _lookupRequests.append(request) }
        return try lookupHandler(request)
    }

    func joinConfirm(_ request: JoinConfirmRequest) async throws -> JoinConfirmResponse {
        locked { _calls.append("joinConfirm"); _confirmRequests.append(request) }
        let response = try confirmHandler(request)
        credentials = true
        return response
    }

    func refresh() async throws -> TokenPair {
        record("refresh")
        throw StubMobileAPI.notStubbed("refresh")
    }

    func logout() async throws {
        record("logout")
        credentials = false
    }

    func leaveWorkplace() async throws {
        record("leaveWorkplace")
        try leaveHandler()
        credentials = false
    }

    func me() async throws -> MeResponse {
        record("me")
        return try meHandler()
    }

    func schedule(from: Date, to: Date) async throws -> ScheduleResponse {
        record("schedule")
        throw StubMobileAPI.notStubbed("schedule")
    }

    func sync() async throws -> SyncBundle {
        record("sync")
        if syncDelayNanoseconds > 0 { try await Task.sleep(nanoseconds: syncDelayNanoseconds) }
        return try syncHandler()
    }

    func reportDeviceState(_ report: DeviceStateReport) async throws -> DeviceStateResponse {
        locked { _calls.append("reportDeviceState"); _deviceStateReports.append(report) }
        return try deviceStateHandler(report)
    }

    func postEvents(_ events: [DeviceEvent]) async throws -> DeviceEventsResponse {
        record("postEvents")
        let response = try eventsHandler(events)
        locked { _postedEvents.append(contentsOf: events) }
        return response
    }

    func startBreak(_ request: StartBreakRequest) async throws -> BreakResponse {
        record("startBreak")
        throw StubMobileAPI.notStubbed("startBreak")
    }

    func endBreak(breakSessionId: String, _ request: EndBreakRequest) async throws -> BreakResponse {
        record("endBreak")
        throw StubMobileAPI.notStubbed("endBreak")
    }

    func registerPushToken(_ request: PushTokenRequest) async throws {
        record("registerPushToken")
    }

    private func record(_ call: String) {
        locked { _calls.append(call) }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

final class TestDeviceInfo: DeviceInfoProviding {
    let appVersion = "1.0.0"
    let osVersion = "26.5"
    let model = "iPhone"
    var timeZone = TimeZone(identifier: "Europe/London")!
}

/// A mutable clock for tests.
final class TestClock {
    var now: Date

    init(_ now: Date) {
        self.now = now
    }
}

func iso(_ string: String) -> Date {
    guard let date = WorkModeDateCoding.parse(string) else { fatalError("bad ISO literal \(string)") }
    return date
}

/// Everything a test needs, wired like `DependencyContainer` but with stubs and temp storage.
final class TestEnvironment {
    let api = StubMobileAPI()
    let deviceInfo = TestDeviceInfo()
    let clock: TestClock
    let fileStore: AppGroupFileStore
    let cache: StateCache
    let outbox: EventOutbox
    let plans: PlansStore
    let provider: MockRestrictionProvider
    let syncCoordinator: SyncCoordinator

    init(testCase: XCTestCase, now: Date = iso("2026-10-06T09:00:00Z")) throws {
        clock = TestClock(now)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WorkModeAppTests-\(UUID().uuidString)", isDirectory: true)
        testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        fileStore = try AppGroupFileStore(directory: directory)
        cache = StateCache(fileStore: fileStore)
        outbox = EventOutbox(cache: cache)
        plans = PlansStore(fileStore: fileStore)
        let clock = self.clock
        provider = MockRestrictionProvider(store: InMemoryKeyValueStore(), now: { clock.now })
        syncCoordinator = SyncCoordinator(api: api, cache: cache, outbox: outbox, plans: plans, provider: provider,
                                          deviceInfo: deviceInfo, now: { clock.now })
    }

    @MainActor
    func makeOnboarding(step: OnboardingViewModel.Step = .welcome, onFinished: @escaping () -> Void = {}) -> OnboardingViewModel {
        let clock = self.clock
        return OnboardingViewModel(
            dependencies: OnboardingViewModel.Dependencies(
                api: api, cache: cache, outbox: outbox, provider: provider, selectionConfigurator: provider,
                deviceInfo: deviceInfo, syncCoordinator: syncCoordinator
            ),
            initialStep: step,
            now: { clock.now },
            onFinished: onFinished
        )
    }

    /// Puts the environment in the "joined" state (as after POST /join/confirm).
    func join() throws {
        api.credentials = true
        try cache.update { state in
            state.organisation = Fixtures.organisation
            state.employee = Fixtures.employee
            state.deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        }
    }

    /// A `DependencyContainer` over this environment's stubs and storage (for `AppModel`).
    func makeContainer() -> DependencyContainer {
        let clock = self.clock
        return DependencyContainer(
            configuration: AppConfiguration(apiBaseURL: URL(string: "http://localhost:3000")!, pushEnvironment: .sandbox,
                                            appVersion: "1.0.0", buildNumber: "1"),
            deviceInfo: deviceInfo,
            tokenStore: InMemoryTokenStore(),
            api: api,
            fileStore: fileStore,
            restriction: RestrictionProviderFactory.Choice(provider: provider, selectionConfigurator: provider, isMock: true),
            now: { clock.now }
        )
    }

    /// Authorises the mock and configures a selection.
    func authoriseAndSelect() async throws {
        provider.authorizationOutcome = .approve
        try await provider.requestAuthorization()
        provider.simulateSelection(MockRestrictionProvider.defaultSelection)
    }
}

enum Fixtures {
    static let organisation = Organisation(id: "00000000-0000-4000-8000-000000000001", name: "Harpenden Coffee Co.", timezone: "Europe/London")
    static let employee = Employee(id: "00000000-0000-4000-8000-000000000002", firstName: "Sam", lastName: "Patel", jobTitle: "Barista",
                                   primaryLocation: EmployeeLocation(id: "00000000-0000-4000-8000-000000000003", name: "High St"))
    static let policy = PolicySummary(
        policy: NamedRef(id: "00000000-0000-4000-8000-000000000010", name: "Front of house"),
        version: PolicySummary.VersionRef(id: "00000000-0000-4000-8000-000000000011", versionNumber: 1),
        restrictionConfig: RestrictionConfig(categories: [.socialMedia, .games], alwaysAllowedNote: ["Phone", "Maps"], shieldMessage: "On shift")
    )
    static let breakPolicy = BreakPolicy(id: "00000000-0000-4000-8000-000000000020", name: "Standard", rules: BreakPolicyRules())
    static let shift = Shift(id: "00000000-0000-4000-8000-000000000030", startsAt: iso("2026-10-06T08:00:00Z"), endsAt: iso("2026-10-06T16:00:00Z"), timezone: "Europe/London")

    static func bundle(policyVersion: String? = policy.policyVersionId, scheduleVersion: Int = 1, shifts: [Shift] = [shift], policy: PolicySummary? = policy) -> SyncBundle {
        SyncBundle(policy: policy, breakPolicy: breakPolicy, shifts: shifts, policyVersion: policyVersion,
                   scheduleVersion: scheduleVersion, serverTime: iso("2026-10-06T09:00:00Z"))
    }

    static let me = MeResponse(employee: employee, organisation: organisation, deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                               resolvedPolicy: policy, resolvedBreakPolicy: breakPolicy, policyVersion: policy.policyVersionId, scheduleVersion: 1)

    static let singleMatch = JoinLookupResponse(
        organisation: .init(name: "Harpenden Coffee Co."),
        match: .single,
        employeePreview: EmployeePreview(id: employee.id, firstName: "Sam", lastName: "Patel", jobTitle: "Barista", locationName: "High St")
    )

    static let confirmResponse = JoinConfirmResponse(
        tokens: TokenPair(accessToken: "a", refreshToken: "r-0123456789abcdefghij", accessTokenExpiresAt: iso("2026-10-06T09:15:00Z"),
                          refreshTokenExpiresAt: iso("2027-01-04T09:00:00Z")),
        deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        employee: employee,
        organisation: organisation
    )
}
