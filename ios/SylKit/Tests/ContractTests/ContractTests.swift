import XCTest

// Deliberately not `@testable`: if the contract gate needs internal access to check
// the wire shape, the wire shape is not properly public and the app could not use it
// either.
import SylKit

/// The Swift half of the contract gate.
///
/// `shared/openapi.yaml` is the contract, but a spec both sides ignore is decoration.
/// A fixture both sides must decode is a gate — so the same bytes pass through the
/// TypeScript type system and this one, on every push, and a hand-written Swift model
/// that drifts fails the build rather than shipping a bug that costs a backfill
/// migration to unwind.
final class ContractTests: XCTestCase {
    func testShouldFindTheSharedFixturesFromTheTestProcess() throws {
        let directory = try FixtureLoader.fixturesDirectory()
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: directory.path),
            "the fixtures are referenced, not copied — a copied fixture is one that drifts"
        )
    }

    func testShouldListAtLeastOneFixtureInTheManifest() throws {
        XCTAssertFalse(
            try FixtureLoader.manifest().fixtures.isEmpty,
            "an empty manifest would make this whole suite pass by doing nothing"
        )
    }

    /// Every fixture, decoded into the type its manifest entry names.
    ///
    /// The file list is never hard-coded. The manifest is what stops a fixture being
    /// added and never decoded, and the TypeScript side already asserts the manifest
    /// lists every file on disk — so both sides see the same set by construction.
    func testShouldDecodeAndReEncodeEveryFixtureInTheManifest() throws {
        let manifest = try FixtureLoader.manifest()
        var failures: [String] = []

        for entry in manifest.fixtures {
            do {
                let original = try FixtureLoader.data(for: entry)
                let reEncoded = try SchemaRegistry.roundTrip(entry, data: original)
                if let difference = try JSONComparison.difference(
                    expected: original,
                    actual: reEncoded
                ) {
                    failures.append("\(entry.file) [\(entry.schema)]\n\(difference)")
                }
            } catch {
                failures.append("\(entry.file) [\(entry.schema)] threw: \(error)")
            }
        }

        XCTAssertTrue(
            failures.isEmpty,
            "\(failures.count) of \(manifest.fixtures.count) fixtures failed:\n\n"
                + failures.joined(separator: "\n\n")
        )
    }

    /// The registry is exhaustive over the manifest.
    ///
    /// Without this, adding a fixture for a schema SylKit has never modelled would
    /// simply not be checked, and the gate would report success having tested nothing
    /// about it.
    func testShouldClaimEverySchemaTheManifestNames() throws {
        let named = Set(try FixtureLoader.manifest().fixtures.map(\.schema))
        let missing = named.subtracting(SchemaRegistry.registeredSchemas).sorted()
        XCTAssertTrue(
            missing.isEmpty,
            "no SylKit type claims: \(missing.joined(separator: ", "))"
        )
    }

    /// Ids are the one field every graph edge will reference forever, so a malformed
    /// one is worth catching in the fixtures rather than in a log line six months on.
    func testShouldSeeWellFormedIdentifiersInEveryFixtureThatCarriesOne() throws {
        let manifest = try FixtureLoader.manifest()
        var malformed: [String] = []

        for entry in manifest.fixtures {
            let json = try JSONDecoder().decode(
                JSONValue.self,
                from: FixtureLoader.data(for: entry)
            )
            collectSylIdentifiers(json, path: entry.file) { path, value in
                if !SylIDs.isWellFormed(value) {
                    malformed.append("\(path): \(value)")
                }
            }
        }

        XCTAssertTrue(malformed.isEmpty, malformed.joined(separator: "\n"))
    }

    private func collectSylIdentifiers(
        _ value: JSONValue,
        path: String,
        found: (String, String) -> Void
    ) {
        switch value {
        case .string(let text) where text.hasPrefix("syl:"):
            found(path, text)
        case .array(let items):
            for (index, item) in items.enumerated() {
                collectSylIdentifiers(item, path: "\(path)[\(index)]", found: found)
            }
        case .object(let members):
            for (key, member) in members {
                collectSylIdentifiers(member, path: "\(path).\(key)", found: found)
            }
        default:
            return
        }
    }
}
