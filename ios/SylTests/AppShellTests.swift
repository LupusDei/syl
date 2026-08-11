import SylKit
import UserNotifications
import SwiftUI
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
    func testShouldPersistTheSelectionSoTheRegistrationPathSeesIt() throws {
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)
        let tailnet = try XCTUnwrap(ServerProfile.tailnet(host: "syl.tail1234.ts.net"))
        store.add(tailnet)

        store.select(tailnet)

        XCTAssertEqual(
            ServerProfileStore.storedBaseURL(defaults: defaults),
            tailnet.baseURL
        )
    }

    @MainActor
    func testShouldIgnoreASelectionThatIsNotAKnownProfile() throws {
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)

        store.select(try XCTUnwrap(ServerProfile.tailnet(host: "someone-elses.ts.net")))

        XCTAssertEqual(store.selected, .mock)
    }

    @MainActor
    func testShouldRestoreThePreviouslySelectedProfileOnRelaunch() throws {
        let first = ServerProfileStore(defaults: defaults, fallback: .mock)
        let tailnet = try XCTUnwrap(ServerProfile.tailnet(host: "syl.tail1234.ts.net"))
        first.add(tailnet)
        first.select(tailnet)

        let second = ServerProfileStore(defaults: defaults, fallback: .mock)

        XCTAssertEqual(second.selected, tailnet)
    }

    // MARK: - The scar itself

    @MainActor
    func testShouldFollowAServerChangeWithoutBeingRebuilt() throws {
        // The whole point of reading UserDefaults on every access. A backend that
        // captured the URL once would keep pushing to the old server — or, on the
        // launch path where nothing had configured it yet, to localhost.
        let backend = SylBackend(defaults: defaults, tokens: InMemoryTokenStore())
        let store = ServerProfileStore(defaults: defaults, fallback: .mock)
        XCTAssertEqual(backend.baseURL, ServerProfile.mock.baseURL)

        let tailnet = try XCTUnwrap(ServerProfile.tailnet(host: "syl.tail1234.ts.net"))
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

    func testShouldRefuseAHostThatCannotBeAURL() {
        // The host is typed in. A stray space would otherwise trap the app on a
        // settings screen.
        XCTAssertNil(ServerProfile.tailnet(host: "not a host"))
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

    // MARK: - Recovering a delivery push never showed

    func testShouldRecogniseHeldNotificationsByPayloadRatherThanByIdentifier() {
        // A push carries the identifier APNs assigned it, so the only thing tying a
        // banner in Notification Center back to an outbox row is the `deliveryId` in
        // its payload. Matching on the identifier would find nothing and the reconcile
        // would show him a second copy of everything he can already see.
        let held = Self.request(
            identifier: "8A5B1C22-APNS-ASSIGNED",
            userInfo: ["deliveryId": "syl:delivery:0198F2C3-0001-7000-8000-00000000D001"]
        )
        let unrelated = Self.request(identifier: "syl.something.else", userInfo: [:])

        let found = NotificationService.deliveryIds(in: [held, unrelated])

        // Canonical-cased: the contract permits either hex case and the service emits
        // lower, so two ids for one resource must not compare unequal as bare strings.
        XCTAssertEqual(found, ["syl:delivery:0198f2c3-0001-7000-8000-00000000d001"])
    }

    func testShouldCarryTheIdsARecoveredNotificationNeedsToStayActionable() {
        // A recovered reminder he cannot snooze or complete is half a recovery, and
        // both actions are addressed by these two ids.
        let info = NotificationService.userInfo(for: Self.delivery(reminderId: "syl:reminder:1"))

        XCTAssertEqual(info["deliveryId"], "syl:delivery:1")
        XCTAssertEqual(info["reminderId"], "syl:reminder:1")
        XCTAssertEqual(NotificationPayload(userInfo: info).reminderId, "syl:reminder:1")
    }

    func testShouldOmitTheReminderIdWhenADeliveryStandsForNoSingleReminder() {
        // A coalesced digest stands for several reminders and names none of them.
        let info = NotificationService.userInfo(for: Self.delivery(reminderId: nil))

        XCTAssertNil(info["reminderId"])
        XCTAssertEqual(info["deliveryId"], "syl:delivery:1")
    }

    func testShouldPreserveTheInterruptionLevelWhenRecoveringADelivery() {
        // A time-sensitive reminder that comes back as passive is a reminder that
        // waits behind Focus for the rest of the day.
        XCTAssertEqual(NotificationService.level(of: .timeSensitive), .timeSensitive)
        XCTAssertEqual(NotificationService.level(of: .active), .active)
        XCTAssertEqual(NotificationService.level(of: .passive), .passive)
    }

    private static func request(
        identifier: String,
        userInfo: [String: String]
    ) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.userInfo = userInfo
        return UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    }

    private static func delivery(reminderId: SylID?) -> Delivery {
        Delivery(
            id: "syl:delivery:1",
            channel: .apns,
            messageClass: "reminder_delivery",
            reminderId: reminderId,
            payload: DeliveryPayload(title: "Syl", body: "Take the medication."),
            idempotencyKey: "k",
            state: .delivered,
            attempts: 1,
            nextAttemptAt: nil,
            deliveredAt: nil,
            ackedAt: nil,
            engagement: nil,
            late: false,
            scheduledFor: nil,
            coalescedReminderIds: [],
            apnsUniqueId: nil,
            lastError: nil,
            createdAt: Date(timeIntervalSince1970: 1_786_000_000)
        )
    }

    @MainActor
    func testShouldOnlyOpenTheAppForTheViewAction() throws {
        // A snooze that had to launch the app to take effect would be a snooze he could
        // miss. Asserted on the actions actually registered with the system, not on a
        // count — a count passes unchanged if every action gains `.foreground`, which
        // is the exact mistake the rule exists to prevent.
        let center = UNUserNotificationCenter.current()
        NotificationService(backend: SylBackend(defaults: defaults, tokens: InMemoryTokenStore()))
            .registerCategories()

        let categories = try awaitCategories(from: center)
        let reminder = try XCTUnwrap(
            categories.first { $0.identifier == ReminderNotification.categoryIdentifier }
        )

        XCTAssertEqual(reminder.actions.count, 3)
        for action in reminder.actions {
            let opensApp = action.options.contains(.foreground)
            XCTAssertEqual(
                opensApp,
                action.identifier == ReminderNotification.Action.view.rawValue,
                "\(action.identifier) has the wrong foreground option"
            )
        }
    }

    private func awaitCategories(
        from center: UNUserNotificationCenter
    ) throws -> Set<UNNotificationCategory> {
        let expectation = expectation(description: "categories")
        nonisolated(unsafe) var result: Set<UNNotificationCategory> = []
        center.getNotificationCategories { categories in
            result = categories
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)
        return result
    }

    func testShouldDeferByFifteenMinutes() {
        XCTAssertEqual(ReminderNotification.snoozeMinutes, 15)
    }

    @MainActor
    func testShouldDeriveANotificationActionKeyFromTheReminderAndDelivery() {
        // Never random. He tapped Snooze on this notification once; a fresh key on a
        // retry would ask the server to defer a second time.
        let first = NotificationService.actionKey(
            "snooze", "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f", "syl:delivery:abc")
        let second = NotificationService.actionKey(
            "snooze", "syl:reminder:0198F2C1-4A3B-7D21-9F00-1A2B3C4D5E6F", "syl:delivery:ABC")

        XCTAssertEqual(first, second, "id case must not change the key")
        XCTAssertNotEqual(
            first,
            NotificationService.actionKey(
                "complete", "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f", "syl:delivery:abc")
        )
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

/// The doors on the home screen, and whether they open.
///
/// Written after the Commander reported that Goals showed a list he could not open, and
/// that Memory and Today did nothing at all. Two different defects wearing one symptom.
final class HomeDoorTests: XCTestCase {

    /// The one that actually broke navigation.
    ///
    /// `HomeScreen` held its stack as `[HomeView.Destination]`. A homogeneous typed path
    /// can only ever carry the type it is declared with, so every
    /// `NavigationLink(value: GoalRoute(…))` inside the goals screens was inert — SwiftUI
    /// had nowhere to put the value and the tap did nothing. The list rendered perfectly,
    /// which is exactly what made it look finished.
    ///
    /// This asserts the property that failed: the path a goal route is appended to must
    /// accept a goal route. A typed array of destinations cannot, and would not compile
    /// against this test.
    func testShouldCarryAGoalRouteOnTheSamePathAsAnOrbDestination() {
        var path = NavigationPath()

        path.append(HomeView.Destination.goals)
        path.append(GoalRoute(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001"))

        XCTAssertEqual(path.count, 2, "one path has to carry the orb's push and the screen's own")
    }

    /// Memory is `syl-010` and is not built. An orb identical to its neighbours that does
    /// nothing is the report we got; an unready one refuses the touch and says so.
    @MainActor
    func testShouldRefuseTheTouchOnAnOrbThatLeadsNowhere() {
        var tapped = false
        let orb = SylOrb(title: "Memory", symbol: "cloud", isReady: false) { tapped = true }

        XCTAssertFalse(orb.isReady)
        XCTAssertFalse(tapped, "an unready orb must not pretend to have acted")
    }

    @MainActor
    func testShouldLeaveAReadyOrbFullyInteractive() {
        let orb = SylOrb(title: "Goals", symbol: "sparkle") {}

        XCTAssertTrue(orb.isReady, "ready is the default; only a door that is a wall opts out")
    }
}
