/// SylKit is the client-side wire layer for the Syl iOS app: the models, the API
/// client and the WebSocket client that talk to the Syl service.
///
/// It has **zero external dependencies**, deliberately and permanently. Everything
/// here builds and tests with `swift test` on the host machine, with no simulator
/// and no app target, which is what makes it cheap to be exact about the wire format.
/// The backend keeps its protocol codec pure for the same reason.
///
/// The types themselves land with `syl-003.1.2` and after, once the API contract in
/// `shared/` is settled — models written ahead of the contract are guesses that later
/// have to be unwound.
public enum SylKit {
    /// The wire-compatibility version of this client. Bumped when the shape SylKit
    /// speaks changes, not when the app ships.
    public static let version = "0.1.0"
}
