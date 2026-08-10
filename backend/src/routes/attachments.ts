import { Router, type Request, type RequestHandler } from "express";

import type { Attachment, AttachmentKind } from "@syl/shared";

import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  toAttachment,
  type AttachmentStore,
  type AttachmentVariant,
} from "../services/attachment-store.js";
import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendFailure } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Images and video, over HTTP.
 *
 * Two operations, and one of them breaks a rule the rest of the contract keeps
 * absolutely — so both are worth stating plainly.
 *
 * ## `GET` answers bytes, not an envelope
 *
 * Everything else Syl serves is `{ success, data }`. This is not, and the
 * reasoning is in the contract beside the operation: base64-wrapping an image
 * so it could be spelled like a to-do adds a third to every byte on the one
 * path where bytes are dearest — a phone on cellular, through a tailnet — and
 * makes the response unstreamable and uncacheable at the same time.
 *
 * The property the envelope rule actually protects survives, restated: **every
 * FAILURE here is still the envelope**, and the discriminator is
 * `Content-Type`. JSON means Syl refused, the declared media type means these
 * are the bytes, and anything else — a captive portal's `text/html`, a
 * Tailscale error page — is a transport failure, which is exactly the
 * conclusion the rule exists to make available.
 *
 * ## Both routes take a `device` token. Deliberately.
 *
 * `GET /logs` is the one operation a paired phone may not call, and the
 * argument there is precise: the log is not the Commander's data, it is the
 * record of what a pre-authorised program did on his machine. An attachment is
 * not that. It is his own picture in his own conversation, and the phone is
 * the thing that has to render it — a scope gate on the read would make Phase
 * 6 impossible for the only client that exists.
 *
 * The write is the more interesting half, because the epic's plan defers
 * "sending images from the phone" on the grounds that an uploaded image is
 * untrusted content entering the system. That deferral is about **the Reader
 * quarantine**, and the quarantine's subject is a *turn's context window* —
 * `harness/reader.ts` exists because untrusted text next to `MEMORY.md` is a
 * prompt-injection surface. Storing bytes is not that surface: they go client
 * → disk → client, and no turn ever sees them. So the honest place for the
 * gate is the path that would feed an attachment to Claude, and that path does
 * not exist yet. Putting an `admin` scope here instead would be security
 * theatre in the wrong file — it would not protect a context window, and it
 * would break the phone.
 *
 * What genuinely bounds this surface is therefore the store: an allowlist,
 * magic-byte sniffing, a size ceiling, and a server-generated name. Not a
 * scope.
 */

/**
 * How large a request body this route accepts.
 *
 * **Derived from the store's ceiling, not chosen beside it.** Base64 is four
 * bytes out for every three in, plus the JSON scaffolding around it. A
 * middleware limit picked independently would either refuse files the store
 * would have accepted — a `413` with no explanation, from a layer the client
 * cannot see — or accept bodies the store then refuses after they have already
 * crossed the tunnel.
 */
export const UPLOAD_BODY_LIMIT_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4096;

/** Base64, standard alphabet, optional padding. Nothing else decodes. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const KINDS: readonly AttachmentKind[] = ["image", "video"];
const VARIANTS: readonly AttachmentVariant[] = ["original", "thumb"];

/**
 * Turn a store refusal into the right contract failure.
 *
 * Every validation code becomes `VALIDATION_FAILED` carrying the store's own
 * name for the problem in `details.reason`. The `ErrorCode` enum is the
 * contract and is not extended for this — but "your file is too large" and
 * "your file is not what you said it was" need different fixes from the
 * client, so the distinction has to survive somewhere, and `details` is where
 * the contract already puts it.
 */
function asFailure(error: unknown): never {
  if (error instanceof AttachmentError) {
    if (error.code === "already-attached") {
      throw new ApiFailure("CONFLICT", error.message, {
        details: { field: "attachmentIds", reason: error.code },
      });
    }
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: fieldFor(error.code), reason: error.code },
    });
  }
  throw error;
}

/** Which request field the caller should look at. */
function fieldFor(code: AttachmentError["code"]): string {
  switch (code) {
    case "empty":
    case "too-large":
    case "unsupported-type":
      return "data";
    case "mime-mismatch":
      return "mimeType";
    case "kind-mismatch":
      return "kind";
    case "dimensions-unknown":
      return "width";
    case "duration-unknown":
      return "durationMs";
    case "unknown-attachment":
    case "already-attached":
      return "attachmentIds";
  }
}

/** Read one field off a body that arrived as `unknown`. */
function field(body: unknown, name: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  // Safe assertion: guarded immediately above, and the value is re-tested by
  // every caller before it is used.
  return (body as Record<string, unknown>)[name];
}

function requireKind(body: unknown): AttachmentKind {
  const value = field(body, "kind");
  const match = KINDS.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "kind must be image or video.", {
      details: { field: "kind", reason: `must be one of ${KINDS.join(", ")}` },
    });
  }
  return match;
}

function requireMimeType(body: unknown): string {
  const value = field(body, "mimeType");
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", "mimeType is required.", {
      details: { field: "mimeType", reason: "must be a non-empty string" },
    });
  }
  return value;
}

/**
 * Decode the file, or refuse.
 *
 * `Buffer.from(x, "base64")` is famously forgiving: it skips anything outside
 * the alphabet and hands back whatever it managed to assemble. That turns a
 * client bug — a data-URI prefix, a URL-safe alphabet, a truncated upload —
 * into a *corrupt file* rather than an error, and the caller's next clue is
 * `unsupported-type` on bytes they believe are a perfectly good PNG. So the
 * shape is checked before the decode, and the two most likely mistakes are
 * named.
 */
