import XCTest
import SylKit
@testable import Syl

/// The app target's test target exists mainly so the next agent has somewhere to put
/// app-level tests without first building infrastructure. What it asserts today is
/// the wiring — the things a pbxproj can claim and fail to deliver.
///
/// Networking tests belong in `SylKitTests`, next to `MockURLProtocol`. They run in
/// milliseconds there and need a booted simulator here.
final class SylKitLinkageTests: XCTestCase {
    func testShouldExposeSylKitToTheAppTarget() {
        XCTAssertFalse(SylKit.version.isEmpty)
    }

    /// The bundle id is not cosmetic: APNs device tokens are issued per bundle id, and
    /// a mismatch between what the app registers under and what the service pushes to
    /// produces `BadDeviceToken` with no other symptom. Pin it here so a careless
    /// build-setting edit fails a test instead of failing silently in production.
    func testShouldRunUnderTheAgreedBundleIdentifier() {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.jmm.syl")
    }

    /// Fails if constructing the root view traps.
    @MainActor
    func testShouldConstructTheRootViewWithoutTrapping() {
        _ = ContentView().body
    }
}
