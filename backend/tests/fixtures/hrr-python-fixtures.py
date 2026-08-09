"""Generate `hrr-python.json` by RUNNING the real Nous Research implementation.

Nothing here re-derives the algorithm. `hermes/holographic.py` is the upstream
file, byte for byte; this script only feeds it inputs and records the exact
IEEE-754 bit patterns of what comes back. That is what makes the TypeScript port
verifiable instead of merely plausible — see CLAUDE.md's rule that fixtures come
from real captured output, never from our own type definitions.

The retrieval-kernel section transcribes the scoring loops from the same
commit's `retrieval.py` with the SQL replaced by in-memory lists. The algebra it
calls is still the real module.

This script is NOT run by CI. It is committed so the fixture's provenance is
auditable and so anyone can regenerate it. To do that:

    COMMIT=7a450ca5ce4682a0b20ecc31eca04af6cbd78206
    BASE=https://raw.githubusercontent.com/NousResearch/hermes-agent/$COMMIT
    mkdir -p hermes
    curl -sSo hermes/holographic.py $BASE/plugins/memory/holographic/holographic.py
    python3 -m venv venv && ./venv/bin/pip install numpy
    ./venv/bin/python hrr-python-fixtures.py

Upstream is MIT licensed (Copyright (c) 2025 Nous Research); the licence text
is vendored at `backend/src/memory/HERMES-LICENSE.txt`.

Regenerating under a different numpy or CPython may shift the `bundle` and
`similarity` values in their last few ulp — those are the transcendental-backed
outputs the port asserts with a measured tolerance rather than exactly. The
bit-for-bit tier (`encode_atom`, `bind`, `unbind`, `snr_estimate`, the
serialisation blobs) must not move at all; if it does, something is wrong.
"""

import base64
import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / "hermes"))

import numpy as np  # noqa: E402
import holographic as hrr  # noqa: E402

SOURCE = {
    "repo": "https://github.com/NousResearch/hermes-agent",
    "path": "plugins/memory/holographic/holographic.py",
    "commit": "7a450ca5ce4682a0b20ecc31eca04af6cbd78206",
    "licence": "MIT (Copyright (c) 2025 Nous Research)",
    "python": sys.version.split()[0],
    "numpy": np.__version__,
}


def f64(x) -> str:
    """A float64 as its exact 16-hex-digit big-endian bit pattern."""
    return struct.pack(">d", float(x)).hex()


def vec(a) -> str:
    """A phase vector as base64 of its big-endian float64 bytes — exact, and
    half the size of one hex string per element."""
    arr = np.asarray(a, dtype=np.float64)
    return base64.b64encode(arr.astype(">f8").tobytes()).decode("ascii")


out = {"$source": SOURCE}

# --------------------------------------------------------------- encode_atom
ATOM_WORDS = [
    "",
    "peppi",
    "backend",
    "commander",
    "__hrr_role_entity__",
    "__hrr_role_content__",
    "__hrr_empty__",
    "café",
    "日本語",
    "a" * 300,
    "0",
    ":",
    "word:0",  # collides with the counter-block format if naively concatenated
]
out["encode_atom"] = [
    {"word": w, "dim": d, "phases": vec(hrr.encode_atom(w, d))}
    for w in ATOM_WORDS
    for d in (1, 3, 8, 16, 17, 33)
] + [
    # Production dimension, on the three atoms every query path touches.
    {"word": w, "dim": 1024, "phases": vec(hrr.encode_atom(w, 1024))}
    for w in ("peppi", "__hrr_role_entity__", "__hrr_role_content__")
]

# ---------------------------------------------------------------- bind/unbind
BIND_PAIRS = [
    ("peppi", "__hrr_role_entity__"),
    ("backend", "__hrr_role_content__"),
    ("", "peppi"),
    ("café", "日本語"),
]
out["bind"] = []
out["unbind"] = []
for a_w, b_w in BIND_PAIRS:
    for d in (1, 8, 17) + ((1024,) if a_w == "peppi" else ()):
        a = hrr.encode_atom(a_w, d)
        b = hrr.encode_atom(b_w, d)
        out["bind"].append({"a": a_w, "b": b_w, "dim": d, "phases": vec(hrr.bind(a, b))})
        out["unbind"].append(
            {"memory": a_w, "key": b_w, "dim": d, "phases": vec(hrr.unbind(a, b))}
        )

# bind/unbind round trip on a bundled memory — exercises non-atom inputs
_m = hrr.bundle(hrr.encode_atom("alpha", 64), hrr.encode_atom("beta", 64))
out["unbind_bundled"] = {
    "memory_words": ["alpha", "beta"],
    "key": "alpha",
    "dim": 64,
    "memory": vec(_m),
    "phases": vec(hrr.unbind(_m, hrr.encode_atom("alpha", 64))),
}

