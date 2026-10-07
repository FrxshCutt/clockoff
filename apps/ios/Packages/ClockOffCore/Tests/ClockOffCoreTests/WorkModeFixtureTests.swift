import CryptoKit
import XCTest
@testable import ClockOffCore

/// Runs the shared Work Mode fixtures (docs/fixtures/workmode-cases.json) through the Swift engine. The bundled
/// copy (Fixtures/workmode-cases.json, a Package resource) must be byte-identical to the docs file whenever the
/// repository is present: `make sync-fixtures` refreshes it.
///
/// Mirrors `packages/shared/src/workMode/workModeFixtures.test.ts`: every case's expected fields are asserted
/// under the same optional-key rule (`upcomingShiftId`, `activeOverrideId`, `liftedCategories` only when present;
/// null asserts "none"), the output survives a JSON round trip, `nextTransitionAt` is the real next change, and
/// the `wallClock` annotations hold in the case's zone.
final class WorkModeFixtureTests: XCTestCase {
    // MARK: Fixture shapes (lenient: unknown categories are dropped, payloads are plain JSON)

    private struct FixtureCase: Decodable {
        var name: String
        var description: String
        var input: Input
        var expected: Expected
        var wallClock: [WallClock]?
    }

    private struct Input: Decodable {
        var now: Date
        var timezone: String?
        var permissionState: String
        var employeeId: String?
        var shifts: [FixtureShift]
        var breakSessions: [FixtureBreak]?
        var overrides: [FixtureOverride]?
        var options: Options?
    }

    private struct Options: Decodable {
        var preShiftWarningMinutes: Int?
        var shiftEndingWarningMinutes: Int?
    }

    private struct FixtureShift: Decodable {
        var id: String
        var startsAt: Date
        var endsAt: Date
        var status: String
        var version: Int?
        var deletedAt: Date?
    }

    private struct FixtureBreak: Decodable {
        var id: String
        var shiftId: String
        var startedAt: Date
        var plannedEndsAt: Date
        var endedAt: Date?
        var status: String
        var restrictionBehaviour: String
        var relaxedCategories: [String]?
    }

    private struct FixtureOverride: Decodable {
        var id: String
        var type: String
        var startsAt: Date
        var expiresAt: Date
        var revokedAt: Date?
        var employeeId: String?
        var payload: Payload?

        struct Payload: Decodable {
            var restrictionBehaviour: String?
            var relaxedCategories: [String]?
        }
    }

    private struct Expected: Decodable {
        var state: String
        var effectiveRestriction: String
        var restrictionsShouldBeActive: Bool
        var activeShiftId: String?
        var activeBreakId: String?
        var nextTransitionAt: Date?
        /// Present only when the key exists in the file (its value may be null).
        var upcomingShiftId: String??
        var activeOverrideId: String??
        var liftedCategories: [String]?

        private enum CodingKeys: String, CodingKey {
            case state, effectiveRestriction, restrictionsShouldBeActive, activeShiftId, activeBreakId, nextTransitionAt
            case upcomingShiftId, activeOverrideId, liftedCategories
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decode(String.self, forKey: .state)
            effectiveRestriction = try c.decode(String.self, forKey: .effectiveRestriction)
            restrictionsShouldBeActive = try c.decode(Bool.self, forKey: .restrictionsShouldBeActive)
            activeShiftId = try c.decodeIfPresent(String.self, forKey: .activeShiftId)
            activeBreakId = try c.decodeIfPresent(String.self, forKey: .activeBreakId)
            nextTransitionAt = try c.decodeIfPresent(Date.self, forKey: .nextTransitionAt)
            upcomingShiftId = c.contains(.upcomingShiftId) ? .some(try c.decodeIfPresent(String.self, forKey: .upcomingShiftId)) : nil
            activeOverrideId = c.contains(.activeOverrideId) ? .some(try c.decodeIfPresent(String.self, forKey: .activeOverrideId)) : nil
            liftedCategories = try c.decodeIfPresent([String].self, forKey: .liftedCategories)
        }
    }

    private struct WallClock: Decodable {
        var utc: Date
        var local: String
    }

    // MARK: Loading

    private static let bundledURL: URL? = Bundle.module.url(forResource: "workmode-cases", withExtension: "json")

    /// docs/fixtures/workmode-cases.json, located by walking up from this file (nil outside the repository).
    private static var repositoryURL: URL? {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("docs/fixtures/workmode-cases.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory.deleteLastPathComponent()
        }
        return nil
    }

    private static func loadCases() throws -> [FixtureCase] {
        let url = try XCTUnwrap(bundledURL, "Fixtures/workmode-cases.json is missing from the test bundle (run `make sync-fixtures`)")
        let data = try Data(contentsOf: url)
        return try JSONDecoder.clockOff.decode([FixtureCase].self, from: data)
    }

