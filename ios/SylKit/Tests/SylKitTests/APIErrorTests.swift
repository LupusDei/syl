import XCTest

@testable import SylKit

final class APIErrorTests: XCTestCase {
    // MARK: - Retryability

    func testShouldTreatATunnelStillComingUpAsRetryable() {
        XCTAssertTrue(APIError.transport(code: .cannotConnectToHost, description: "").isRetryable)
        XCTAssertTrue(APIError.transport(code: .networkConnectionLost, description: "").isRetryable)
        XCTAssertTrue(APIError.transport(code: .timedOut, description: "").isRetryable)
    }

    func testShouldNotRetryATransportFailureThatIsAProgrammingError() {
        // A bad URL will be just as bad in 500 milliseconds. Retrying it three times
        // only delays finding out.
        XCTAssertFalse(APIError.transport(code: .badURL, description: "").isRetryable)
        XCTAssertFalse(
            APIError.transport(code: .unsupportedURL, description: "").isRetryable
        )
    }

    func testShouldFollowTheServersOwnJudgementOnRetryability() {
        let retryable = APIError.api(
            ApiError(code: .upstreamUnavailable, message: "", retryable: true),
            status: 503
        )
        let notRetryable = APIError.api(
            ApiError(code: .validationFailed, message: "", retryable: false),
            status: 422
        )

        XCTAssertTrue(retryable.isRetryable)
        XCTAssertFalse(notRetryable.isRetryable)
    }

    func testShouldRetryAServerErrorEvenIfItForgotToSaySo() {
        let error = APIError.api(
            ApiError(code: .internalError, message: "", retryable: false),
            status: 500
        )

        XCTAssertTrue(error.isRetryable, "a 5xx with no opinion is still a 5xx")
    }

    func testShouldTreatABodyThatIsNotSylAsATransportProblem() {
        // A captive portal or a Tailscale error page is not an API error; it means the
        // request never reached Syl, and that is worth another attempt.
        let error = APIError.malformedResponse(status: 200, preview: "<html>Sign in to WiFi</html>")

        XCTAssertTrue(error.isRetryable)
    }

    func testShouldNeverRetryADecodingFailure() {
        // The same bytes will fail the same way, and a contract mismatch should be
        // loud rather than repeated.
        XCTAssertFalse(APIError.decoding("keyNotFound(todoId)").isRetryable)
    }

    // MARK: - Did it land?

    func testShouldKnowARequestNeverLeftWhenTheConnectionWasNeverMade() {
        // The outbox needs this because Idempotency-Key is specified everywhere but
        // honoured only for message sends today: retrying a snooze that may have
        // landed would defer the reminder twice.
        XCTAssertFalse(
            APIError.transport(code: .cannotConnectToHost, description: "").mayHaveReachedTheServer
        )
        XCTAssertFalse(
            APIError.transport(code: .notConnectedToInternet, description: "").mayHaveReachedTheServer
        )
    }

    func testShouldAdmitItCannotTellAfterATimeout() {
        // The request may have been received and the answer lost.
        XCTAssertTrue(
            APIError.transport(code: .timedOut, description: "").mayHaveReachedTheServer
        )
        XCTAssertTrue(
            APIError.transport(code: .networkConnectionLost, description: "").mayHaveReachedTheServer
        )
    }

    func testShouldTreatAnyAnsweredRequestAsHavingReachedTheServer() {
        XCTAssertTrue(
            APIError.api(ApiError(code: .internalError, message: "", retryable: true), status: 500)
                .mayHaveReachedTheServer
        )
        XCTAssertTrue(
            APIError.malformedResponse(status: 502, preview: "<html>").mayHaveReachedTheServer
        )
    }

    // MARK: - Backoff floor

    func testShouldSurfaceTheServerSuggestedBackoffFloor() {
        let error = APIError.api(
            ApiError(code: .rateLimited, message: "", retryable: true, retryAfterMs: 2000),
            status: 429
        )

        XCTAssertEqual(error.retryAfter, 2)
    }

    func testShouldHaveNoBackoffFloorWhenTheServerOffersNone() {
        XCTAssertNil(APIError.transport(code: .timedOut, description: "").retryAfter)
    }

    // MARK: - Re-pairing

    func testShouldAskForReauthenticationOnAnAuthFailureOnly() {
        let unauthorized = APIError.api(
            ApiError(code: .unauthorized, message: "", retryable: false), status: 401)
        let notFound = APIError.api(
            ApiError(code: .notFound, message: "", retryable: false), status: 404)

        XCTAssertTrue(unauthorized.requiresReauthentication)
        XCTAssertFalse(notFound.requiresReauthentication)
    }

    // MARK: - Mapping from URLSession

    func testShouldMapACancelledURLErrorToItsOwnCaseRatherThanATransportFailure() {
        // Otherwise a deliberately cancelled request gets retried three times on its
        // way out.
        XCTAssertEqual(APIError.from(URLError(.cancelled)), .cancelled)
    }

    func testShouldMapAnyOtherURLErrorToTransport() {
        let mapped = APIError.from(URLError(.timedOut))

        guard case .transport(let code, _) = mapped else {
            return XCTFail("expected a transport failure, got \(mapped)")
        }
        XCTAssertEqual(code, .timedOut)
    }

    // MARK: - What the Commander sees

    func testShouldDescribeAMalformedResponseAsSomethingOtherThanSylAnswering() {
        let error = APIError.malformedResponse(status: 502, preview: "<html>Bad Gateway</html>")

        let description = try? XCTUnwrap(error.errorDescription)
        XCTAssertEqual(description?.contains("instead of Syl") , true)
    }

    func testShouldUseTheServersOwnMessageWhenSylAnswered() {
        let error = APIError.api(
            ApiError(
                code: .deferralNotLater,
                message: "That snooze resolves to an instant that is not after the current fire time.",
                retryable: false
            ),
            status: 422
        )

        XCTAssertEqual(
            error.errorDescription,
            "That snooze resolves to an instant that is not after the current fire time."
        )
    }
}