# -------------------------------------------------------------------- bundle
BUNDLE_SETS = [
    ["peppi"],
    ["peppi", "backend"],
    ["peppi", "backend", "commander"],
    ["a", "b", "c", "d", "e"],
    ["same", "same"],          # constructive interference
    ["", "café", "日本語"],
]
out["bundle"] = [
    {
        "words": ws,
        "dim": d,
        "phases": vec(hrr.bundle(*[hrr.encode_atom(w, d) for w in ws])),
    }
    for ws in BUNDLE_SETS
    for d in (1, 8, 17)
] + [
    {
        "words": ws,
        "dim": 1024,
        "phases": vec(hrr.bundle(*[hrr.encode_atom(w, 1024) for w in ws])),
    }
    for ws in (["peppi", "backend"], ["a", "b", "c", "d", "e"])
]

# Antipodal cancellation: exp(i0) + exp(iπ) == 0, so angle() is defined by the
# residual rounding error. Captured deliberately — it is the one input where a
# port can diverge by a whole radian rather than an ulp.
_zero = np.zeros(8, dtype=np.float64)
_pi = np.full(8, math.pi, dtype=np.float64)
out["bundle_antipodal"] = {"dim": 8, "phases": vec(hrr.bundle(_zero, _pi))}

# ---------------------------------------------------------------- similarity
SIM_PAIRS = [
    ("peppi", "peppi"),
    ("peppi", "backend"),
    ("", ""),
    ("café", "日本語"),
    ("__hrr_role_entity__", "__hrr_role_content__"),
]
out["similarity"] = [
    {
        "a": a,
        "b": b,
        "dim": d,
        "value": f64(hrr.similarity(hrr.encode_atom(a, d), hrr.encode_atom(b, d))),
    }
    for a, b in SIM_PAIRS
    for d in (1, 8, 17, 128, 1024)
]

# similarity over bundled vectors, where the retrieval kernels actually use it
_bundle_ab = hrr.bundle(hrr.encode_atom("peppi", 1024), hrr.encode_atom("backend", 1024))
out["similarity_bundled"] = [
    {
        "left_words": ["peppi", "backend"],
        "right": w,
        "dim": 1024,
        "value": f64(hrr.similarity(_bundle_ab, hrr.encode_atom(w, 1024))),
    }
    for w in ("peppi", "backend", "commander")
]

# --------------------------------------------------------------- encode_text
TEXTS = [
    "",
    "   ",
    "the deployment rolled back",
    "Peppi runs the BACKEND.",
    "(hello) [world]! {ok}?",
    "...",
    "café Naïve RÉSUMÉ",
    "tabs\tand\nnewlines\r\nhere",
    "\x1c\x1d\x1e\x1f\x85 python-only whitespace \xa0 nbsp",
    "﻿ bom-prefixed",
    "ΟΣ final sigma İ dotted",
    "repeat repeat repeat",
    "a" * 5 + " " + "b" * 5,
]
out["encode_text"] = [
    {"text": t, "dim": d, "phases": vec(hrr.encode_text(t, d))}
    for t in TEXTS
    for d in (8, 17)
] + [
    {"text": t, "dim": 1024, "phases": vec(hrr.encode_text(t, 1024))}
    for t in ("the deployment rolled back", "Peppi runs the BACKEND.")
]

# --------------------------------------------------------------- encode_fact
FACTS = [
    ("Peppi runs the backend", ["Peppi", "backend"]),
    ("The deployment rolled back", []),
    ("", ["solo"]),
    ("mixed CASE entities", ["MiXeD", "café"]),
    ("duplicate entity", ["dup", "dup"]),
]
out["encode_fact"] = [
    {"content": c, "entities": e, "dim": d, "phases": vec(hrr.encode_fact(c, e, d))}
    for c, e in FACTS
    for d in (8, 17)
] + [
    {"content": c, "entities": e, "dim": 1024, "phases": vec(hrr.encode_fact(c, e, 1024))}
    for c, e in (("Peppi runs the backend", ["Peppi", "backend"]), ("", ["solo"]))
]

# ------------------------------------------------------- serialisation format
SER = []
for d in (1, 2, 8, 1024):
    p = hrr.encode_atom("serialise-me", d)
    blob = hrr.phases_to_bytes(p, d)
    SER.append(
        {
            "word": "serialise-me",
            "dim": d,
            "blob": blob.hex(),
            "round_trip": vec(hrr.bytes_to_phases(blob, d)),
            "round_trip_no_dim": vec(hrr.bytes_to_phases(blob)),
        }
    )
# a legacy raw-float64 blob must still read back
_legacy_p = hrr.encode_atom("legacy", 8)
_legacy = np.asarray(_legacy_p, dtype=np.float64).tobytes()
SER.append(
    {
        "word": "legacy",
        "dim": 8,
        "legacy": True,
        "blob": _legacy.hex(),
        "round_trip": vec(hrr.bytes_to_phases(_legacy, 8)),
        "round_trip_no_dim": vec(hrr.bytes_to_phases(_legacy)),
    }
)
out["serialisation"] = SER

