import XCTest
@testable import WorkModeCore

final class CompanyCodeTests: XCTestCase {
    func testNormaliseAcceptsCommonTypings() {
        for input in ["brew4821", "brew 4821", "BREW-4821", "brew_4821", "brew--4821", "  Brew.4821 ", "b r e w 4 8 2 1"] {
            XCTAssertEqual(CompanyCode.normalise(input), "BREW-4821", input)
        }
        XCTAssertEqual(CompanyCode.normalise("amber1234"), "AMBER-1234")
    }

    func testNormaliseIsTotalForInvalidInput() {
        XCTAssertEqual(CompanyCode.normalise("brew48"), "BREW48")
        XCTAssertEqual(CompanyCode.normalise("4821-brew"), "4821BREW")
        XCTAssertEqual(CompanyCode.normalise(""), "")
    }

    func testIsValidMatchesServerSchema() {
        XCTAssertTrue(CompanyCode.isValid("BREW-4821"))
        XCTAssertTrue(CompanyCode.isValid("ABC-0000"), "the API accepts 3–8 letters")
        XCTAssertTrue(CompanyCode.isValid("ABCDEFGH-9999"))
        XCTAssertFalse(CompanyCode.isValid("AB-1234"))
        XCTAssertFalse(CompanyCode.isValid("ABCDEFGHI-1234"))
        XCTAssertFalse(CompanyCode.isValid("brew-4821"), "must be normalised first")
        XCTAssertFalse(CompanyCode.isValid("BREW-482"))
        XCTAssertFalse(CompanyCode.isValid("BREW4821"))
        XCTAssertFalse(CompanyCode.isValid("BRÉW-4821"))
    }

    func testFormatAsTypedBuildsTheMaskIncrementally() {
        let typed = "brew4821"
        var field = ""
        var snapshots: [String] = []
        for character in typed {
            field = CompanyCode.formatAsTyped(field + String(character))
            snapshots.append(field)
        }
        XCTAssertEqual(snapshots, ["B", "BR", "BRE", "BREW", "BREW-4", "BREW-48", "BREW-482", "BREW-4821"])
    }

    func testFormatAsTypedDropsInvalidCharactersAndCapsLength() {
        XCTAssertEqual(CompanyCode.formatAsTyped("BREW-48219"), "BREW-4821")
        XCTAssertEqual(CompanyCode.formatAsTyped("br3"), "BR", "digits only after the minimum letters")
        XCTAssertEqual(CompanyCode.formatAsTyped("brew 48a21"), "BREW-4821", "letters after digits are dropped")
        XCTAssertEqual(CompanyCode.formatAsTyped("abcdefghij"), "ABCDEFGH")
        XCTAssertEqual(CompanyCode.formatAsTyped("brew-"), "BREW", "a typed hyphen is re-inserted only with digits")
        XCTAssertEqual(CompanyCode.formatAsTyped("BREW-4"), "BREW-4", "deleting back over the hyphen works")
        XCTAssertEqual(CompanyCode.formatAsTyped("🙂brew"), "BREW")
    }

    func testEmployeeCodeNormalisation() {
        XCTAssertEqual(EmployeeCode.normalise(" k7p-x2m "), "K7PX2M")
        XCTAssertTrue(EmployeeCode.isValid("K7PX2M"))
        XCTAssertFalse(EmployeeCode.isValid("K7P"))
        XCTAssertFalse(EmployeeCode.isValid(String(repeating: "A", count: 17)))
        XCTAssertFalse(EmployeeCode.isValid("k7px2m"))
    }
}
