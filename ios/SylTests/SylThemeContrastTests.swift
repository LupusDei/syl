import SwiftUI
import UIKit
import XCTest

@testable import Syl

/// The palette's own rule, made checkable.
///
/// `SylTheme.Colour.luminance` carries a long comment explaining that **light is
/// additive**: against near-black a pale tint reads as a glow, and against the pale veil
/// the same colour is invisible because there is nothing for it to add to. So the light
/// appearance renders as *pigment*, which has to carry real chroma to be seen.
///
/// That rule was stated in prose and applied to exactly one token. `warmth` shipped as
/// essentially the same pale peach in both appearances and nobody noticed for two
/// reasons: it had only ever been used **on glass**, where the fill supplies its own
/// ground, and Home was forced to night, so the light appearance was barely reachable.
/// The moment `syl-011` put warmth on bare veil as small text, two squads independently
/// reported it as the weakest thing on screen.
///
/// **A palette rule stated only in prose is a rule the next token will also miss.** So it
/// is asserted here.
final class SylThemeContrastTests: XCTestCase {

    /// The floor for text, from WCAG 2.1 AA at ordinary sizes.
    private let readable: Double = 4.5

    /// Ink on the veil, in both appearances.
    ///
    /// The **darkest** part of the light veil and the **lightest** part of the night veil
    /// are the worst cases for their respective inks, and testing the easy end of each
    /// gradient is how a palette passes its own test while failing on screen.
    func testShouldKeepInkReadableAgainstTheWholeVeil() {
        for appearance in [UIUserInterfaceStyle.light, .dark] {
            for ground in [SylTheme.Colour.veil, SylTheme.Colour.veilDeep] {
                XCTAssertGreaterThanOrEqual(
                    contrast(SylTheme.Colour.ink, on: ground, in: appearance),
                    readable,
                    "ink must be readable on every part of the veil (\(appearance.rawValue))"
                )
            }
        }
    }

    /// `inkSoft` is what small text on the bare veil uses, after `inkFaint` was found to
    /// vanish into a bloom. That finding is in `docs/CONTEXT.md`; this is the guard.
    func testShouldKeepSoftInkReadableAgainstTheWholeVeil() {
        for appearance in [UIUserInterfaceStyle.light, .dark] {
            for ground in [SylTheme.Colour.veil, SylTheme.Colour.veilDeep] {
                XCTAssertGreaterThanOrEqual(
                    contrast(SylTheme.Colour.inkSoft, on: ground, in: appearance),
                    readable,
                    "inkSoft carries small text on the bare veil (\(appearance.rawValue))"
                )
            }
        }
    }

    /// The regression this file was written for.
    ///
    /// `warmth` is the palette's single warm note and it marks the things that need him.
    /// A signal that cannot be read is not a signal.
    func testShouldKeepWarmthReadableOnTheBareVeil() {
        for appearance in [UIUserInterfaceStyle.light, .dark] {
            for ground in [SylTheme.Colour.veil, SylTheme.Colour.veilDeep] {
                XCTAssertGreaterThanOrEqual(
                    contrast(SylTheme.Colour.warmth, on: ground, in: appearance),
                    readable,
                    "warmth marks what needs him; it has to be legible (\(appearance.rawValue))"
                )
            }
        }
    }

    /// The rule behind all three, stated directly rather than only as an outcome.
    ///
    /// In the light appearance every ink-bearing token must be **darker** than the veil
    /// it sits on — pigment, not emission. A token that is lighter than its ground in
    /// light mode is one that was designed against the night and never checked.
    func testShouldMakeEveryInkTokenPigmentInTheLightAppearance() {
        let ground = luminance(of: SylTheme.Colour.veil, in: .light)

        for (name, colour) in [
            ("ink", SylTheme.Colour.ink),
            ("inkSoft", SylTheme.Colour.inkSoft),
            ("warmth", SylTheme.Colour.warmth),
            ("luminance", SylTheme.Colour.luminance),
        ] {
            XCTAssertLessThan(
                luminance(of: colour, in: .light),
                ground,
                "\(name) is lighter than the light veil — that is emission, and it reads as nothing"
            )
        }
    }

    // MARK: - WCAG

    private func contrast(
        _ colour: Color,
        on ground: Color,
        in appearance: UIUserInterfaceStyle
    ) -> Double {
        let a = luminance(of: colour, in: appearance)
        let b = luminance(of: ground, in: appearance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// Relative luminance, resolved in a specific appearance.
    ///
    /// Resolved rather than compared as `Color`, because every token here is a *computed*
    /// property returning a fresh dynamic `UIColor` — equality on those is identity, and
    /// the raw value tells you nothing about which appearance you are looking at.
    private func luminance(of colour: Color, in appearance: UIUserInterfaceStyle) -> Double {
        let resolved = UIColor(colour)
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: appearance))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)

        func linear(_ channel: CGFloat) -> Double {
            let value = Double(channel)
            return value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}
