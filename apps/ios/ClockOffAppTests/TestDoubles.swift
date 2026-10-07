import Foundation
import XCTest
@testable import ClockOffApp
import ClockOffCore

/// Stubbed `MobileAPI`: each endpoint answers from a closure; every call is recorded.
final class StubMobileAPI: MobileAPI {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _deviceStateReports: [DeviceStateReport] = []
    private var _postedEvents: [DeviceEvent] = []
    private var _postedBatches: [[DeviceEvent]] = []
    private var _lookupRequests: [JoinLookupRequest] = []
    private var _confirmRequests: [JoinConfirmRequest] = []
    private var _startBreakRequests: [StartBreakRequest] = []
    private var _endBreakRequests: [(id: String, request: EndBreakRequest)] = []

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
    var startBreakHandler: (StartBreakRequest) throws -> BreakResponse = { _ in throw StubMobileAPI.notStubbed("startBreak") }
    var endBreakHandler: (String, EndBreakRequest) throws -> BreakResponse = { _, _ in throw StubMobileAPI.notStubbed("endBreak") }
    var leaveHandler: () throws -> Void = {}
    var syncDelayNanoseconds: UInt64 = 0

    static func notStubbed(_ name: String) -> APIError {
        APIError(code: "NOT_STUBBED", message: "\(name) not stubbed", status: 0)
    }

    var calls: [String] { locked { _calls } }
    var deviceStateReports: [DeviceStateReport] { locked { _deviceStateReports } }
    var postedEvents: [DeviceEvent] { locked { _postedEvents } }
    var postedBatches: [[DeviceEvent]] { locked { _postedBatches } }
    var lookupRequests: [JoinLookupRequest] { locked { _lookupRequests } }
    var confirmRequests: [JoinConfirmRequest] { locked { _confirmRequests } }
    var startBreakRequests: [StartBreakRequest] { locked { _startBreakRequests } }
    var endBreakRequests: [(id: String, request: EndBreakRequest)] { locked { _endBreakRequests } }