    private func engine(for input: Input) throws -> WorkModeEngine {
        var options = WorkModeEngineOptions()
        if let custom = input.options {
            options = WorkModeEngineOptions(
                preShiftWarningMinutes: custom.preShiftWarningMinutes ?? options.preShiftWarningMinutes,
                shiftEndingWarningMinutes: custom.shiftEndingWarningMinutes ?? options.shiftEndingWarningMinutes
            )
        }
        return WorkModeEngine(options: options, timezone: input.timezone, employeeId: input.employeeId)
    }

    private func rows(for input: Input) throws -> (shifts: [Shift], breaks: [BreakSession], overrides: [ActiveOverride], permission: PermissionState) {
        let permission = try XCTUnwrap(PermissionState(rawValue: input.permissionState), "unknown permissionState \(input.permissionState)")
        let shifts = try input.shifts.map { shift in
            Shift(
                id: shift.id,
                startsAt: shift.startsAt,
                endsAt: shift.endsAt,
                timezone: input.timezone ?? "UTC",
                status: try XCTUnwrap(ShiftStatus(rawValue: shift.status), "unknown shift status \(shift.status)"),
                version: shift.version ?? 1,
                deletedAt: shift.deletedAt
            )
        }
        let breaks = try (input.breakSessions ?? []).map { session in
            BreakSession(
                id: session.id,
                clientBreakId: session.id,
                shiftId: session.shiftId,
                startedAt: session.startedAt,
                plannedEndsAt: session.plannedEndsAt,
                endedAt: session.endedAt,
                status: try XCTUnwrap(BreakSessionStatus(rawValue: session.status), "unknown break status \(session.status)"),
                restrictionBehaviour: try XCTUnwrap(BreakRestrictionBehaviour(rawValue: session.restrictionBehaviour), "unknown behaviour \(session.restrictionBehaviour)"),
                relaxedCategories: RestrictionCategory.canonical((session.relaxedCategories ?? []).compactMap(RestrictionCategory.init(rawValue:)))
            )
        }
        let overrides = try (input.overrides ?? []).map { override in
            // Same defensive payload parsing as the TS machine: an unreadable behaviour means RELAX_ALL.
            let behaviour = override.payload?.restrictionBehaviour.flatMap(BreakRestrictionBehaviour.init(rawValue:)) ?? .relaxAll
            let categories = RestrictionCategory.canonical((override.payload?.relaxedCategories ?? []).compactMap(RestrictionCategory.init(rawValue:)))
            return ActiveOverride(
                id: override.id,
                type: try XCTUnwrap(OverrideType(rawValue: override.type), "unknown override type \(override.type)"),
                startsAt: override.startsAt,
                expiresAt: override.expiresAt,
                breakBehaviour: BreakBehaviourSnapshot(restrictionBehaviour: behaviour, relaxedCategories: categories),
                revokedAt: override.revokedAt,
                employeeId: override.employeeId
            )
        }
        return (shifts, breaks, overrides, permission)
    }

    private func evaluate(_ c: FixtureCase, at now: Date? = nil) throws -> ExpectedState {
        let rows = try rows(for: c.input)
        return try engine(for: c.input).computeExpectedState(
            now: now ?? c.input.now,
            shifts: rows.shifts,
            breakSessions: rows.breaks,
            overrides: rows.overrides,
            permissionState: rows.permission
        )
    }

    // MARK: Tests

    func testBundledFixtureMatchesTheRepositoryFile() throws {
        let bundled = try Data(contentsOf: try XCTUnwrap(Self.bundledURL))
        guard let repository = Self.repositoryURL else {
            throw XCTSkip("docs/fixtures/workmode-cases.json not found: running outside the repository")
        }
        let docs = try Data(contentsOf: repository)
        XCTAssertEqual(
            SHA256.hash(data: bundled).description,
            SHA256.hash(data: docs).description,
            "the bundled fixture copy is stale — run `make sync-fixtures` in apps/ios"
        )
    }

    func testFixtureFileIsWellFormed() throws {
        let cases = try Self.loadCases()
        XCTAssertGreaterThanOrEqual(cases.count, 100)
        XCTAssertEqual(Set(cases.map(\.name)).count, cases.count, "case names are unique")
        for c in cases {
            XCTAssertFalse(c.description.isEmpty, c.name)
            XCTAssertFalse(["SYNC_ERROR", "UNKNOWN"].contains(c.expected.state), "\(c.name): device-only states are never expected")
        }
    }

