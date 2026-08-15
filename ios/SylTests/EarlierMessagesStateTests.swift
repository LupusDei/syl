import SwiftUI
import XCTest

@testable import Syl

/// The four states of the head of the transcript (`syl-025.4.4`).
///
/// ## Why these are unit tests and not snapshot renders
///
/// Everything worth pinning here is a pure function — which states a tap does something
/// in, what VoiceOver says, and whether a load has earned the right to say it is
/// loading. `EarlierMessages` reads those from the same computed properties these tests
/// drive, so there is no second copy of the rule to drift.
///
/// A snapshot render would assert pixels, and pixels move for reasons that have nothing
/// to do with this contract — a tracking value, a hairline weight, a font metric on a new
/// OS. It would go red for the wrong reasons and, worse, could stay green through a
/// change that made `beginning` and `unreachable` indistinguishable to a screen reader,
/// because a screen reader does not read pixels. The visual half is carried by the
/// existing `ChatSnapshotRendering` pass over the whole transcript.
///
/// **Every state-by-state assertion runs over `allCases`**, so a fifth state added later
/// fails these rather than quietly going untested.
final class EarlierMessagesStateTests: XCTestCase {

    // MARK: - What a tap does

    func testShouldOfferATapExactlyInTheTwoStatesWhereOneDoesSomething() {
        for state in EarlierMessagesState.allCases {
            switch state {
            case .idle, .unreachable:
                XCTAssertTrue(state.isActionable, "\(state) is a way forward and must be tappable")
            case .loading, .beginning:
                XCTAssertFalse(
                    state.isActionable,
                    "\(state) has nothing to ask for; a tap must not start a second load"
                )
            }
        }
    }

    func testShouldRefuseATapWhileALoadIsInFlightEvenBeforeItLooksLikeOne() {
        // The anti-flash delay leaves the control still READING "Earlier messages" for
        // the first fraction of a second of a load. If actionability followed the
        // appearance rather than the state, that window would let him start a second
        // load — buying a smoother control at the price of a correctness bug.
        XCTAssertEqual(
            EarlierMessagesState.loading.appearance(loadingIsVisible: false),
            .ask,
            "it still looks idle"
        )
        XCTAssertFalse(EarlierMessagesState.loading.isActionable, "and it is still not tappable")
    }

    // MARK: - The two states that look terminal and mean opposite things

    func testShouldNeverGiveTwoStatesTheSameSpokenLabel() {
        // The whole risk of this control: `beginning` means there is nothing more,
        // `unreachable` means there is more and we cannot reach it. A reader who cannot
        // tell them apart either stops at a network error believing they have read
        // everything, or keeps trying at the true start of their own history. Two states
        // sharing a label is that failure, in the modality where it is easiest to ship.
        let labels = EarlierMessagesState.allCases.map(\.accessibilityLabel)

        XCTAssertEqual(
            Set(labels).count,
            EarlierMessagesState.allCases.count,
            "every state says something different"
        )
        for label in labels {
            XCTAssertFalse(label.isEmpty, "and none of them says nothing")
        }
    }

    func testShouldSpeakTheBeginningAsAnArrivalRatherThanAsAFailure() {
        // This is the top of everything he and Syl have ever said to each other. It has
        // to sound like reaching it, not like being refused.
        let spoken = EarlierMessagesState.beginning.accessibilityLabel.lowercased()

        XCTAssertTrue(spoken.contains("beginning"), "it names what he has reached")
        for refusal in ["error", "failed", "unavailable", "cannot", "can't", "no more", "try again"]
        {
            XCTAssertFalse(
                spoken.contains(refusal),
                "the beginning of his own history must not be announced with \(refusal)"
            )
        }
    }

    func testShouldTellHimHowToRecoverWhenHistoryIsMerelyOutOfReach() {
        let spoken = EarlierMessagesState.unreachable.accessibilityLabel.lowercased()

        XCTAssertTrue(spoken.contains("again"), "a retryable state has to say it is retryable")
        XCTAssertFalse(
            spoken.contains("beginning"),
            "and it must never suggest he has reached the start"
        )
    }

    // MARK: - The loading appearance, and why it waits

    func testShouldNotSayItIsLoadingUntilTheLoadHasLastedLongEnoughToNotice() {
        // A local page resolves in milliseconds. Changing the wording and changing it
        // back inside a frame or two is a flicker at the top of the transcript, which
        // reads as a glitch rather than as progress — so below the threshold the control
        // simply never changes.
        XCTAssertEqual(EarlierMessagesState.loading.appearance(loadingIsVisible: false), .ask)
        XCTAssertEqual(EarlierMessagesState.loading.appearance(loadingIsVisible: true), .working)
    }

    func testShouldLeaveEveryOtherStateUnmovedByTheLoadingDelay() {
        // The flag exists for exactly one state. If it reached any other, a slow network
        // could change what the beginning of a conversation looks like.
        for state in EarlierMessagesState.allCases where state != .loading {
            XCTAssertEqual(
                state.appearance(loadingIsVisible: false),
                state.appearance(loadingIsVisible: true),
                "\(state) does not depend on how long anything has been loading"
            )
        }
    }

    // `EarlierMessages` is a `View` and therefore main-actor isolated; the two tests that
    // reach the type itself rather than the state say so. The rest drive pure values and
    // need no actor at all, which is most of why they are pure.
    @MainActor
    func testShouldWaitLongEnoughToSuppressAFlickerAndShortEnoughToStayHonest() {
        // Both bounds matter. Zero would put the flicker back; a long delay would leave a
        // real wait unnarrated, which is its own kind of lie.
        XCTAssertGreaterThan(EarlierMessages.loadingAppearsAfter, .zero)
        XCTAssertLessThanOrEqual(
            EarlierMessages.loadingAppearsAfter,
            .milliseconds(400),
            "past this a genuine wait is going unacknowledged"
        )
    }

    // MARK: - The drawing

    func testShouldDrawTheBeginningAsAnEndingAndNeverAsAControl() {
        // Not a disabled button and not a spinner. A greyed-out control says the same
        // thing in the language of a refusal, and a spinner that never resolves is the
        // single most likely way this feature reads as broken while working perfectly.
        XCTAssertEqual(EarlierMessagesState.beginning.appearance(loadingIsVisible: false), .ending)
        XCTAssertFalse(EarlierMessagesState.beginning.isActionable)
    }

    func testShouldGiveEachStateItsOwnDrawingSoNoneIsMistakenForAnother() {
        let drawn = EarlierMessagesState.allCases.map { $0.appearance(loadingIsVisible: true) }

        XCTAssertEqual(
            Set(drawn).count,
            EarlierMessagesState.allCases.count,
            "four states, four appearances — once a load is visible, nothing overlaps"
        )
    }

    // MARK: - The seam Track A still compiles against

    @MainActor
    func testShouldKeepTheBooleanInitialiserWorkingUntilTheCallSiteMoves() {
        // `ChatView` still constructs this with a bare `isLoading`, and that file belongs
        // to another track. The compatibility initialiser can only reach two of the four
        // states — which is the whole reason the state type exists, since `beginning` and
        // `unreachable` are not expressible as a Bool.
        XCTAssertEqual(EarlierMessages(isLoading: true, action: {}).state, .loading)
        XCTAssertEqual(EarlierMessages(isLoading: false, action: {}).state, .idle)
    }
}
