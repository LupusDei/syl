import SwiftUI

/// How this app draws light: the feather, and the tint.
///
/// Both functions are lifted verbatim from ``SylRibbon``, which is the surface they were
/// tuned on. They are here rather than there because ``SylHalo`` needs exactly the same
/// light — someone who has seen the ribbon in chat has to recognise the halo on the home
/// screen as the same creature — and two private copies of the same eight lines is how
/// two surfaces slowly stop being the same creature.
///
/// `SylRibbon` still carries its own copies. It was left untouched deliberately: chat is
/// being worked on in parallel and the ribbon's behaviour is not what this change is
/// about. **Adopt these there next time anyone is in that file** — the numbers are
/// identical today and there is nothing to reconcile.
enum Luminous {
    /// Widths and opacities of the five feather passes, outermost first.
    ///
    /// The soft edge is five concentric strokes of the same path at widening widths and
    /// falling opacity, blended additively — Rive's vector-feathering trick done by hand.
    /// It costs a fraction of a real blur, which is a full-surface convolution every
    /// frame where this is five stroke operations.
    /// - Parameter painted: true where the light is being laid down as pigment rather than
    ///   emitted — see ``SylHalo`` on why the two appearances differ. Additive passes
    ///   compound with each other and a faint outer one still tells; alpha-composited over
    ///   a pale ground it disappears entirely, and the feather collapses into a hairline.
    ///   The painted ramp is the same five widths with the opacities pulled toward each
    ///   other, which is what a soft edge costs when you cannot add light to a bright page.
    static func featherPasses(coreWidth: Double, painted: Bool = false) -> [(CGFloat, Double)] {
        let alphas = painted
            ? [0.13, 0.18, 0.26, 0.42, 0.95]
            : [0.05, 0.09, 0.16, 0.32, 0.95]

        return zip([6.0, 3.8, 2.4, 1.5, 1.0], alphas).map { (coreWidth * $0, $1) }
    }

    /// The tint, as weighted layers.
    ///
    /// `Color.mix(with:by:)` would be the obvious tool and is iOS 18; this app targets
    /// 17. Additive layering gets the same result where the blend mode is already
    /// `plusLighter` — weighting three strokes is arithmetically a mix. Negligible layers
    /// are dropped so the common case (cool, unsaturated) is a single stroke rather than
    /// three.
    static func tintLayers(warmth: Double, desaturation: Double) -> [(Color, Double)] {
        let cool = max(0, 1 - warmth - desaturation)

        return [
            (SylTheme.Colour.luminance, cool),
            (SylTheme.Colour.warmth, warmth),
            (SylTheme.Colour.greyBlue, desaturation),
        ].filter { $0.1 > 0.01 }
    }
}
