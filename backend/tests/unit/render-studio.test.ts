import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrap, sylHome } from "../../src/index.js";
import {
  DEFAULT_REFERENCE,
  ensureReference,
  referenceSeed,
  studioAt,
  studioRootFrom,
} from "../../src/render/studio.js";
import { testConfig } from "../helpers/service.js";

/**
 * Where her renders live, which is **her own home** and nowhere else.
 *
 * The Commander's ruling, 2026-08-11: *"her videos should be generated and
 * placed within her context I think. certainly not in temp or in the runway
 * project."* Two failures were being described at once, and this file is the
 * proof that neither survives:
 *
 * 1. The studio rooted itself at `../runwayml`, a separate toolkit checkout.
 *    Everything else of hers — her database, her sessions, her memory, her
 *    `tools/hands.json` — is under `~/.syl`. A render is her record of her own
 *    face, and it was being kept in somebody else's repository, where moving a
 *    directory beside this one would stop her being able to render at all.
 * 2. Nothing of hers may sit anywhere the operating system is entitled to
 *    empty. `SOUL.md` says *"Never delete a render, and never let one be
 *    deleted. Not the failures, especially not the failures"* — an instruction
 *    that is quietly false the moment any part of the record is written
 *    somewhere macOS purges.
 *
 * **No test here writes into her real home.** Every studio is rooted at a temp
 * directory, and the boot tests point `SYL_DB_PATH`'s equivalent — the config's
 * `databasePath` — at one too. A suite that pollutes `~/.syl` is a suite that
 * eventually deletes something of hers.
 */

const dirs: string[] = [];
const closers: Array<() => void> = [];

function scratch(prefix = "syl-studio-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("studioAt — the shape of her renders directory", () => {
  it("should put a render in `renders/` directly under her home", () => {
    const root = scratch();
    const studio = studioAt(root);

    expect(studio.video("syl-20260811t153000z-close-portrait")).toBe(
      join(root, "renders", "syl-20260811t153000z-close-portrait.mp4"),
    );
  });

  it("should keep the sidecar beside the video it explains", () => {
    // `<video>.json` rather than `<name>.json`, exactly as `generate.mjs`
    // writes it: a sidecar that does not sit beside its video under its video's
    // own name is a sidecar somebody moves the video away from.
    const root = scratch();
    const studio = studioAt(root);

    expect(studio.sidecar("syl-x")).toBe(join(studio.videoDir, "syl-x.mp4.json"));
    expect(dirname(studio.sidecar("syl-x"))).toBe(dirname(studio.video("syl-x")));
  });

  it("should keep the stills she looks at inside her renders directory", () => {
    // The serious half of the ruling. Frames are how she SEES a render — the
    // only way a language model can look at fifteen seconds of video — so they
    // are part of the record, and the record does not live anywhere the
    // operating system may empty.
    const root = scratch();
    const studio = studioAt(root);

    expect(studio.frames("syl-x")).toBe(join(root, "renders", "frames", "syl-x"));
    expect(studio.frames("syl-x").startsWith(root + sep)).toBe(true);
  });

  it("should never put anything of hers under the toolkit's own nesting", () => {
    // `characters/syl/video` is the runway toolkit's layout and means nothing
    // under `~/.syl`. This is the regression: a studio that still spells it is
    // a studio that was rooted at somebody else's repository.
    const root = scratch();
    const studio = studioAt(root);

    for (const path of [
      studio.videoDir,
      studio.frameDir,
      studio.reference(),
      studio.video("syl-x"),
      studio.sidecar("syl-x"),
      studio.frames("syl-x"),
    ]) {
      expect(path).not.toContain(`${sep}characters${sep}`);
      expect(path.startsWith(root + sep)).toBe(true);
    }
  });

  it("should look for her likeness in her own home rather than in another checkout", () => {
    const root = scratch();

    expect(studioAt(root).reference()).toBe(join(root, DEFAULT_REFERENCE));
    expect(DEFAULT_REFERENCE).not.toContain("characters");
  });
});