    func testEveryCaseProducesTheExpectedState() throws {
        for c in try Self.loadCases() {
            let result = try evaluate(c)
            XCTAssertEqual(result.state.rawValue, c.expected.state, "\(c.name): state")
            XCTAssertEqual(result.effectiveRestriction.rawValue, c.expected.effectiveRestriction, "\(c.name): effectiveRestriction")
            XCTAssertEqual(result.restrictionsShouldBeActive, c.expected.restrictionsShouldBeActive, "\(c.name): restrictionsShouldBeActive")
            XCTAssertEqual(result.activeShift?.id, c.expected.activeShiftId, "\(c.name): activeShiftId")
            XCTAssertEqual(result.activeBreak?.id, c.expected.activeBreakId, "\(c.name): activeBreakId")
            XCTAssertEqual(result.nextTransitionAt, c.expected.nextTransitionAt, "\(c.name): nextTransitionAt")
            if let upcoming = c.expected.upcomingShiftId {
                XCTAssertEqual(result.upcomingShift?.id, upcoming, "\(c.name): upcomingShiftId")
            }
            if let override = c.expected.activeOverrideId {
                XCTAssertEqual(result.activeOverride?.id, override, "\(c.name): activeOverrideId")
            }
            if let lifted = c.expected.liftedCategories {
                XCTAssertEqual(result.relaxation?.liftedCategories.map(\.rawValue) ?? [], lifted, "\(c.name): liftedCategories")
            }
            XCTAssertEqual(result.computedAt, c.input.now, "\(c.name): computedAt echoes now")
            XCTAssertEqual(result.timezone, c.input.timezone, "\(c.name): timezone is echoed")
            XCTAssertEqual(result.permissionState.rawValue, c.input.permissionState, "\(c.name): permissionState is echoed")
        }
    }

    func testOutputSurvivesAJSONRoundTrip() throws {
        for c in try Self.loadCases() {
            let result = try evaluate(c)
            let data = try JSONEncoder.clockOff.encode(result)
            let decoded = try JSONDecoder.clockOff.decode(ExpectedState.self, from: data)
            XCTAssertEqual(decoded, result, c.name)
            let object = try jsonObject(data)
            XCTAssertEqual(object["state"] as? String, c.expected.state, c.name)
            if let next = c.expected.nextTransitionAt {
                XCTAssertEqual(object["nextTransitionAt"] as? String, ClockOffDateCoding.format(next), c.name)
            } else {
                XCTAssertNil(object["nextTransitionAt"], c.name)
            }
        }
    }

    func testNextTransitionAtIsTheRealNextChange() throws {
        for c in try Self.loadCases() {
            let result = try evaluate(c)
            guard let next = result.nextTransitionAt else { continue }
            XCTAssertGreaterThan(next, c.input.now, "\(c.name): strictly in the future")
            let justBefore = try evaluate(c, at: next.addingTimeInterval(-0.001))
            XCTAssertEqual(WorkModeEngine.restrictionSignature(justBefore), WorkModeEngine.restrictionSignature(result),
                           "\(c.name): nothing changes before nextTransitionAt")
            XCTAssertEqual(justBefore.nextTransitionAt, next, "\(c.name): the next change is still the same instant")
            let atNext = try evaluate(c, at: next)
            XCTAssertNotEqual(WorkModeEngine.restrictionSignature(atNext), WorkModeEngine.restrictionSignature(result),
                              "\(c.name): something changes at nextTransitionAt")
        }
    }

    func testEvaluationIsIndependentOfInputOrder() throws {
        for c in try Self.loadCases() {
            let rows = try rows(for: c.input)
            let engine = try engine(for: c.input)
            let forward = engine.computeExpectedState(now: c.input.now, shifts: rows.shifts, breakSessions: rows.breaks,
                                                      overrides: rows.overrides, permissionState: rows.permission)
            let reversed = engine.computeExpectedState(now: c.input.now, shifts: rows.shifts.reversed(), breakSessions: rows.breaks.reversed(),
                                                       overrides: rows.overrides.reversed(), permissionState: rows.permission)
            XCTAssertEqual(forward, reversed, c.name)
        }
    }

    func testWallClockAnnotationsHoldInTheCaseZone() throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        var checked = 0
        for c in try Self.loadCases() {
            guard let annotations = c.wallClock else { continue }
            formatter.timeZone = try XCTUnwrap(TimeZone(identifier: c.input.timezone ?? "UTC"), c.name)
            for w in annotations {
                XCTAssertEqual(formatter.string(from: w.utc), w.local, "\(c.name): \(ClockOffDateCoding.format(w.utc))")
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 0, "the DST cases carry wallClock annotations")
    }

    func testDeviceComponentsAgreeWithTheWallClockAnnotations() throws {
        for c in try Self.loadCases() {
            guard let annotations = c.wallClock else { continue }
            let zone = try XCTUnwrap(TimeZone(identifier: c.input.timezone ?? "UTC"))
            for w in annotations {
                let components = deviceComponents(for: w.utc, in: zone)
                let rendered = String(format: "%04d-%02d-%02dT%02d:%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0,
                                      components.hour ?? 0, components.minute ?? 0)
                XCTAssertEqual(rendered, w.local, "\(c.name): DeviceActivity components use the same wall clock")
            }
        }
    }
}