    /// Answers `POST /breaks/start` like the server: an ACTIVE RELAX_ALL session with a server id.
    func acceptBreaks(minutes: Int = 15) {
        startBreakHandler = { request in
            let session = BreakSession(
                id: "server-\(request.clientBreakId)",
                clientBreakId: request.clientBreakId,
                shiftId: request.shiftId,
                startedAt: request.requestedAt,
                plannedEndsAt: request.requestedAt.addingTimeInterval(TimeInterval((request.requestedDurationMinutes ?? minutes) * 60)),
                restrictionBehaviour: .relaxAll
            )
            return BreakResponse(breakSession: session, allowance: nil)
        }
        endBreakHandler = { id, request in
            BreakResponse(breakSession: BreakSession(id: id, clientBreakId: "", shiftId: Fixtures.shift.id, startedAt: request.endedAt,
                                                     plannedEndsAt: request.endedAt, endedAt: request.endedAt, status: .ended,
                                                     endReason: .employeeEnded), allowance: nil)
        }
    }

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
        locked {
            _postedEvents.append(contentsOf: events)
            _postedBatches.append(events)
        }
        return response
    }

    func startBreak(_ request: StartBreakRequest) async throws -> BreakResponse {
        locked { _calls.append("startBreak"); _startBreakRequests.append(request) }
        return try startBreakHandler(request)
    }

    func endBreak(breakSessionId: String, _ request: EndBreakRequest) async throws -> BreakResponse {
        locked { _calls.append("endBreak"); _endBreakRequests.append((breakSessionId, request)) }
        return try endBreakHandler(breakSessionId, request)
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

/// Records every local-notification call instead of touching UNUserNotificationCenter.
final class StubNotificationScheduler: LocalNotificationScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var _planned: [[PlannedNotification]] = []
    private var _posted: [(id: String, title: String, body: String)] = []
    private var _permissionRequests = 0
    private var _cancelAllCount = 0
    var grantPermission = true

    /// Every `replacePlanned` call, oldest first.
    var plannedHistory: [[PlannedNotification]] { locked { _planned } }
    /// The most recent plan (empty when never planned).
    var lastPlanned: [PlannedNotification] { locked { _planned.last ?? [] } }
    var posted: [(id: String, title: String, body: String)] { locked { _posted } }
    var permissionRequests: Int { locked { _permissionRequests } }
    var cancelAllCount: Int { locked { _cancelAllCount } }

    func requestPermission() async -> Bool {
        locked { _permissionRequests += 1 }
        return grantPermission
    }

    func replacePlanned(_ planned: [PlannedNotification], timeZone: TimeZone) async {
        locked { _planned.append(planned) }
    }

    func postNow(id: String, title: String, body: String) async {
        locked { _posted.append((id, title, body)) }
    }

    func cancelAll() async {
        locked { _cancelAllCount += 1 }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

final class StubConnectivityMonitor: ConnectivityMonitoring {
    var isOnline = true
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private var handler: ((Bool) -> Void)?

    func start(onChange: @escaping (Bool) -> Void) {
        startCount += 1
        handler = onChange
    }

    func stop() {
        stopCount += 1
    }

    func simulate(online: Bool) {
        isOnline = online
        handler?(online)
    }
}

func iso(_ string: String) -> Date {
    guard let date = ClockOffDateCoding.parse(string) else { fatalError("bad ISO literal \(string)") }
    return date
}

/// Everything a test needs, wired like `DependencyContainer` but with stubs and temp storage.
final class TestEnvironment {
    let api = StubMobileAPI()
    let deviceInfo = TestDeviceInfo()
    let notifications = StubNotificationScheduler()
    let connectivity = StubConnectivityMonitor()
    let metadataStore = InMemoryKeyValueStore()
    let clock: TestClock
    let fileStore: AppGroupFileStore
    let cache: StateCache
    let outbox: EventOutbox
    let plans: PlansStore
    let provider: MockRestrictionProvider
    let sharedFlags: SharedFlags
    let syncMetadata: SyncMetadataStore
    let onboardingProgress: OnboardingProgressStore
    let breakAPI: MobileAPIBreakClient
    let syncCoordinator: SyncCoordinator

    init(testCase: XCTestCase, now: Date = iso("2026-10-06T09:00:00Z")) throws {
        clock = TestClock(now)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ClockOffAppTests-\(UUID().uuidString)", isDirectory: true)
        testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        fileStore = try AppGroupFileStore(directory: directory)
        cache = StateCache(fileStore: fileStore)
        outbox = EventOutbox(cache: cache)
        plans = PlansStore(fileStore: fileStore)
        let clock = self.clock
        provider = MockRestrictionProvider(store: InMemoryKeyValueStore(), now: { clock.now })
        sharedFlags = SharedFlags(store: InMemoryKeyValueStore())
        syncMetadata = SyncMetadataStore(store: metadataStore)
        onboardingProgress = OnboardingProgressStore(store: metadataStore)
        breakAPI = MobileAPIBreakClient(api: api)
        syncCoordinator = SyncCoordinator(api: api, cache: cache, outbox: outbox, plans: plans, provider: provider, deviceInfo: deviceInfo,
                                          breakAPI: breakAPI, notifications: notifications, metadata: syncMetadata, now: { clock.now })
    }

    /// A coordinator over another provider (e.g. one that fails scheduling) sharing this environment's storage.
    func makeSyncCoordinator(provider: AppRestrictionProvider) -> SyncCoordinator {
        let clock = self.clock
        return SyncCoordinator(api: api, cache: cache, outbox: outbox, plans: plans, provider: provider, deviceInfo: deviceInfo,
                               breakAPI: breakAPI, notifications: notifications, metadata: syncMetadata, now: { clock.now })
    }

    @MainActor
    func makeOnboarding(step: OnboardingViewModel.Step = .welcome, mode: OnboardingViewModel.Mode = .setup, onFinished: @escaping () -> Void = {}) -> OnboardingViewModel {
        let clock = self.clock
        return OnboardingViewModel(
            dependencies: OnboardingViewModel.Dependencies(
                api: api, cache: cache, outbox: outbox, provider: provider, selectionConfigurator: provider, selectionStatus: provider,
                deviceInfo: deviceInfo, syncCoordinator: syncCoordinator, notifications: notifications,
                progress: mode == .setup ? onboardingProgress : nil, isSimulated: true
            ),
            mode: mode,
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
            configuration: AppConfiguration(apiBaseURL: URL(string: "http://localhost:3000/api/mobile/v1")!, pushEnvironment: .sandbox,
                                            appVersion: "1.0.0", buildNumber: "1"),
            deviceInfo: deviceInfo,
            tokenStore: InMemoryTokenStore(),
            api: api,
            fileStore: fileStore,
            restriction: RestrictionProviderFactory.Choice(provider: provider, selectionConfigurator: provider, isMock: true),
            sharedFlags: sharedFlags,
            metadataStore: metadataStore,
            notifications: notifications,
            connectivity: connectivity,
            now: { clock.now }
        )
    }

    /// A `WorkModeController` over this environment (same clock and zone as the stubs).
    @MainActor
    func makeController(breakAPI: BreakStarting? = nil) -> WorkModeController {
        let clock = self.clock
        let zone = deviceInfo.timeZone
        return WorkModeController(
            cache: cache,
            plans: plans,
            provider: provider,
            breakAPI: breakAPI ?? self.breakAPI,
            flags: sharedFlags,
            isDevelopmentMode: true,
            timeZone: { zone },
            now: { clock.now }
        )
    }

    /// An `AppModel` with a container and controller over this environment.
    @MainActor
    func makeAppModel(container: DependencyContainer? = nil) -> AppModel {
        let clock = self.clock
        return AppModel(container: container ?? makeContainer(), controller: makeController(), now: { clock.now })
    }

    /// Authorises the mock and configures a selection.
    func authoriseAndSelect() async throws {
        provider.authorizationOutcome = .approve
        try await provider.requestAuthorization()
        provider.simulateSelection(MockRestrictionProvider.defaultSelection)
    }

    /// A phone that finished setup, with today's 08:00–16:00 shift and a policy cached.
    func setUpCompletedPhone(lastSyncAt: Date = iso("2026-10-06T06:55:00Z")) async throws {
        try join()
        try await authoriseAndSelect()
        try cache.update { state in
            state.policy = Fixtures.policy
            state.breakPolicy = Fixtures.breakPolicy
            state.shifts = [Fixtures.shift]
            state.policyVersion = Fixtures.policy.policyVersionId
            state.scheduleVersion = 1
            state.lastSyncAt = lastSyncAt
            state.lastScheduleSyncAt = lastSyncAt
            state.lastPolicySyncAt = lastSyncAt
            state.setupCompletedAt = iso("2026-10-05T12:00:00Z")
            state.lastPermissionState = .approved
        }
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
    /// Breaks relax Social Media only: Games must stay blocked, so a second selection is needed.
    static let relaxCategoriesBreakPolicy = BreakPolicy(
        id: "00000000-0000-4000-8000-000000000021", name: "Social only",
        rules: BreakPolicyRules(restrictionBehaviour: .relaxCategories, relaxedCategories: [.socialMedia])
    )
    static let shift = Shift(id: "00000000-0000-4000-8000-000000000030", startsAt: iso("2026-10-06T08:00:00Z"), endsAt: iso("2026-10-06T16:00:00Z"), timezone: "Europe/London")

    static func bundle(policyVersion: String? = policy.policyVersionId, scheduleVersion: Int = 1, shifts: [Shift] = [shift], policy: PolicySummary? = policy,
                       activeBreakSession: BreakSession? = nil) -> SyncBundle {
        SyncBundle(policy: policy, breakPolicy: breakPolicy, shifts: shifts, policyVersion: policyVersion,
                   scheduleVersion: scheduleVersion, serverTime: iso("2026-10-06T09:00:00Z"), activeBreakSession: activeBreakSession)
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