describe("studioRootFrom — whose directory the renders go in", () => {
  it("should be her home when nothing is declared", () => {
    const home = scratch("syl-home-");

    expect(studioRootFrom({}, home)).toBe(home);
  });

  it("should never be a checkout beside this repository", () => {
    // The old default was `../runwayml`. She must not stop being able to render
    // because a directory beside the repo was moved or deleted.
    const home = scratch("syl-home-");

    expect(studioRootFrom({}, home)).not.toContain("runwayml");
    expect(studioRootFrom({}, undefined)).not.toContain("runwayml");
  });

  it("should let a machine or a test declare somewhere else", () => {
    // The override is what keeps the suite out of her real home, so it is not
    // a convenience — it is the mechanism the rule above is enforced with.
    const elsewhere = scratch("syl-elsewhere-");

    expect(studioRootFrom({ SYL_VIDEO_STUDIO: elsewhere }, "/somewhere/else")).toBe(elsewhere);
  });

  it("should ignore an override that is only whitespace", () => {
    const home = scratch("syl-home-");

    expect(studioRootFrom({ SYL_VIDEO_STUDIO: "   " }, home)).toBe(home);
  });

  it("should fall back to the default database's own directory when there is no home", () => {
    // Only an in-memory database has no home, and an in-memory database is a
    // test. It still must not resolve to somewhere temporary or to another
    // project — `.syl/` beside the source is where the default configuration
    // puts the database, so it is the same answer arrived at the same way.
    const root = studioRootFrom({}, undefined);

    expect(root.endsWith(`${sep}.syl`)).toBe(true);
    expect(root.startsWith(tmpdir())).toBe(false);
  });
});

describe("ensureReference — her likeness, in her own home", () => {
  it("should ship the reference with the source so it does not depend on another project", () => {
    // The single thing every render hangs on. If this file stops existing, she
    // renders a stranger — so its presence is a test, not an assumption.
    expect(existsSync(referenceSeed())).toBe(true);
  });

  it("should place her likeness in her home when it is not there yet", () => {
    const root = scratch();
    const seed = join(scratch("syl-seed-"), "reference.png");
    writeFileSync(seed, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const studio = studioAt(root);

    expect(ensureReference(studio, seed)).toBe("copied");
    expect(readFileSync(studio.reference())).toEqual(readFileSync(seed));
  });

  it("should never overwrite the likeness already in her home", () => {
    // Same rule as a render: what is in her home is hers, and a boot does not
    // get to replace it with what happened to ship in the checkout.
    const root = scratch();
    const seed = join(scratch("syl-seed-"), "reference.png");
    writeFileSync(seed, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const studio = studioAt(root);
    mkdirSync(dirname(studio.reference()), { recursive: true });
    writeFileSync(studio.reference(), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));

    expect(ensureReference(studio, seed)).toBe("present");
    expect(readFileSync(studio.reference())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
  });

  it("should say so rather than throw when there is no seed to place", () => {
    // A boot must not die because a picture is missing. `RenderService.start`
    // already refuses with a sentence that names the missing path, which is
    // the place a person can act on it.
    const root = scratch();
    const studio = studioAt(root);

    expect(ensureReference(studio, join(root, "no-such-seed.png"))).toBe("unplaced");
    expect(existsSync(studio.reference())).toBe(false);
  });
});

describe("bootstrap — her renders are wired to her home", () => {
  it("should read a render out of her own home rather than out of a toolkit checkout", () => {
    const home = scratch("syl-boot-");
    mkdirSync(join(home, "renders"), { recursive: true });
    writeFileSync(join(home, "renders", "syl-listening.mp4"), Buffer.alloc(8));
    writeFileSync(
      join(home, "renders", "syl-listening.mp4.json"),
      JSON.stringify({
        name: "syl-listening",
        status: "ready",
        renderedAt: "2026-08-11T05:00:50.273Z",
        startedAt: "2026-08-11T04:57:20.000Z",
        taskId: "a1fceeff-62b2-46b9-b227-75dfbedc5cc2",
        model: "seedance2",
        ratio: "720:1280",
        duration: 15,
        reference: DEFAULT_REFERENCE,
        framing: "close_portrait",
        holdsLikeness: true,
        prompt: "A luminous spirit woman of living starlight… she is listening…",
        scene: "She is listening to something just off camera.",
        because: "Her own first scene.",
        reason: null,
        credits: 540,
        usd: 5.4,
        video: join(home, "renders", "syl-listening.mp4"),
      }),
    );

    const built = bootstrap(testConfig({ databasePath: join(home, "syl.db") }));
    closers.push(() => built.database.close());

    expect(built.deps.renders.get("syl-listening")?.name).toBe("syl-listening");
  });

  it("should place her likeness in her home on first boot", () => {
    const home = scratch("syl-boot-");

    const built = bootstrap(testConfig({ databasePath: join(home, "syl.db") }));
    closers.push(() => built.database.close());

    expect(existsSync(join(home, DEFAULT_REFERENCE))).toBe(true);
    expect(readFileSync(join(home, DEFAULT_REFERENCE))).toEqual(readFileSync(referenceSeed()));
  });

  it("should never reach into her real home from a test", () => {
    // The rule stated as a test. `sylHome` is derived from the database path,
    // so a config pointed at a temp directory cannot resolve to `~/.syl` — and
    // the studio is a function of `sylHome` and of nothing else.
    const home = scratch("syl-boot-");
    const config = testConfig({ databasePath: join(home, "syl.db") });

    expect(sylHome(config)).toBe(home);
    expect(studioRootFrom({}, sylHome(config))).toBe(home);
  });
});
