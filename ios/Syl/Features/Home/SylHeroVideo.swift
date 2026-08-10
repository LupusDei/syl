import AVFoundation
import SwiftUI

/// A silent, gapless, looping video — the hero when one is bundled.
///
/// ## The four things that make an ambient loop acceptable rather than obnoxious
///
/// 1. **It must not touch the user's audio.** A hero video that pauses the Commander's
///    podcast the moment he opens the app is a bug he will feel before he sees anything.
///    Muting the player is not sufficient on its own — the reliable fix is that the
///    asset carries *no audio track at all*, and the bundled file is stripped with
///    `-an`. `isMuted` is set as well, as belt and braces.
/// 2. **It must be gapless.** `AVPlayerLooper` over an `AVQueuePlayer` loops without the
///    black frame or hitch that re-seeking a single `AVPlayer` gives you.
/// 3. **It must stop when nobody is looking.** Decoding video forever on a screen that
///    is backgrounded, or behind another tab, is pure battery. This pauses on scene
///    phase and on disappearance.
/// 4. **It must be skippable.** Reduce Motion and Low Power Mode both fall back to the
///    still image — the same art, so nothing looks broken, it simply stops moving.
///
/// ## Where the file goes
///
/// Drop a file named `syl-hero-loop.mp4` (and optionally `syl-hero-loop-night.mp4`) into
/// the app target. Nothing else has to change: ``SylHero`` prefers a video when one is
/// present and falls back to the still when it is not, so the swap is a file drop and a
/// build.
///
/// **The video must carry the same aspect ratio as the still** — see
/// ``SylHero/artAspect``. The edge masks are computed from that constant, and a
/// mismatched video would letterbox inside its frame and bring back the hard-edged
/// rectangle the masks exist to prevent.
struct LoopingVideo: UIViewRepresentable {
    let url: URL
    /// Paused when false. Driven by scene phase and by visibility.
    var isPlaying: Bool

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.player = context.coordinator.player
        view.playerLayer.videoGravity = .resizeAspectFill
        // The frame is already the art's ratio, so `resizeAspectFill` neither crops nor
        // letterboxes; it is chosen over `resizeAspect` because a rounding error should
        // spill a pixel rather than reveal a black bar.
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        context.coordinator.setPlaying(isPlaying)
    }

    static func dismantleUIView(_ view: PlayerView, coordinator: Coordinator) {
        coordinator.tearDown()
    }

    /// A view whose backing layer *is* the player layer.
    ///
    /// Cheaper and less error-prone than adding an `AVPlayerLayer` as a sublayer, which
    /// then has to be resized by hand in `layoutSubviews` and mis-sizes on rotation if
    /// you forget.
    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    @MainActor
    final class Coordinator {
        let player: AVQueuePlayer
        private var looper: AVPlayerLooper?

        init(url: URL) {
            let item = AVPlayerItem(url: url)
            let player = AVQueuePlayer()
            player.isMuted = true
            // Never let this player take over the audio session or the Now Playing
            // slot. The asset has no audio track, but a player that *could* play audio
            // is still a player iOS may treat as primary.
            player.preventsDisplaySleepDuringVideoPlayback = false
            player.actionAtItemEnd = .advance

            self.player = player
            self.looper = AVPlayerLooper(player: player, templateItem: item)
        }

        func setPlaying(_ playing: Bool) {
            if playing {
                guard player.rate == 0 else { return }
                player.play()
            } else {
                player.pause()
            }
        }

        func tearDown() {
            player.pause()
            looper?.disableLooping()
            looper = nil
            player.removeAllItems()
        }
    }
}

/// Which hero media to use, resolved once.
///
/// Kept as a type rather than an inline `Bundle.main.url(...)` so the decision — and the
/// reasons the video is declined — sit in one place with the reasoning attached.
enum HeroMedia {
    /// The bundled loop for the current appearance, if there is one.
    static func videoURL(dark: Bool) -> URL? {
        let names = dark ? ["syl-hero-loop-night", "syl-hero-loop"] : ["syl-hero-loop"]
        for name in names {
            if let url = Bundle.main.url(forResource: name, withExtension: "mp4") {
                return url
            }
        }
        return nil
    }

    /// Whether a bundled video should actually be played.
    ///
    /// Low Power Mode is included deliberately and is not an accessibility setting: the
    /// Commander turning on Low Power Mode is asking the phone to stop doing optional
    /// work, and decoding an ambient loop forever is the definition of optional. The
    /// still image is the same art, so the screen does not look broken — it stops
    /// moving, which is what was asked for.
    static func shouldAnimate(reduceMotion: Bool) -> Bool {
        !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
    }
}
