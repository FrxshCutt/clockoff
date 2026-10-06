import XCTest
@testable import WorkModeCore

final class ModelDecodingTests: XCTestCase {
    func testDecodesSyncBundle() throws {
        let bundle = try decode(SyncBundle.self, Fixture.syncJSON)
        XCTAssertEqual(bundle.policy?.policy.name, "Front of house")
        XCTAssertEqual(bundle.policy?.policyVersionId, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(bundle.policy?.restrictionConfig.categories, [.socialMedia, .games, .streaming])
        XCTAssertEqual(bundle.policy?.restrictionConfig.preShiftWarningMinutes, 10)
        XCTAssertEqual(bundle.policy?.restrictionConfig.alwaysAllowedNote, ["Phone", "Messages", "Maps"])
        XCTAssertEqual(bundle.breakPolicy?.rules.restrictionBehaviour, .relaxCategories)
        XCTAssertEqual(bundle.breakPolicy?.rules.relaxedCategories, [.socialMedia])
        XCTAssertEqual(bundle.policyVersion, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(bundle.scheduleVersion, 7)
        XCTAssertEqual(bundle.serverTime, iso("2026-10-06T09:30:00.123Z"))

        let shift = try XCTUnwrap(bundle.shifts.first)
        XCTAssertEqual(shift.startsAt, iso("2026-10-06T08:00:00Z"))
        XCTAssertEqual(shift.version, 2)
        XCTAssertEqual(shift.location?.name, "Harpenden High St")
        XCTAssertNil(shift.notes)
        XCTAssertEqual(shift.scheduledBreaks.first?.durationMinutes, 15)
        XCTAssertEqual(shift.scheduledBreaks.first?.startsAt, iso("2026-10-06T11:00:00Z"))
        XCTAssertTrue(shift.isEffective)

        // The override type this build does not know is skipped; the known one survives.
        XCTAssertEqual(bundle.activeOverrides.map(\.id), ["77777777-7777-4777-8777-777777777777"])
        XCTAssertEqual(bundle.activeOverrides.first?.breakBehaviour?.restrictionBehaviour, .relaxAll)

        let expected = try XCTUnwrap(bundle.expectedState)
        XCTAssertEqual(expected.state, .working)
        XCTAssertEqual(expected.effectiveRestriction, .work)
        XCTAssertEqual(expected.workingInterval?.shiftIds, ["44444444-4444-4444-8444-444444444444"])
        XCTAssertEqual(expected.nextTransitionAt, iso("2026-10-06T15:55:00Z"))
        XCTAssertNil(bundle.activeBreakSession)
        XCTAssertEqual(bundle.breakAllowance?.breaksRemaining, 2)
        XCTAssertEqual(bundle.breakAllowance?.canStartNow, true)
    }

    func testRestrictionConfigDropsUnknownCategoriesAndAppliesDefaults() throws {
        let config = try decode(RestrictionConfig.self, #"{"categories":["GAMES","HOLOGRAMS","SOCIAL_MEDIA","GAMES"]}"#)
        XCTAssertEqual(config.categories, [.socialMedia, .games], "canonical order, unknown and duplicate entries dropped")
        XCTAssertTrue(config.requireEmployeeAppSelection)
        XCTAssertEqual(config.alwaysAllowedNote, [])
        XCTAssertEqual(config.activationMode, .scheduled)
        XCTAssertEqual(config.preShiftWarningMinutes, 15)
        XCTAssertNil(config.shieldMessage)
    }

    func testRelaxationDerivesLiftedCategoriesWhenAbsent() throws {
        let all = try decode(RestrictionRelaxation.self, #"{"source":"BREAK","restrictionBehaviour":"RELAX_ALL","relaxedCategories":[]}"#)
        XCTAssertEqual(all.liftedCategories, RestrictionCategory.allCases)
        let some = try decode(RestrictionRelaxation.self, #"{"source":"OVERRIDE","restrictionBehaviour":"RELAX_CATEGORIES","relaxedCategories":["GAMES"]}"#)
        XCTAssertEqual(some.source, .override)
        XCTAssertEqual(some.liftedCategories, [.games])
    }

    func testDecodesJoinLookupResponses() throws {
        let single = try decode(JoinLookupResponse.self, """
        {"organisation":{"name":"Harpenden Coffee Co."},"match":"SINGLE",
         "employeePreview":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","firstName":"Sam","lastName":"Patel","jobTitle":"Barista","locationName":"High St"}}
        """)
        XCTAssertEqual(single.match, .single)
        XCTAssertEqual(single.organisation.name, "Harpenden Coffee Co.")
        XCTAssertEqual(single.employeePreview?.fullName, "Sam Patel")
        XCTAssertEqual(single.employeePreview?.locationName, "High St")

        let ambiguous = try decode(JoinLookupResponse.self, #"{"organisation":{"name":"X"},"match":"AMBIGUOUS","employeePreview":null}"#)
        XCTAssertEqual(ambiguous.match, .ambiguous)
        XCTAssertNil(ambiguous.employeePreview)
        XCTAssertEqual(try decode(JoinLookupResponse.self, #"{"organisation":{"name":"X"},"match":"NONE","employeePreview":null}"#).match, .noMatch)
    }

    func testDecodesJoinConfirmResponseWithFlattenedTokens() throws {
        let response = try decode(JoinConfirmResponse.self, """
        {"accessToken":"a.b.c","refreshToken":"r-0123456789abcdefghij","accessTokenExpiresAt":"2026-10-06T09:15:00.000Z",
         "refreshTokenExpiresAt":"2027-01-04T09:00:00.000Z","deviceId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
         "employee":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","firstName":"Sam","lastName":"Patel","jobTitle":null,
                     "primaryLocation":{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","name":"High St","timezone":null}},
         "organisation":{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","name":"Harpenden Coffee Co.","timezone":"Europe/London"}}
        """)
        XCTAssertEqual(response.tokens.accessToken, "a.b.c")
        XCTAssertEqual(response.tokens.accessTokenExpiresAt, iso("2026-10-06T09:15:00Z"))
        XCTAssertEqual(response.deviceId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        XCTAssertNil(response.employee.jobTitle)
        XCTAssertEqual(response.employee.primaryLocation?.name, "High St")
        XCTAssertEqual(response.organisation.timezone, "Europe/London")
    }

    func testDecodesMeScheduleDeviceStateEventsAndBreakResponses() throws {
        let me = try decode(MeResponse.self, """
        {"employee":{"id":"e","firstName":"Sam","lastName":"Patel","jobTitle":"Barista","primaryLocation":null},
         "organisation":{"id":"o","name":"Org","timezone":"Europe/London"},"deviceId":"d",
         "resolvedPolicy":\(Fixture.policyJSON),"resolvedBreakPolicy":null,"policyVersion":"22222222-2222-4222-8222-222222222222","scheduleVersion":4}
        """)
        XCTAssertEqual(me.scheduleVersion, 4)
        XCTAssertEqual(me.resolvedPolicy?.version.versionNumber, 3)
        XCTAssertNil(me.resolvedBreakPolicy)

        let schedule = try decode(ScheduleResponse.self, """
        {"from":"2026-10-05T00:00:00.000Z","to":"2026-10-20T00:00:00.000Z","shifts":[],"scheduleVersion":4,"serverTime":"2026-10-06T09:00:00Z"}
        """)
        XCTAssertEqual(schedule.shifts.count, 0)
        XCTAssertEqual(schedule.to, iso("2026-10-20T00:00:00Z"))

        let state = try decode(DeviceStateResponse.self, #"{"ok":true,"serverTime":"2026-10-06T09:00:00.000Z","clockSkewSeconds":-3,"expectedState":null}"#)
        XCTAssertEqual(state.clockSkewSeconds, -3)
        XCTAssertNil(state.expectedState)

        let events = try decode(DeviceEventsResponse.self, #"{"accepted":2,"duplicates":1,"rejected":[{"clientEventId":"x","code":"VALIDATION_ERROR"}]}"#)
        XCTAssertEqual(events.accepted, 2)
        XCTAssertEqual(events.rejected.first?.code, "VALIDATION_ERROR")

        let breakResponse = try decode(BreakResponse.self, """
        {"breakSession":{"id":"b","clientBreakId":"c","shiftId":"s","startedAt":"2026-10-06T11:00:00.000Z",
          "plannedEndsAt":"2026-10-06T11:15:00.000Z","endedAt":null,"status":"ACTIVE","endReason":null,
          "restrictionBehaviour":"RELAX_CATEGORIES","relaxedCategories":["SOCIAL_MEDIA"]},
         "allowance":{"breaksTaken":1,"breaksRemaining":1,"minutesUsed":15,"minutesRemaining":15,"nextEligibleAt":null,"canStartNow":false}}
        """)
        XCTAssertEqual(breakResponse.breakSession.status, .active)
        XCTAssertEqual(breakResponse.breakSession.relaxedCategories, [.socialMedia])
        XCTAssertEqual(breakResponse.allowance?.breaksTaken, 1)
    }

    func testDecodesErrorEnvelope() throws {
        let envelope = try decode(APIErrorEnvelope.self, #"{"error":{"code":"AMBIGUOUS_MATCH","message":"More than one","details":{"x":1}}}"#)
        XCTAssertEqual(APIErrorCode(rawValue: envelope.error.code), .ambiguousMatch)
        XCTAssertEqual(envelope.error.message, "More than one")
    }

    // MARK: Requests carry only allow-listed fields (§12)

    func testDeviceStateReportEncodesOnlyAllowListedFields() throws {
        let report = DeviceStateReport(
            permissionState: .approved,
            selectionState: .configured,
            selectionCounts: SelectionCounts(categories: 2, applications: 5, webDomains: 1),
            restrictionEngineState: .working,
            appVersion: "1.0.0 (1)",
            osVersion: "26.5",
            policyVersionApplied: "22222222-2222-4222-8222-222222222222",
            scheduleVersionApplied: 7,
            localTime: iso("2026-10-06T09:00:00Z"),
            timezone: "Europe/London"
        )
        let object = try jsonObject(try JSONEncoder.workMode.encode(report))
        XCTAssertEqual(Set(object.keys), [
            "permissionState", "selectionState", "selectionCounts", "restrictionEngineState", "appVersion",
            "osVersion", "policyVersionApplied", "scheduleVersionApplied", "localTime", "timezone",
        ])
        XCTAssertEqual(object["localTime"] as? String, "2026-10-06T09:00:00.000Z")
        XCTAssertEqual(object["restrictionEngineState"] as? String, "WORKING")
        let counts = try XCTUnwrap(object["selectionCounts"] as? [String: Any])
        XCTAssertEqual(Set(counts.keys), ["categories", "applications", "webDomains"])

        let minimal = DeviceStateReport(permissionState: .denied, selectionState: .none, restrictionEngineState: .permissionError,
                                        appVersion: "1.0.0", osVersion: "26.5", localTime: Date(), timezone: "UTC")
        let minimalKeys = Set(try jsonObject(try JSONEncoder.workMode.encode(minimal)).keys)
        XCTAssertFalse(minimalKeys.contains("policyVersionApplied"), "nil optionals are omitted, not sent as null")
        XCTAssertFalse(minimalKeys.contains("selectionCounts"))
    }

    func testJoinRequestsAndEventsEncodeExpectedShape() throws {
        let confirm = JoinConfirmRequest(
            companyCode: "BREW-4821", employeeId: "e", firstName: "Sam", lastName: "Patel",
            device: MobileDeviceInfo(appVersion: "1.0.0", osVersion: "26.5", model: "iPhone")
        )
        let object = try jsonObject(try JSONEncoder.workMode.encode(confirm))
        XCTAssertEqual(Set(object.keys), ["companyCode", "employeeId", "firstName", "lastName", "device"])
        XCTAssertEqual(object["device"] as? [String: String], ["platform": "IOS", "appVersion": "1.0.0", "osVersion": "26.5", "model": "iPhone"])

        let lookup = try jsonObject(try JSONEncoder.workMode.encode(JoinLookupRequest(companyCode: "BREW-4821", firstName: "Sam", lastName: "Patel", inviteCode: "K7PX2M")))
        XCTAssertEqual(Set(lookup.keys), ["companyCode", "firstName", "lastName", "inviteCode"])

        let event = DeviceEvent(clientEventId: "ABCDEF00-0000-4000-8000-000000000000", type: .setupCompleted, occurredAt: iso("2026-10-06T09:00:00Z"))
        XCTAssertEqual(event.clientEventId, "abcdef00-0000-4000-8000-000000000000", "ids are lower-cased")
        let eventObject = try jsonObject(try JSONEncoder.workMode.encode(DeviceEventsRequest(events: [event])))
        let first = try XCTUnwrap((eventObject["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(first.keys), ["clientEventId", "type", "occurredAt"])
        XCTAssertEqual(first["type"] as? String, "SETUP_COMPLETED")

        let end = try jsonObject(try JSONEncoder.workMode.encode(EndBreakRequest(endedAt: iso("2026-10-06T11:10:00Z"), reason: .employeeEnded)))
        XCTAssertEqual(end["reason"] as? String, "EMPLOYEE_ENDED")
        XCTAssertEqual(PushTokenRequest.hexString(from: Data([0x0A, 0xFF, 0x01])), "0aff01")
    }

    func testCachedStateRoundTrips() throws {
        var state = CachedState(
            organisation: Organisation(id: "o", name: "Org", timezone: "Europe/London"),
            employee: Employee(id: "e", firstName: "Sam", lastName: "Patel"),
            shifts: [Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")],
            scheduleVersion: 3,
            policyVersion: "pv",
            engineState: RestrictionEngineState(state: .working, source: .appEngine, updatedAt: iso("2026-10-06T09:00:00Z")),
            outbox: [DeviceEvent(type: .policySynced, occurredAt: iso("2026-10-06T09:00:00Z"))]
        )
        state.policy = try Fixture.policy()
        let data = try JSONEncoder.workMode.encode(state)
        XCTAssertEqual(try JSONDecoder.workMode.decode(CachedState.self, from: data), state)
        XCTAssertTrue(state.isJoined)
    }

    func testPlansCodableRoundTripIncludingBreakBehaviourAndComponents() throws {
        let london = try XCTUnwrap(TimeZone(identifier: "Europe/London"))
        let plan = RestrictionPlan(shiftId: "s", policyVersion: "pv", categories: [.games], shieldMessage: nil, requiresBreakSubsetSelection: true)
        let activity = ActivityPlan(
            name: "wm.break.b",
            shiftId: "s",
            startComponents: deviceComponents(for: iso("2026-10-06T11:00:00Z"), in: london),
            endComponents: deviceComponents(for: iso("2026-10-06T11:15:00Z"), in: london),
            warningMinutes: 0,
            kind: .break,
            plannedEnd: iso("2026-10-06T11:10:00Z")
        )
        let file = PlansFile(generatedAt: iso("2026-10-06T09:00:00Z"), organisationName: "Org", entries: [
            "wm.break.b": PlanEntry(shiftId: "s", plan: plan, activity: activity, breakBehaviour: .relaxCategories(kept: [.games])),
        ])
        let decoded = try JSONDecoder.workMode.decode(PlansFile.self, from: try JSONEncoder.workMode.encode(file))
        XCTAssertEqual(decoded, file)
        XCTAssertEqual(decoded.entries["wm.break.b"]?.activity.startComponents.hour, 12)
    }
}
