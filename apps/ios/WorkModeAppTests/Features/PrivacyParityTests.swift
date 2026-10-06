import XCTest
@testable import WorkModeApp

/// The Settings › Privacy screen is a static Swift mirror of `packages/shared/src/privacyStatements.ts`. When the
/// repository is available (local runs), the two key lists must match exactly.
final class PrivacyParityTests: XCTestCase {
    func testSwiftPrivacyKeysMatchTheSharedTypeScriptSource() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        // apps/ios/WorkModeAppTests/Features/PrivacyParityTests.swift → repository root is five levels up.
        let root = (0..<5).reduce(testFile) { url, _ in url.deletingLastPathComponent() }
        let source = root.appendingPathComponent("packages/shared/src/privacyStatements.ts")
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw XCTSkip("packages/shared/src/privacyStatements.ts is not available on this machine")
        }
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertEqual(keys(in: text, array: "CAN_SEE"), PrivacyStatements.canSee.map(\.id))
        XCTAssertEqual(keys(in: text, array: "CANNOT_SEE"), PrivacyStatements.cannotSee.map(\.id))
        XCTAssertTrue(text.contains("PRIVACY_PRINCIPLE = \"\(PrivacyStatements.principle)\""), "the principle line must match word for word")
    }

    func testStatementsHaveUniqueIdsAndCopy() {
        let all = PrivacyStatements.canSee + PrivacyStatements.cannotSee
        XCTAssertEqual(Set(all.map(\.id)).count, all.count)
        for statement in all {
            XCTAssertFalse(statement.label.isEmpty, statement.id)
            XCTAssertFalse(statement.detail.isEmpty, statement.id)
        }
    }

    private func keys(in text: String, array: String) -> [String] {
        guard let start = text.range(of: "export const \(array) = ["),
              let end = text.range(of: "] as const", range: start.upperBound..<text.endIndex) else { return [] }
        let block = String(text[start.upperBound..<end.lowerBound])
        let regex = try! NSRegularExpression(pattern: #"key:\s*"([A-Za-z]+)""#)
        return regex.matches(in: block, range: NSRange(block.startIndex..., in: block)).compactMap { match in
            Range(match.range(at: 1), in: block).map { String(block[$0]) }
        }
    }
}
