import XCTest
@testable import WorkModeCore

final class JSONCodingTests: XCTestCase {
    private struct Box: Codable, Equatable {
        var at: Date
    }

    func testParsesInstantsWithAndWithoutFractionalSeconds() {
        let base = Date(timeIntervalSince1970: 1_791_277_200) // 2026-10-06T09:00:00Z
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T09:00:00Z"), base)
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T09:00:00.000Z"), base)
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T09:00:00.250Z")?.timeIntervalSince(base) ?? -1, 0.25, accuracy: 0.0005)
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T10:00:00+01:00"), base)
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T10:00:00.5+01:00")?.timeIntervalSince(base) ?? -1, 0.5, accuracy: 0.0005)
        // Microseconds from another producer are truncated to milliseconds.
        XCTAssertEqual(WorkModeDateCoding.parse("2026-10-06T09:00:00.123456Z")?.timeIntervalSince(base) ?? -1, 0.123, accuracy: 0.0005)
    }

    func testRejectsLocalTimesAndGarbage() {
        XCTAssertNil(WorkModeDateCoding.parse("2026-10-06T09:00:00"), "a wall-clock time without an offset is not an instant")
        XCTAssertNil(WorkModeDateCoding.parse("2026-10-06"))
        XCTAssertNil(WorkModeDateCoding.parse("yesterday"))
        XCTAssertThrowsError(try decode(Box.self, #"{"at":"2026-10-06 09:00"}"#))
    }

    func testFormatsCanonicalUTCWithMilliseconds() {
        XCTAssertEqual(WorkModeDateCoding.format(Date(timeIntervalSince1970: 1_791_277_200.25)), "2026-10-06T09:00:00.250Z")
    }

    func testEncoderRoundTripsAndSortsKeys() throws {
        let data = try JSONEncoder.workMode.encode(Box(at: Date(timeIntervalSince1970: 1_791_277_200)))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"at":"2026-10-06T09:00:00.000Z"}"#)
        XCTAssertEqual(try JSONDecoder.workMode.decode(Box.self, from: data), Box(at: Date(timeIntervalSince1970: 1_791_277_200)))
    }

    func testUnknownWorkModeAndPermissionStatesDecodeAsUnknown() throws {
        XCTAssertEqual(try decode([WorkModeState].self, #"["WORKING","TELEPORTING"]"#), [.working, .unknown])
        XCTAssertEqual(try decode([PermissionState].self, #"["APPROVED","SOMETHING_NEW"]"#), [.approved, .unknown])
        XCTAssertThrowsError(try decode([ShiftStatus].self, #"["PAUSED"]"#), "other enums stay strict")
    }

    func testEnumRawValuesMirrorSharedEnums() {
        XCTAssertEqual(WorkModeState.allCases.map(\.rawValue), [
            "OFF_SHIFT", "SHIFT_STARTING_SOON", "WORKING", "ON_BREAK", "SHIFT_ENDING",
            "MANAGER_OVERRIDE", "PERMISSION_ERROR", "SYNC_ERROR", "UNKNOWN",
        ])
        XCTAssertEqual(RestrictionCategory.allCases.map(\.rawValue), [
            "SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT", "STREAMING", "VIDEO", "SHOPPING", "DATING", "OTHER_SELECTED",
        ])
        XCTAssertEqual(ActivityEventType.allCases.map(\.rawValue), [
            "SETUP_COMPLETED", "PERMISSION_GRANTED", "PERMISSION_NEEDS_ATTENTION", "SELECTION_CONFIGURED",
            "WORK_MODE_STARTED", "WORK_MODE_ENDED", "BREAK_STARTED", "BREAK_ENDED", "BREAK_EXPIRED",
            "SCHEDULE_SYNCED", "POLICY_SYNCED",
        ])
        XCTAssertEqual(PermissionState.allCases.map(\.rawValue), ["NOT_DETERMINED", "APPROVED", "DENIED", "REVOKED", "UNKNOWN"])
        XCTAssertEqual(BreakRestrictionBehaviour.allCases.map(\.rawValue), ["RELAX_ALL", "RELAX_CATEGORIES", "KEEP_RESTRICTIONS"])
    }
}
