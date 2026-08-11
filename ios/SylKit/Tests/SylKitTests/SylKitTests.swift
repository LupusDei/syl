import XCTest
@testable import SylKit

final class SylKitTests: XCTestCase {
    /// `version` is what the client will report to the service when the wire shape
    /// changes, so a malformed one is a bug that only shows up in a compatibility
    /// check nobody runs until it matters.
    func testShouldExposeASemanticWireVersion() {
        let parts = SylKit.version.split(separator: ".")
        XCTAssertEqual(parts.count, 3, "expected major.minor.patch, got \(SylKit.version)")
        XCTAssertTrue(parts.allSatisfy { Int($0) != nil }, "every component should be numeric")
    }
}