function requireData(body: unknown): Buffer {
  const value = field(body, "data");
  if (typeof value !== "string" || value === "") {
    throw new ApiFailure("VALIDATION_FAILED", "data is required.", {
      details: { field: "data", reason: "must be a non-empty base64 string" },
    });
  }
  if (value.startsWith("data:")) {
    throw new ApiFailure("VALIDATION_FAILED", "data must be base64, not a data URI.", {
      details: { field: "data", reason: "strip the `data:<mime>;base64,` prefix" },
    });
  }
  if (!BASE64.test(value)) {
    throw new ApiFailure("VALIDATION_FAILED", "data is not base64.", {
      details: { field: "data", reason: "standard alphabet, no whitespace, no URL-safe variant" },
    });
  }
  return Buffer.from(value, "base64");
}

/** An optional positive integer, refused rather than coerced. */
function optionalInteger(body: unknown, name: string, minimum: number): number | undefined {
  const value = field(body, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ApiFailure("VALIDATION_FAILED", `${name} must be a whole number.`, {
      details: { field: name, reason: `must be an integer of at least ${String(minimum)}` },
    });
  }
  return value;
}

/** Validate the path id before it reaches a query. */
function attachmentIdOf(request: Request): string {
  const raw = request.params["attachmentId"];
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "attachment")) {
    throw new ApiFailure("NOT_FOUND", "That is not an attachment id.");
  }
  return id;
}

/** Which file the caller wants. Refused rather than defaulted on a typo. */
function variantOf(request: Request): AttachmentVariant {
  const raw = request.query["variant"];
  if (raw === undefined) return "original";
  const match = VARIANTS.find((candidate) => candidate === raw);
  if (match === undefined) {
    // A `variant=thumbnail` read as "original" hands back four megabytes to a
    // caller who asked for sixty kilobytes and cannot tell that it happened.
    throw new ApiFailure("VALIDATION_FAILED", "variant must be original or thumb.", {
      details: { field: "variant", reason: `must be one of ${VARIANTS.join(", ")}` },
    });
  }
  return match;
}

export interface AttachmentRouterOptions {
  readonly attachments: AttachmentStore;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createAttachmentRouter(options: AttachmentRouterOptions): Router {
  const { attachments, idempotency, authenticate } = options;
  const router = Router();

  // The Commander's own pictures, in the Commander's own conversation. A
  // `device` token is enough for both — see the module note.
  router.use("/attachments", authenticate);

  router.post("/attachments", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent<Attachment>(idempotency, request, () => {
        // Parsed here, inside the idempotent body, so a replayed upload never
        // re-decodes thirteen megabytes of base64 to answer from the ledger.
        const kind = requireKind(request.body);
        const declaredMime = requireMimeType(request.body);
        const data = requireData(request.body);
        const width = optionalInteger(request.body, "width", 1);
        const height = optionalInteger(request.body, "height", 1);
        const durationMs = optionalInteger(request.body, "durationMs", 0);

        try {
          // No business logic here: the route reads the request and the store
          // decides everything about the file. Every refusal below comes from
          // the store's own vocabulary.
          const stored = attachments.create({
            kind,
            declaredMime,
            data,
            width,
            height,
            durationMs,
          });
          return { status: 201, data: toAttachment(stored) };
        } catch (error) {
          asFailure(error);
        }
      }),
    );
  });

  router.get("/attachments/:attachmentId", (request, response) => {
    const id = attachmentIdOf(request);
    const variant = variantOf(request);
    const row = attachments.get(id);
    if (row === null) throw new ApiFailure("NOT_FOUND", "There is no such attachment.");

    const opened = attachments.open(id, variant);
    if (opened === null) {
      // Covers "no thumbnail was generated" and "the blob is missing". Both
      // are honestly a 404 for the thing that was asked for, and neither may
      // silently fall back to the original — a fallback would turn a 60 KB
      // request into a 4 MB one on the connection least able to afford it,
      // invisibly.
      throw new ApiFailure(
        "NOT_FOUND",
        variant === "thumb"
          ? "That attachment has no thumbnail. Read `hasThumbnail` before asking for one."
          : "That attachment's bytes are not on this machine.",
      );
    }

    // Immutable by construction: an id addresses one set of bytes forever, and
    // nothing rewrites a blob. That makes a long max-age honest rather than
    // optimistic, and it is worth real seconds on a cellular re-render.
    // `private` because the bytes are behind a bearer token and must not sit
    // in anything shared.
    const etag = `"${row.sha256}${variant === "thumb" ? "-thumb" : ""}"`;
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    // Nothing here is ever interpreted as anything but its declared type, and
    // nothing here is ever a document. Cheap, and the class of bug it forecloses
    // — a stored file that executes when a browser looks at it — is expensive.
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Content-Disposition", "inline");

    if (request.headers["if-none-match"] === etag) {
      opened.stream.destroy();
      response.status(304).end();
      return;
    }

    response.setHeader("Content-Type", opened.mimeType);
    response.setHeader("Content-Length", String(opened.bytes));

    // The file vanished between `open` and the first read — a `rm` on the blob
    // directory, a restored backup. Headers are already out by then, so the
    // only honest answer is to break the connection rather than append an
    // error envelope to a half-sent image.
    opened.stream.on("error", () => {
      if (response.headersSent) response.destroy();
      else sendFailure(response, new ApiFailure("INTERNAL", "That attachment could not be read."));
    });
    opened.stream.pipe(response);
  });

  return router;
}
