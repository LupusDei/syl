// swift-tools-version: 6.0

import PackageDescription

// SylKit has ZERO external dependencies, and that is a structural rule, not an
// accident of it being early. The wire layer must stay testable with `swift test`
// on the host — no simulator, no app target, no third-party build graph. It is the
// same instinct as the backend rule that the protocol codec stays pure: wire-format
// bugs are where the subtle failures live, and they are only cheap to find when the
// thing that parses the wire can be exercised in milliseconds.
//
// `dependencies:` stays empty. If something seems to need adding here, that is a
// design conversation, not a commit.
let package = Package(
    name: "SylKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "SylKit",
            targets: ["SylKit"]
        )
    ],
    targets: [
        .target(
            name: "SylKit",
            path: "Sources/SylKit"
        ),
        .testTarget(
            name: "SylKitTests",
            dependencies: ["SylKit"],
            path: "Tests/SylKitTests"
        ),
        // The Swift half of the contract gate. Separate from SylKitTests because it
        // asserts something different in kind: not that the client behaves, but that
        // the hand-written models still agree with `shared/fixtures`, which is the
        // failure that actually bit Adjutant. It uses no `@testable` import — if the
        // gate needed internal access, the wire shape would not be usable by the app.
        .testTarget(
            name: "ContractTests",
            dependencies: ["SylKit"],
            path: "Tests/ContractTests"
        )
    ]
)
