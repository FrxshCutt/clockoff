import Foundation
import XCTest
@testable import WorkModeCore

/// Parses an ISO-8601 literal in tests (fails the test on a typo).
func iso(_ string: String, file: StaticString = #filePath, line: UInt = #line) -> Date {
    guard let date = WorkModeDateCoding.parse(string) else {
        XCTFail("bad ISO date literal \(string)", file: file, line: line)
        return Date(timeIntervalSince1970: 0)
    }
    return date
}

func decode<T: Decodable>(_ type: T.Type, _ json: String, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try JSONDecoder.workMode.decode(T.self, from: Data(json.utf8))
}

func jsonObject(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// A fresh temporary directory, removed when the test case tears down.
func makeTemporaryDirectory(_ testCase: XCTestCase) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("WorkModeCoreTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    testCase.addTeardownBlock {
        try? FileManager.default.removeItem(at: url)
    }
    return url
}

enum Fixture {
    static let policyJSON = """
    {
      "policy": { "id": "11111111-1111-4111-8111-111111111111", "name": "Front of house" },
      "version": { "id": "22222222-2222-4222-8222-222222222222", "versionNumber": 3 },
      "restrictionConfig": {
        "categories": ["SOCIAL_MEDIA", "GAMES", "STREAMING"],
        "requireEmployeeAppSelection": true,
        "alwaysAllowedNote": ["Phone", "Messages", "Maps"],
        "shieldMessage": "You're on shift — this app is paused.",
        "activationMode": "SCHEDULED",
        "preShiftWarningMinutes": 10
      }
    }
    """

    static let breakPolicyJSON = """
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "name": "Standard breaks",
      "rules": {
        "breaksEnabled": true,
        "maxBreaksPerShift": 2,
        "maxBreakDurationMinutes": 15,
        "maxTotalBreakMinutes": 30,
        "minGapBetweenBreaksMinutes": 60,
        "minMinutesAfterShiftStart": 60,
        "employeeTriggeredAllowed": true,
        "scheduledBreaksAllowed": true,
        "restrictionBehaviour": "RELAX_CATEGORIES",
        "relaxedCategories": ["SOCIAL_MEDIA"]
      }
    }
    """

    static let syncJSON = """
    {
      "policy": \(policyJSON),
      "breakPolicy": \(breakPolicyJSON),
      "shifts": [
        {
          "id": "44444444-4444-4444-8444-444444444444",
          "startsAt": "2026-10-06T08:00:00.000Z",
          "endsAt": "2026-10-06T16:00:00.000Z",
          "timezone": "Europe/London",
          "status": "SCHEDULED",
          "location": { "id": "55555555-5555-4555-8555-555555555555", "name": "Harpenden High St" },
          "notes": null,
          "version": 2,
          "scheduledBreaks": [
            { "id": "66666666-6666-4666-8666-666666666666", "offsetMinutesFromStart": 180, "durationMinutes": 15,
              "startsAt": "2026-10-06T11:00:00.000Z", "endsAt": "2026-10-06T11:15:00.000Z" }
          ]
        }
      ],
      "policyVersion": "22222222-2222-4222-8222-222222222222",
      "scheduleVersion": 7,
      "serverTime": "2026-10-06T09:30:00.123Z",
      "activeOverrides": [
        { "id": "77777777-7777-4777-8777-777777777777", "type": "TEMPORARY_EXCEPTION",
          "startsAt": "2026-10-06T12:00:00Z", "expiresAt": "2026-10-06T12:30:00Z",
          "breakBehaviour": { "restrictionBehaviour": "RELAX_ALL", "relaxedCategories": [] } },
        { "id": "88888888-8888-4888-8888-888888888888", "type": "SOME_FUTURE_OVERRIDE",
          "startsAt": "2026-10-06T12:00:00Z", "expiresAt": "2026-10-06T12:30:00Z", "breakBehaviour": null }
      ],
      "expectedState": {
        "state": "WORKING",
        "effectiveRestriction": "WORK",
        "restrictionsShouldBeActive": true,
        "computedAt": "2026-10-06T09:30:00.000Z",
        "timezone": "Europe/London",
        "permissionState": "APPROVED",
        "activeShift": { "id": "44444444-4444-4444-8444-444444444444", "startsAt": "2026-10-06T08:00:00.000Z", "endsAt": "2026-10-06T16:00:00.000Z" },
        "upcomingShift": null,
        "activeBreak": null,
        "activeOverride": null,
        "workingInterval": {
          "startsAt": "2026-10-06T08:00:00.000Z", "endsAt": "2026-10-06T16:00:00.000Z",
          "shiftIds": ["44444444-4444-4444-8444-444444444444"],
          "shifts": [{ "id": "44444444-4444-4444-8444-444444444444", "startsAt": "2026-10-06T08:00:00.000Z", "endsAt": "2026-10-06T16:00:00.000Z" }]
        },
        "relaxation": null,
        "nextTransitionAt": "2026-10-06T15:55:00.000Z"
      },
      "activeBreakSession": null,
      "breakAllowance": {
        "breaksTaken": 0, "breaksRemaining": 2, "minutesUsed": 0, "minutesRemaining": 30,
        "nextEligibleAt": "2026-10-06T09:00:00.000Z", "canStartNow": true
      }
    }
    """

    static func policy() throws -> PolicySummary {
        try decode(PolicySummary.self, policyJSON)
    }

    static func breakPolicy() throws -> BreakPolicy {
        try decode(BreakPolicy.self, breakPolicyJSON)
    }

    static func shift(_ id: String, _ start: String, _ end: String, status: ShiftStatus = .scheduled) -> Shift {
        Shift(id: id, startsAt: iso(start), endsAt: iso(end), timezone: "Europe/London", status: status)
    }

    static let tokens = TokenPair(
        accessToken: "access-old",
        refreshToken: "refresh-old-0123456789abcdef",
        accessTokenExpiresAt: Date(timeIntervalSince1970: 1_800_000_000),
        refreshTokenExpiresAt: Date(timeIntervalSince1970: 1_900_000_000)
    )
}
