# knowledge/

Ingested external knowledge — things Syl learned from a source outside this
repo (a book, a paper, a talk, a transcript) and should be able to draw on
later.

This is **not** the Commander's memory. His to-dos, goals, preferences and the
record of what he said live in the memory stores under `syl-005`. This folder
is the other kind: durable facts about the world, ingested deliberately, with
their provenance attached.

## Convention

One topic per slug, two files:

| file            | audience | contains                                                    |
| --------------- | -------- | ----------------------------------------------------------- |
| `<slug>.md`     | human + Syl-as-reader | the prose. Why it matters, the argument, the caveats. |
| `<slug>.json`   | Syl-as-program        | the extractable part — constants, exponents, worked examples — in a shape you can compute with. |

The `.md` is the thing to put in a prompt. The `.json` is the thing to look a
number up in. Neither is generated from the other; they are written together
and must agree.

## Every entry carries provenance

`provenance` is mandatory in the JSON. A fact with no source is a rumour, and
Syl repeating a rumour to the Commander is worse than Syl saying nothing.

```json
"provenance": {
  "source_type": "video_transcript",
  "title": "...",
  "local_path": "~/code/ai/transcripts/...",
  "ingested": "2026-08-09",
  "ingested_by": "tassadar"
}
```

## Every claim carries a confidence

Fields on each law/constant:

- `confidence` — `established` | `contested` | `speculative`
- `contested` — boolean, and if true, `dispute` names the disagreement

This exists because the very first entry demanded it. Kleiber's 3/4 exponent is
quoted everywhere as settled and **is not** — a live research community is split
between 2/3 and 3/4, and a 1960s symposium partly *voted* the number into
existence. If Syl ever states one of these to the Commander, the contested flag
is what stops her stating it flatly.

## Relationship to `syl-005.1.3`

`syl-005.1.3` ("source store with provenance and retention class") is the real
version of this: rows in SQLite, retrievable by embedding and FTS5. This folder
is the flat-file precursor — the same discipline (provenance, confidence,
supersession) at a scale where files are still the simplest thing that works.
When the source store lands, these entries are its first import, and the schema
here is deliberately close to what it will need.

## Entries

| slug           | topic                                                            |
| -------------- | ---------------------------------------------------------------- |
| `scaling-laws` | Allometric and urban scaling — why every mammal gets ~1e9 heartbeats |

## Rendered explainers

An entry may also have a standalone explainer page. These are presentations of
an entry, never a second copy of the facts — if the numbers disagree, the
`.json` wins.

| entry          | page                                                              | served from |
| -------------- | ----------------------------------------------------------------- | ----------- |
| `scaling-laws` | `http://localhost:4200/knowledge/scaling-laws.html` | `adjutant/frontend/public/knowledge/scaling-laws.html` |

The Adjutant frontend is Vite, so anything under its `public/` is served at the
site root in dev and copied into `dist/` on build. No route registration and no
rebuild is needed to add or update one.
