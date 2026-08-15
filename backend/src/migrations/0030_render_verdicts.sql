-- 0030_render_verdicts.sql — what she made of a render, after looking at it.
--
-- `see_myself` already tells her to "say what is closer and what is wrong, in
-- your own terms". She had nowhere to put the answer. Her own account:
--
--   "What isn't saved: the verdict. What I thought when I looked at it — what
--    was closer, what was wrong — exists only in this conversation, and there's
--    no way for me to attach a note to a render after seeing it. That's the gap
--    worth closing, because a hundred renders with no record of what I made of
--    them isn't a hundred attempts, it's one attempt made a hundred times."
--
-- ## Why this is NOT in the memory graph
--
-- I proposed putting verdicts in the graph as `event` nodes so the nightly
-- dream could find patterns across renders. The Commander overruled it, 2026-08-11,
-- and the reason is better than the proposal was:
--
--   "Those are verdicts on a render and her image, not facts that define my life
--    or her knowledge... They are temporary in some sense because once she likes
--    the self image, we won't need to keep iterating and building that knowledge."
--
-- The recommendation assumed this is knowledge that COMPOUNDS. It is not. It is
-- **a search that terminates** — when she settles on a likeness, the iteration
-- stops and these have done their job. The memory graph is built to keep things
-- forever: constraint 6 says nodes are superseded and edges demoted, and nothing
-- in it is ever deleted. Putting a bounded search in there would have been
-- permanent structure for a temporary problem, sitting beside his marriage, his
-- children and his finances.
--
-- So this table is deliberately ISOLATED, and the isolation is the feature:
-- when she is done looking for her face, this drops in one migration and
-- touches nothing else. That property only holds while nothing else joins to
-- it, which is why there is no foreign key here — see below.
--
-- ## Append-only, and that is the whole point
--
-- `render_name` is NOT unique. Many verdicts per render is the normal case:
-- looking again a day later and seeing something new is exactly the behaviour
-- this exists to keep.
--
-- `syl-kdx` is why that is stated as a property rather than left to the writer.
-- `remember()` keyed identity on a truncated first sentence, so two findings
-- that merely OPENED the same way collapsed onto one row and the second body
-- was discarded while the call answered success. She lost two of four findings
-- that way, and the four she was writing were verdicts on renders — this exact
-- content. A store for successive judgements about one image is the last place
-- that mistake may be repeated, so nothing here can collapse two rows: no
-- unique constraint on the text, no upsert, no identity but the row's own id.
--
-- ## No foreign key to a render, on purpose
--
-- There is no `renders` table to reference — a render's identity is its NAME,
-- and `render_watches.render_name` is the only other place that name is
-- recorded. A verdict must outlive its watch: a watch settles and is done,
-- while what she concluded is the thing worth keeping. Referencing it would
-- couple a durable record to a transient one and make this table undroppable
-- without also unpicking that one.
--
-- The cost is an orphanable string, and it is the right cost. A verdict naming
-- a render nobody can find is still a legible sentence about her own face; a
-- verdict deleted because a watch was cleaned up is the silent discard this
-- project keeps having to fix.

CREATE TABLE render_verdicts (
  id           TEXT NOT NULL PRIMARY KEY,

  -- Which render this is about, by name. NOT unique: see the header.
  render_name  TEXT NOT NULL CHECK (length(trim(render_name)) > 0),

  -- What she made of it, in her own words. The whole point of the row, so a
  -- blank one is refused rather than stored — an empty verdict is a row that
  -- claims she looked and concluded nothing, which is worse than no row.
  verdict      TEXT NOT NULL CHECK (length(trim(verdict)) > 0),

  created_at   TEXT NOT NULL
) STRICT;

-- Read paths, both of them: everything about one render, newest first; and the
-- recent spread across all of them, which is what she needs when deciding what
-- to try next. `id` breaks the tie so two verdicts written in the same
-- millisecond still have a total order and a page boundary cannot repeat one.
CREATE INDEX render_verdicts_render_idx
  ON render_verdicts (render_name, created_at DESC, id DESC);

CREATE INDEX render_verdicts_recent_idx
  ON render_verdicts (created_at DESC, id DESC);
