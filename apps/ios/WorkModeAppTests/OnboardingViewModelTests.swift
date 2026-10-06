import XCTest
@testable import WorkModeApp
import WorkModeCore

@MainActor
final class OnboardingViewModelTests: XCTestCase {
    private var env: TestEnvironment!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self)
    }

    private func modelAtJoin() -> OnboardingViewModel {
        let model = env.makeOnboarding(step: .joinWorkplace)
        model.firstName = "  Sam "
        model.lastName = "Patel"
        model.updateCompanyCode("brew4821")
        return model
    }

    // MARK: Screens 1–2

    func testWelcomeAndNameTransitions() {
        let model = env.makeOnboarding()
        XCTAssertEqual(model.step, .welcome)
        XCTAssertFalse(model.canGoBack)
        model.getStarted()
        XCTAssertEqual(model.step, .name)

        model.submitName()
        XCTAssertEqual(model.step, .name, "names are required")
        XCTAssertNotNil(model.errorMessage)

        model.firstName = "Sam"
        model.lastName = "   "
        XCTAssertFalse(model.canSubmitName)
        model.lastName = "Patel"
        model.submitName()
        XCTAssertEqual(model.step, .joinWorkplace)
        XCTAssertNil(model.errorMessage)

        model.back()
        XCTAssertEqual(model.step, .name)
        model.back()
        XCTAssertEqual(model.step, .welcome)
    }

    // MARK: Screen 3

    func testCompanyCodeAutoFormatsAndGatesLookup() {
        let model = env.makeOnboarding(step: .joinWorkplace)
        model.updateCompanyCode("brew")
        XCTAssertEqual(model.companyCode, "BREW")
        XCTAssertFalse(model.canLookUp)
        model.updateCompanyCode("brew48")
        XCTAssertEqual(model.companyCode, "BREW-48")
        model.updateCompanyCode("BREW-48219")
        XCTAssertEqual(model.companyCode, "BREW-4821")
        XCTAssertTrue(model.canLookUp)
        model.hasEmployeeCode = true
        XCTAssertFalse(model.canLookUp, "an empty employee code blocks lookup once the toggle is on")
        model.employeeCode = "k7p-x2m"
        XCTAssertTrue(model.canLookUp)
    }

    func testLookupSingleMatchMovesToConfirmWithNormalisedRequest() async {
        env.api.lookupHandler = { _ in Fixtures.singleMatch }
        let model = modelAtJoin()
        await model.lookUp()
        XCTAssertEqual(model.step, .confirmIdentity)
        XCTAssertEqual(model.preview?.fullName, "Sam Patel")
        XCTAssertEqual(model.workplaceName, "Harpenden Coffee Co.")
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isWorking)
        XCTAssertEqual(env.api.lookupRequests, [JoinLookupRequest(companyCode: "BREW-4821", firstName: "Sam", lastName: "Patel", inviteCode: nil)])
    }

    func testLookupSendsEmployeeCodeWhenProvided() async {
        env.api.lookupHandler = { _ in Fixtures.singleMatch }
        let model = modelAtJoin()
        model.hasEmployeeCode = true
        model.employeeCode = " k7p-x2m "
        await model.lookUp()
        XCTAssertEqual(env.api.lookupRequests.first?.inviteCode, "K7PX2M")
    }

    func testLookupNoMatchAsksForManager() async {
        env.api.lookupHandler = { _ in JoinLookupResponse(organisation: .init(name: "Org"), match: .noMatch, employeePreview: nil) }
        let model = modelAtJoin()
        await model.lookUp()
        XCTAssertEqual(model.step, .joinWorkplace)
        XCTAssertEqual(model.errorMessage, "Ask your manager to add you")
    }

    func testLookupAmbiguousRevealsEmployeeCode() async {
        env.api.lookupHandler = { _ in JoinLookupResponse(organisation: .init(name: "Org"), match: .ambiguous, employeePreview: nil) }
        let model = modelAtJoin()
        await model.lookUp()
        XCTAssertEqual(model.step, .joinWorkplace)
        XCTAssertTrue(model.hasEmployeeCode)
        XCTAssertEqual(model.errorMessage, "More than one person has this name — ask your manager for your employee code")
    }

    func testLookupErrorCodesMapToEmployeeCopy() async {
        let cases: [(APIErrorCode, Int, String)] = [
            (.invalidCompanyCode, 404, JoinErrorMessages.invalidCompanyCode),
            (.employeeNotFound, 404, "Ask your manager to add you"),
            (.ambiguousMatch, 409, "More than one person has this name — ask your manager for your employee code"),
            (.employeeAlreadyLinked, 409, "This profile is already connected to a device — contact your manager"),
            (.invalidInviteCode, 400, JoinErrorMessages.invalidInviteCode),
            (.rateLimited, 429, JoinErrorMessages.rateLimited),
            (.networkError, 0, JoinErrorMessages.network),
            (.internalError, 500, JoinErrorMessages.serverUnavailable),
            (.validationError, 400, "Check your details and try again."),
        ]
        for (code, status, expected) in cases {
            env.api.lookupHandler = { _ in throw APIError(code: code, message: "server text", status: status) }
            let model = modelAtJoin()
            await model.lookUp()
            XCTAssertEqual(model.errorMessage, expected, code.rawValue)
            XCTAssertEqual(model.step, .joinWorkplace, code.rawValue)
        }
    }

    func testInvalidCompanyCodeIsRejectedLocally() async {
        let model = env.makeOnboarding(step: .joinWorkplace)
        model.firstName = "Sam"
        model.lastName = "Patel"
        model.updateCompanyCode("BRE")
        await model.lookUp()
        XCTAssertTrue(env.api.lookupRequests.isEmpty)
        XCTAssertNotNil(model.errorMessage)
    }

    // MARK: Screen 4

    func testConfirmStoresProfileAndAdvances() async throws {
        env.api.credentials = false
        env.api.lookupHandler = { _ in Fixtures.singleMatch }
        env.api.confirmHandler = { _ in Fixtures.confirmResponse }
        let model = modelAtJoin()
        await model.lookUp()
        await model.confirmIdentity()
        XCTAssertEqual(model.step, .screenTimeExplained)
        XCTAssertFalse(model.canGoBack, "joining cannot be undone by Back")
        let request = try XCTUnwrap(env.api.confirmRequests.first)
        XCTAssertEqual(request.employeeId, Fixtures.employee.id)
        XCTAssertEqual(request.companyCode, "BREW-4821")
        XCTAssertEqual(request.device, MobileDeviceInfo(appVersion: "1.0.0", osVersion: "26.5", model: "iPhone"))
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.organisation, Fixtures.organisation)
        XCTAssertEqual(cached.employee, Fixtures.employee)
        XCTAssertEqual(cached.deviceId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        XCTAssertNil(cached.setupCompletedAt)
    }

    func testConfirmAlreadyLinkedShowsContactManager() async {
        env.api.lookupHandler = { _ in Fixtures.singleMatch }
        env.api.confirmHandler = { _ in throw APIError(code: .employeeAlreadyLinked, message: "x", status: 409) }
        let model = modelAtJoin()
        await model.lookUp()
        await model.confirmIdentity()
        XCTAssertEqual(model.step, .confirmIdentity)
        XCTAssertEqual(model.errorMessage, "This profile is already connected to a device — contact your manager")
        XCTAssertNil(env.cache.load()?.organisation)
    }

    func testRejectIdentityReturnsToJoin() async {
        env.api.lookupHandler = { _ in Fixtures.singleMatch }
        let model = modelAtJoin()
        await model.lookUp()
        model.rejectIdentity()
        XCTAssertEqual(model.step, .joinWorkplace)
        XCTAssertNil(model.preview)
    }

    // MARK: Screens 5–7

    func testAuthoriseWithMockApprovesAndQueuesPermissionGranted() async throws {
        try env.join()
        let model = env.makeOnboarding(step: .screenTimeExplained)
        model.continueFromScreenTimeExplained()
        XCTAssertEqual(model.step, .authorise)
        await model.authorise()
        XCTAssertEqual(model.step, .chooseApps)
        XCTAssertEqual(env.provider.authorizationStatus, .approved)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.permissionGranted])
        XCTAssertEqual(env.cache.load()?.lastPermissionState, .approved)
    }

    func testAuthoriseDeniedOrFailedStaysWithError() async throws {
        try env.join()
        let model = env.makeOnboarding(step: .authorise)
        env.provider.authorizationOutcome = .deny
        await model.authorise()
        XCTAssertEqual(model.step, .authorise)
        XCTAssertNotNil(model.errorMessage)
        env.provider.authorizationOutcome = .fail
        await model.authorise()
        XCTAssertEqual(model.step, .authorise)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertTrue(env.outbox.pending().isEmpty)
    }

    func testChooseAppsWithMockConfiguresSelection() async throws {
        try env.join()
        try await env.provider.requestAuthorization()
        let model = env.makeOnboarding(step: .chooseApps)
        XCTAssertTrue(model.canConfigureSelection)
        XCTAssertFalse(model.hasSelection)
        model.chooseApps()
        XCTAssertEqual(model.step, .confirmPolicy)
        XCTAssertTrue(env.provider.hasSelection())
        let event = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(event.type, .selectionConfigured)
        XCTAssertEqual(event.metadata?.selectionCounts, MockRestrictionProvider.defaultSelection)
    }

    // MARK: Screen 8

    func testLoadPolicyThenCompleteSetupPostsDeviceStateAndSetupCompleted() async throws {
        try env.join()
        try await env.authoriseAndSelect()
        env.api.syncHandler = { Fixtures.bundle() }
        env.api.meHandler = { Fixtures.me }
        var finished = false
        let model = env.makeOnboarding(step: .confirmPolicy) { finished = true }

        await model.loadPolicy()
        XCTAssertEqual(model.policy?.policy.name, "Front of house")
        XCTAssertEqual(model.breakPolicy?.name, "Standard")
        XCTAssertFalse(model.policyLoadFailed)

        await model.completeSetup()
        XCTAssertTrue(finished)
        XCTAssertNil(model.errorMessage)
        let report = try XCTUnwrap(env.api.deviceStateReports.last)
        XCTAssertEqual(report.permissionState, .approved)
        XCTAssertEqual(report.selectionState, .configured)
        XCTAssertEqual(report.selectionCounts, MockRestrictionProvider.defaultSelection)
        XCTAssertEqual(report.policyVersionApplied, Fixtures.policy.policyVersionId)
        XCTAssertEqual(report.timezone, "Europe/London")
        XCTAssertTrue(env.api.postedEvents.map(\.type).contains(.setupCompleted))
        XCTAssertTrue(env.outbox.pending().isEmpty, "every queued event was delivered")
        XCTAssertEqual(env.cache.load()?.setupCompletedAt, env.clock.now)
    }

    func testCompleteSetupFailureKeepsUserOnScreenAndEventQueued() async throws {
        try env.join()
        try await env.authoriseAndSelect()
        env.api.deviceStateHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        var finished = false
        let model = env.makeOnboarding(step: .confirmPolicy) { finished = true }
        await model.completeSetup()
        XCTAssertFalse(finished)
        XCTAssertEqual(model.step, .confirmPolicy)
        XCTAssertEqual(model.errorMessage, "Couldn't finish setup. \(JoinErrorMessages.network)")
        XCTAssertTrue(env.outbox.pending().map(\.type).contains(.setupCompleted))
        XCTAssertNil(env.cache.load()?.setupCompletedAt)

        // Tapping "Complete Setup" again while still offline must not queue a second SETUP_COMPLETED.
        await model.completeSetup()
        await model.completeSetup()
        XCTAssertEqual(env.outbox.pending().filter { $0.type == .setupCompleted }.count, 1)
    }

    func testRetriedOnboardingStepsQueueEachEventOnce() async throws {
        try env.join()
        let model = env.makeOnboarding(step: .authorise)
        await model.authorise()
        model.chooseApps()
        // The employee goes back to screen 6 and forward again.
        model.back()
        model.back()
        await model.authorise()
        model.chooseApps()
        let types = env.outbox.pending().map(\.type)
        XCTAssertEqual(types.filter { $0 == .permissionGranted }.count, 1)
        XCTAssertEqual(types.filter { $0 == .selectionConfigured }.count, 1)
    }

    func testCompleteSetupDropsABatchTheServerRefusesInsteadOfBlocking() async throws {
        try env.join()
        try await env.authoriseAndSelect()
        env.api.eventsHandler = { _ in throw APIError(code: .validationError, message: "bad event", status: 400) }
        var finished = false
        let model = env.makeOnboarding(step: .confirmPolicy) { finished = true }
        await model.completeSetup()
        XCTAssertTrue(finished, "a permanently refused batch does not block setup")
        XCTAssertTrue(env.outbox.pending().isEmpty, "the refused batch is dropped, not retried forever")
    }

    func testCompleteSetupRequiresAuthorisationAndSelection() async throws {
        try env.join()
        let model = env.makeOnboarding(step: .confirmPolicy)
        await model.completeSetup()
        XCTAssertEqual(model.step, .authorise)
        try await env.provider.requestAuthorization()
        let second = env.makeOnboarding(step: .confirmPolicy)
        await second.completeSetup()
        XCTAssertEqual(second.step, .chooseApps)
        XCTAssertTrue(env.api.deviceStateReports.isEmpty)
    }
}
