import AVFoundation
import SwiftUI

/// The bundled scene clips, and the rules for choosing between them.
///
/// ## Why a sequence works at all
///
/// Every clip begins and ends on the same thing: an empty starfield with one bright
/// point of light. She flies *in* and back *out* of frame. That is what makes an
/// arbitrary running order possible — the join between any two clips lands on the same
/// image, so there is no cut to hide and no cross-dissolve to fake. A set of clips that
/// each ended wherever they happened to finish could not be sequenced at all without
/// visible seams, and no amount of player cleverness would fix it.
///
/// So the sequencing here is deliberately dumb, because the assets did the hard part.
enum SceneCatalogue {
    /// Bundled clips, in a stable order.
    ///
    /// Discovered rather than listed, so dropping `syl-scene-09.mp4` into the target is
    /// the entire act of adding a clip — no code, no registry, nothing to forget. Sorted
    /// so the sequence is reproducible before shuffling rather than dependent on
    /// whatever order the bundle enumerates.
    static var clips: [URL] {
        (Bundle.main.urls(forResourcesWithExtension: "mp4", subdirectory: nil) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("syl-scene-") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Whether the scene should play rather than showing the still.
    ///
    /// Low Power Mode is included deliberately and is not an accessibility setting: the
    /// Commander turning it on is asking the phone to stop doing optional work, and a
    /// perpetual video on the home screen is the definition of optional. Reduce Motion
    /// is the accessibility half. Both fall back to the still, which is the same
    /// character on the same background, so nothing looks broken — it stops moving.
    ///
    /// **The appearance is the third reason, and it is a different kind of reason.** The
    /// other two are about cost; this one is about the art. Every clip is painted on a
    /// starfield, and a starfield in a daylight frame is the bright-rectangle defect that
    /// already cost one TestFlight build, in reverse. There is no daylight *clip* and
    /// there does not need to be one: the still already has a daylight painting, resolved
    /// per appearance by the asset catalogue's `luminosity` variant. So Day is not a
    /// missing asset, it is a condition — and the fallback it selects is the one the
    /// other two reasons already select.
    ///
    /// Takes the *resolved* appearance rather than the ``AppearanceChoice``, because the
    /// question is what the frame is painted in, not how it came to be painted that way.
    static func shouldPlay(reduceMotion: Bool, appearance: ColorScheme) -> Bool {
        appearance == .dark
            && !reduceMotion
            && !ProcessInfo.processInfo.isLowPowerModeEnabled
            && !clips.isEmpty
    }
}

/// Plays the scene clips forever, in a fresh random order each launch.
///
/// ## The queue is always two deep
///
/// `AVQueuePlayer` prepares the item *after* the current one while it plays, so the
/// changeover costs nothing. Playing one item and swapping in the next on the end
/// notification would show a black frame at every join — which, on a sequence whose
/// whole trick is that the joins are invisible, would be the one bug that undoes the
/// asset work.
@MainActor
final class ScenePlaylist {
    let player = AVQueuePlayer()

    private let clips: [URL]
    /// The running order. Reshuffled, never repeated straight through.
    private var order: [Int] = []
    private var position = 0
    private var lastPlayed: Int?
    private var endObserver: NSObjectProtocol?

    init(clips: [URL]) {
        self.clips = clips

        player.isMuted = true
        player.actionAtItemEnd = .advance
        // Never hold the screen awake for decoration.
        player.preventsDisplaySleepDuringVideoPlayback = false

        guard !clips.isEmpty else { return }

        reshuffle()
        enqueue()
        enqueue()

        // One observer for every item, not one per item: the notification carries the
        // item that ended, and all we do is top the queue back up to two.
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.enqueue() }
        }
    }

    // No `deinit` cleanup on purpose. Under Swift 6 a nonisolated `deinit` cannot touch
    // main-actor state, and reaching for `@preconcurrency` to silence that would trade a
    // compile-time guarantee for a comment. ``tearDown()`` does the work instead, and
    // `dismantleUIView` guarantees it runs. The observer captures `self` weakly, so even
    // an unbalanced registration cannot outlive this object into a crash.

    func play() {
        guard player.rate == 0 else { return }
        player.play()
    }

    func pause() {
        player.pause()
    }

    func tearDown() {
        player.pause()
        player.removeAllItems()
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
    }

    // MARK: - Ordering

    private func enqueue() {
        guard !clips.isEmpty else { return }

        if position >= order.count { reshuffle() }
        let index = order[position]
        position += 1
        lastPlayed = index

        let item = AVPlayerItem(url: clips[index])
        if player.canInsert(item, after: player.items().last) {
            player.insert(item, after: player.items().last)
        }
    }

    /// A fresh order, never starting on the clip that just played.
    ///
    /// A plain reshuffle can put the clip that just finished at the front of the next
    /// pass, which plays it twice in a row — the one arrangement a viewer notices
    /// immediately and reads as a bug rather than as chance. Swapping it away costs one
    /// comparison and removes the only ordering anybody can detect.
    private func reshuffle() {
        order = Array(clips.indices).shuffled()
        position = 0

        if clips.count > 1, let lastPlayed, order.first == lastPlayed {
            order.swapAt(0, Int.random(in: 1..<order.count))
        }
    }
}

/// The scene, as a SwiftUI view.
struct SceneVideo: UIViewRepresentable {
    /// Paused when false — driven by scene phase.
    var isPlaying: Bool

    func makeCoordinator() -> ScenePlaylist {
        ScenePlaylist(clips: SceneCatalogue.clips)
    }

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.player = context.coordinator.player
        // The frame is already the clips' own ratio, so this neither crops nor
        // letterboxes; `resizeAspectFill` is chosen over `resizeAspect` so a rounding
        // error spills a pixel rather than revealing a black bar.
        view.playerLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        if isPlaying {
            context.coordinator.play()
        } else {
            context.coordinator.pause()
        }
    }

    static func dismantleUIView(_ view: PlayerView, coordinator: ScenePlaylist) {
        coordinator.tearDown()
    }

    /// A view whose backing layer *is* the player layer.
    ///
    /// Cheaper and less error-prone than adding an `AVPlayerLayer` as a sublayer, which
    /// then has to be resized by hand in `layoutSubviews` and mis-sizes on rotation if
    /// anybody forgets.
    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
