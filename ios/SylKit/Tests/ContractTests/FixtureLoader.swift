import Foundation

/// Locates `shared/fixtures/` from the test process.
///
/// The fixtures are **referenced, not copied**. A copied fixture is a fixture that
/// drifts, which is the exact failure this whole mechanism exists to prevent — so the
/// suite walks up from its own source file to the repository root rather than
/// declaring a resource bundle.
///
/// `#filePath` is the seam that makes that possible: it is baked in at compile time
/// and points at this file wherever the repository happens to live, which a
/// `Bundle.module` resource never could without a copy.
enum FixtureLoader {
    struct NotFound: Error, CustomStringConvertible {
        let searched: [String]
        var description: String {
            """
            could not find shared/fixtures. Searched:
            \(searched.joined(separator: "\n"))
            """
        }
    }

    /// The repository's `shared/fixtures` directory.
    static func fixturesDirectory() throws -> URL {
        var searched: [String] = []
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

        // Nine levels is far more than the four this actually needs; the loop stops at
        // the filesystem root anyway, and being generous means moving the package one
        // directory deeper does not silently break the gate.
        for _ in 0..<9 {
            let candidate = directory.appendingPathComponent("shared/fixtures", isDirectory: true)
            searched.append(candidate.path)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("manifest.json").path) {
                return candidate
            }
            let parent = directory.deletingLastPathComponent()
            if parent == directory { break }
            directory = parent
        }
        throw NotFound(searched: searched)
    }

    /// The manifest. Reading it — rather than hard-coding a file list — is what stops
    /// a fixture being added and never decoded: the TypeScript suite already asserts
    /// the manifest lists every file on disk, so both sides see the same set by
    /// construction.
    static func manifest() throws -> FixtureManifest {
        let url = try fixturesDirectory().appendingPathComponent("manifest.json")
        return try JSONDecoder().decode(FixtureManifest.self, from: Data(contentsOf: url))
    }

    static func data(for entry: FixtureManifest.Entry) throws -> Data {
        try Data(contentsOf: fixturesDirectory().appendingPathComponent(entry.file))
    }
}

struct FixtureManifest: Decodable {
    struct Entry: Decodable {
        /// Path relative to `shared/fixtures`.
        let file: String
        /// The schema name in `openapi.yaml`.
        let schema: String
        /// `"ok"` — the file is `{ success: true, data: … }`. `"raw"` — the file *is*
        /// the named type.
        let envelope: Envelope
        let summary: String

        enum Envelope: String, Decodable {
            case ok
            case raw
        }
    }

    let fixtures: [Entry]
}