# ------------------------------------------------------------- snr_estimate
out["snr_estimate"] = [
    {"dim": d, "n_items": n, "value": f64(hrr.snr_estimate(d, n))}
    for d, n in [(1024, 0), (1024, 1), (1024, 256), (1024, 257), (1024, 1024), (8, 3), (1024, -5)]
]


# ================================================================= retrieval
# Loops transcribed from retrieval.py at the same commit, SQL replaced by
# in-memory lists. Every numeric call below is the real holographic module.
DIM = 1024

CORPUS = [
    {
        "id": "f1",
        "content": "Peppi restarted the backend after the deploy",
        "entities": ["Peppi", "backend"],
        "trust": 0.9,
    },
    {
        "id": "f2",
        "content": "The backend runs on port 4201",
        "entities": ["backend"],
        "trust": 0.7,
    },
    {
        "id": "f3",
        "content": "Peppi prefers tea in the morning",
        "entities": ["Peppi"],
        "trust": 0.5,
    },
    {
        "id": "f4",
        "content": "Quiet hours are 23:00 to 08:00",
        "entities": ["quiet hours"],
        "trust": 1.0,
    },
    {
        "id": "f5",
        "content": "The backend never restarts cleanly",
        "entities": ["backend", "Peppi"],
        "trust": 0.6,
    },
]
for f in CORPUS:
    f["vec"] = hrr.encode_fact(f["content"], f["entities"], DIM)

out["corpus"] = [
    {
        "id": f["id"],
        "content": f["content"],
        "entities": f["entities"],
        "trust": f64(f["trust"]),
        "vector": vec(f["vec"]),
    }
    for f in CORPUS
]

role_entity = hrr.encode_atom("__hrr_role_entity__", DIM)
role_content = hrr.encode_atom("__hrr_role_content__", DIM)


def related(entity: str):
    entity_vec = hrr.encode_atom(entity.lower(), DIM)
    scored = []
    for f in CORPUS:
        residual = hrr.unbind(f["vec"], entity_vec)
        entity_role_sim = hrr.similarity(residual, role_entity)
        content_role_sim = hrr.similarity(residual, role_content)
        best = max(entity_role_sim, content_role_sim)
        scored.append({"id": f["id"], "score": (best + 1.0) / 2.0 * f["trust"]})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


def reason(entities: list):
    probe_keys = [
        hrr.bind(hrr.encode_atom(e.lower(), DIM), role_entity) for e in entities
    ]
    scored = []
    for f in CORPUS:
        sims = [hrr.similarity(hrr.unbind(f["vec"], k), role_content) for k in probe_keys]
        scored.append({"id": f["id"], "score": (min(sims) + 1.0) / 2.0 * f["trust"]})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


def probe(entity: str):
    probe_key = hrr.bind(hrr.encode_atom(entity.lower(), DIM), role_entity)
    scored = []
    for f in CORPUS:
        residual = hrr.unbind(f["vec"], probe_key)
        content_vec = hrr.bind(hrr.encode_text(f["content"], DIM), role_content)
        sim = hrr.similarity(residual, content_vec)
        scored.append({"id": f["id"], "score": (sim + 1.0) / 2.0 * f["trust"]})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


def contradict(threshold: float):
    ents = {f["id"]: {e.lower() for e in f["entities"]} for f in CORPUS}
    found = []
    for i in range(len(CORPUS)):
        for j in range(i + 1, len(CORPUS)):
            f1, f2 = CORPUS[i], CORPUS[j]
            e1, e2 = ents[f1["id"]], ents[f2["id"]]
            if not e1 or not e2:
                continue
            union = e1 | e2
            overlap = len(e1 & e2) / len(union) if union else 0.0
            if overlap < 0.3:
                continue
            content_sim = hrr.similarity(f1["vec"], f2["vec"])
            score = overlap * (1.0 - (content_sim + 1.0) / 2.0)
            if score >= threshold:
                found.append(
                    {
                        "a": f1["id"],
                        "b": f2["id"],
                        "entity_overlap": f64(round(overlap, 3)),
                        "content_similarity": f64(round(content_sim, 3)),
                        "contradiction_score": f64(round(score, 3)),
                        "shared_entities": sorted(e1 & e2),
                    }
                )
    found.sort(key=lambda x: struct.unpack(">d", bytes.fromhex(x["contradiction_score"]))[0], reverse=True)
    return found


def scores(rows):
    return [{"id": r["id"], "score": f64(r["score"])} for r in rows]


out["related"] = [
    {"entity": e, "results": scores(related(e))}
    for e in ("Peppi", "backend", "tea", "nonexistent")
]
out["reason"] = [
    {"entities": es, "results": scores(reason(es))}
    for es in (["Peppi"], ["Peppi", "backend"], ["Peppi", "backend", "quiet hours"])
]
out["probe"] = [{"entity": e, "results": scores(probe(e))} for e in ("Peppi", "backend")]
out["contradict"] = [
    {"threshold": f64(t), "results": contradict(t)} for t in (0.0, 0.2, 0.3, 0.9)
]

dest = HERE / "hrr-python.json"
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"wrote {dest} ({dest.stat().st_size} bytes)")
