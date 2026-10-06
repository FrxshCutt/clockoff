import XCTest
@testable import WorkModeApp

final class OnboardingResumeTests: XCTestCase {
    func testNotJoinedAlwaysStartsAtWelcome() {
        XCTAssertEqual(OnboardingResume.step(joined: false, setupCompleted: false, persisted: .confirmPolicy, authorised: true, hasSelection: true), .welcome)
    }

    func testSetUpPhoneGoesToMain() {
        XCTAssertNil(OnboardingResume.step(joined: true, setupCompleted: true, persisted: .chooseApps, authorised: true, hasSelection: true))
    }

    func testJoinedWithoutProgressStartsAtTheExplainerOrWhereScreenTimeAllows() {
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: nil, authorised: false, hasSelection: false), .screenTimeExplained)
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: nil, authorised: true, hasSelection: false), .chooseApps)
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: nil, authorised: true, hasSelection: true), .confirmPolicy)
    }

    func testPersistedStepIsClampedToWhatTheProviderAllows() {
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: .confirmPolicy, authorised: false, hasSelection: false), .authorise)
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: .confirmPolicy, authorised: true, hasSelection: false), .chooseApps)
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: .confirmPolicy, authorised: true, hasSelection: true), .confirmPolicy)
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: .name, authorised: true, hasSelection: true), .screenTimeExplained,
                       "a step before joining cannot be resumed once joined")
        XCTAssertEqual(OnboardingResume.step(joined: true, setupCompleted: false, persisted: .authorise, authorised: false, hasSelection: false), .authorise)
    }

    func testRepairStartsWhereTheRegressionIs() {
        XCTAssertEqual(OnboardingResume.repairStep(authorised: false, hasSelection: true), .authorise)
        XCTAssertEqual(OnboardingResume.repairStep(authorised: true, hasSelection: false), .chooseApps)
        XCTAssertEqual(OnboardingResume.repairStep(authorised: true, hasSelection: true), .chooseApps)
    }
}
