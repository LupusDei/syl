import SylKit
import UserNotifications
import XCTest

@testable import Syl

/// The app-target half of the shell: the pieces that need `UIKit`, `UserDefaults` or
/// `UserNotifications` to exist.
///
/// Kept deliberately thin — every test here costs a simulator boot. Anything about the
/// wire belongs in `SylKitTests`, where it runs in milliseconds.
final class AppShellTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "syl.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - The base URL lives in UserDefaults, not in app state

    @MainActor
    func testShouldWriteTheSelectedBaseURLThroughToUserDefaultsOnFirstLaunch() {
        // The push registration path reads UserDefaults directly and knows nothing
        // about the store. If the store did not write a value through, that path would
        // find nothing and fall back to a default — which is exactly how Adjutant came
        // to register its device token against localhost.
        _ = ServerProfileStore(defaults: defaults, fallback: .mock)

        XCTAssertEqual(
            ServerProfileStore.storedBaseURL(defaults: defaults),
            ServerProfile.mock.baseURL
        )
    }

    @MainActor
    func testShouldPersistTheSelectionSoTheRegistrationPathSeesIt() {
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)
        let tailnet = ServerProfile.tailnet(host: "syl.tail1234.ts.net")
        store.add(tailnet)

        store.select(tailnet)

        XCTAssertEqual(
            ServerProfileStore.storedBaseURL(defaults: defaults),
            tailnet.baseURL
        )
    }

    @MainActor
    func testShouldIgnoreASelectionThatIsNotAKnownProfile() {
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)

        store.select(ServerProfile.tailnet(host: "someone-elses.ts.net"))

        XCTAssertEqual(store.selected, .mock)
    }

    @MainActor
    func testShouldRestoreThePreviouslySelectedProfileOnRelaunch() {
        let first = ServerProfileStore(defaults: defaults, fallback: .mock)
        let tailnet = ServerProfile.tailnet(host: "syl.tail1234.ts.net")
        first.add(tailnet)
        first.select(tailnet)

        let second = ServerProfileStore(defaults: defaults, fallback: .mock)

        XCTAssertEqual(second.selected, tailnet)
    }

    // MARK: - The scar itself

    @MainActor
    func testShouldFollowAServerChangeWithoutBeingRebuilt() {
        // The whole point of reading UserDefaults on every access. A backend that
        // captured the URL once would keep pushing to the old server — or, on the
        // launch path where nothing had configured it yet, to localhost.
        let backend = SylBackend(defaults: defaults, tokens: InMemoryTokenStore())
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)
        XCTAssertEqual(backend.baseURL, ServerProfile.mock.baseURL)

        let tailnet = ServerProfile.tailnet(host: "syl.tail1234.ts.net")
        store.add(tailnet)
        store.select(tailnet)

        XCTAssertEqual(backend.baseURL, tailnet.baseURL)
    }

    func testShouldFallBackToAKnownURLRatherThanNothingWhenDefaultsAreEmpty() {
        let backend = SylBackend(
            defaults: defaults,
            tokens: InMemoryTokenStore(),
            fallbackBaseURL: ServerProfile.mock.baseURL
        )

        XCTAssertEqual(backend.baseURL, ServerProfile.mock.baseURL)
    }

    // MARK: - Device tokens

    func testShouldHexEncodeADeviceTokenInLowerCase() {
        // APNs hands over raw bytes; every server wants lower-case hex. Getting this
        // wrong produces BadDeviceToken and nothing else.
        let token = Data([0xa4, 0xf8, 0x1c, 0x02, 0x00, 0x0f])

        XCTAssertEqual(PushRegistration.hexEncode(token), "a4f81c02000f")
    }

    func testShouldHexEncodeAnEmptyTokenToAnEmptyString() {
        XCTAssertEqual(PushRegistration.hexEncode(Data()), "")
    }

    func testShouldDeriveTheAPNsEnvironmentFromTheBuildConfiguration() {
        // A TestFlight build always produces production tokens; an Xcode-installed
        // build always produces sandbox ones. Both exist during development, so the
        // environment travels with the token rather than being a global setting.
        #if DEBUG
            XCTAssertEqual(PushRegistration.environment, .sandbox)
        #else
            XCTAssertEqual(PushRegistration.environment, .production)
        #endif
    }

    func testShouldBuildARegistrationRequestCarryingTheEnvironment() {
        let request = PushRegistration.request(
            token: Data([0x9c, 0x0d, 0x2e, 0x41]),
            name: "Commander's iPhone",
            appVersion: "0.1.0 (14)",
            osVersion: "26.1",
            environment: .production
        )

        XCTAssertEqual(request.token, "9c0d2e41")
        XCTAssertEqual(request.environment, .production)
        XCTAssertEqual(request.platform, .ios)
    }

    func testShouldReuseTheSameIdempotencyKeyForTheSameTokenSoRelaunchesDoNotAccumulate() {
        // Re-registering on every launch is correct — a token can be reissued after a
        // restore — but it must replay one stored response rather than write a row per
        // launch.
        let request = PushRegistration.request(
            token: Data([0x9c, 0x0d, 0x2e, 0x41]),
            name: "iPhone", appVersion: "0.1.0 (14)", osVersion: "26.1",
            environment: .production
        )

        XCTAssertEqual(
            PushRegistrationService.idempotencyKey(for: request),
            PushRegistrationService.idempotencyKey(for: request)
        )
    }

    func testShouldUseADifferentIdempotencyKeyForADifferentEnvironment() {
        let sandbox = PushRegistration.request(
            token: Data([0x9c, 0x0d, 0x2e, 0x41]),
            name: "iPhone", appVersion: "0.1.0 (14)", osVersion: "26.1", environment: .sandbox
        )
        let production = PushRegistration.request(
            token: Data([0x9c, 0x0d, 0x2e, 0x41]),
            name: "iPhone", appVersion: "0.1.0 (14)", osVersion: "26.1", environment: .production
        )

        XCTAssertNotEqual(
            PushRegistrationService.idempotencyKey(for: sandbox),
            PushRegistrationService.idempotencyKey(for: production)
        )
    }

    func testShouldReportBothTheMarketingVersionAndTheBuildNumber() {
        // A TestFlight report that says only "0.1.0" cannot be matched to a build.
        let version = PushRegistration.appVersion()

        XCTAssertTrue(version.contains("("), version)
        XCTAssertTrue(version.hasSuffix(")"), version)
    }

    // MARK: - Notification payloads

    func testShouldReadTheDeliveryAndReminderIdsOutOfAPush() {
        let payload = NotificationPayload(userInfo: [
            "deliveryId": "syl:delivery:0198f2c6-0001-7000-8000-000000010001",
            "reminderId": "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
        ])

        XCTAssertEqual(payload.deliveryId, "syl:delivery:0198f2c6-0001-7000-8000-000000010001")
        XCTAssertEqual(payload.reminderId, "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f")
    }

    func testShouldTolerateAPushItCannotFullyParse() {
        // A notification whose payload is unreadable has still been seen by the
        // Commander. Crashing on the way to telling him so is the worst response.
        let payload = NotificationPayload(userInfo: ["deliveryId": 42, "unexpected": true])

        XCTAssertNil(payload.deliveryId)
        XCTAssertNil(payload.reminderId)
        XCTAssertTrue(payload.isEmpty)
    }

    func testShouldTreatAnEmptyStringIdAsAbsent() {
        let payload = NotificationPayload(userInfo: ["reminderId": ""])

        XCTAssertNil(payload.reminderId)
    }

    // MARK: - Actions

    @MainActor
    func testShouldMapEachActionOntoTheEngagementItReports() {
        XCTAssertEqual(
            NotificationService.work(for: ReminderNotification.Action.snooze.rawValue).action,
            .snooze
        )
        XCTAssertEqual(
            NotificationService.work(for: ReminderNotification.Action.snooze.rawValue).engagement,
            .actedOn
        )
        XCTAssertEqual(
            NotificationService.work(for: ReminderNotification.Action.view.rawValue).engagement,
            .opened
        )
    }

    @MainActor
    func testShouldTreatATapAsOpenedAndASwipeAwayAsDismissed() {
        // Both feed the interruption ledger, and they are not the same signal: a
        // message class that is consistently dismissed gets demoted.
        XCTAssertEqual(
            NotificationService.work(for: UNNotificationDefaultActionIdentifier).engagement,
            .opened
        )
        XCTAssertEqual(
            NotificationService.work(for: UNNotificationDismissActionIdentifier).engagement,
            .dismissed
        )
    }

    @MainActor
    func testShouldFallBackToDeliveredForAnActionItDoesNotRecognise() {
        let work = NotificationService.work(for: "syl.reminder.teleport")

        XCTAssertNil(work.action)
        XCTAssertEqual(work.engagement, .delivered)
    }

    func testShouldOnlyOpenTheAppForTheViewAction() {
        // A snooze that had to launch the app to take effect would be a snooze he
        // could miss.
        XCTAssertEqual(ReminderNotification.Action.allCases.count, 3)
        XCTAssertEqual(ReminderNotification.snoozeMinutes, 15)
    }

    // MARK: - Token storage

    func testShouldRoundTripATokenThroughTheInMemoryStore() {
        let store = InMemoryTokenStore()

        store.write("syl_pat_abc")

        XCTAssertEqual(store.read(), "syl_pat_abc")
    }

    func testShouldForgetTheTokenWhenCleared() {
        let store = InMemoryTokenStore(token: "syl_pat_abc")

        store.clear()

        XCTAssertNil(store.read())
    }

    func testShouldHandTheStoredTokenToSylKit() async {
        let provider = TokenStoreProvider(store: InMemoryTokenStore(token: "syl_pat_abc"))

        let token = await provider.token()

        XCTAssertEqual(token, "syl_pat_abc")
    }
}
