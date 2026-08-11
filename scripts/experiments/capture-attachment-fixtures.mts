/**
 * Capture the attachment fixtures from the RUNNING service.
 *
 * Not hand-written from `shared/src/types.ts`: the point of a fixture is to
 * catch drift between our types and what actually goes on the wire, and a
 * fixture authored from the types cannot ever disagree with them.
 *
 * Boots the real service the way `main` does (`startLiveService`), pairs a
 * device over HTTP, uploads a real PNG, sends a message claiming it, and
 * writes each response body verbatim.
 *
 *     npx tsx scripts/experiments/capture-attachment-fixtures.mts
 *
 * Re-run it after any change to `Attachment`, and commit what it writes —
 * including the ids and instants, which are the service's own and are what
 * make the file evidence rather than an illustration.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startLiveService } from "../../backend/tests/helpers/live-service.js";

const FIXTURES = fileURLToPath(new URL("../../shared/fixtures", import.meta.url));

const CRC = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const b of body) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A real, decodable RGB PNG with a smooth gradient — a photo's shape. */
function png(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * (width * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = Math.floor((x / width) * 255);
      raw[off + 2 + x * 3] = Math.floor((y / height) * 255);
      raw[off + 3 + x * 3] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function write(name: string, body: unknown): void {
  writeFileSync(join(FIXTURES, name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${name}`);
}

const syl = await startLiveService();
try {
  const CONVERSATION = "syl:conversation:00000000-0000-7000-8000-000000000001";

  // A 24x24 gradient, small enough that its base64 is readable in a fixture
  // and real enough that the service's own sniffer and header parser accept it.
  const bytes = png(24, 24);
  const request = {
    kind: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
  };
  write("requests/create_attachment.json", request);

  const photo = png(1600, 1200);
  const created = await syl.api("/attachments", {
    method: "POST",
    idempotencyKey: "capture-attachment-1",
    body: JSON.stringify({ kind: "image", mimeType: "image/png", data: photo.toString("base64") }),
  });
  const createdBody = (await created.json()) as { data?: { id?: string } };
  console.log("POST /attachments ->", created.status);
  if (created.status !== 201) throw new Error(JSON.stringify(createdBody));
  write("http/attachment.image.json", createdBody);

  // A second one, so the message fixture shows a picture in place.
  const second = await syl.api("/attachments", {
    method: "POST",
    idempotencyKey: "capture-attachment-2",
    body: JSON.stringify({ kind: "image", mimeType: "image/png", data: photo.toString("base64") }),
  });
  const secondId = ((await second.json()) as { data: { id: string } }).data.id;

  const sent = await syl.api(`/conversations/${encodeURIComponent(CONVERSATION)}/messages`, {
    method: "POST",
    idempotencyKey: "capture-send-1",
    body: JSON.stringify({
      clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
      text: "Here is the shelf, after.",
      attachmentIds: [secondId],
    }),
  });
  console.log("POST message ->", sent.status, JSON.stringify(await sent.json()).slice(0, 160));

  const page = await syl.api(
    `/conversations/${encodeURIComponent(CONVERSATION)}/messages?limit=2`,
  );
  const pageBody = await page.json();
  write("http/messages.attachments.json", pageBody);

  // The refusal a mislabelled upload gets, captured rather than composed.
  const mismatched = await syl.api("/attachments", {
    method: "POST",
    idempotencyKey: "capture-attachment-bad",
    body: JSON.stringify({ kind: "image", mimeType: "image/jpeg", data: bytes.toString("base64") }),
  });
  console.log("mismatch ->", mismatched.status);
  write("errors/attachment_mime_mismatch.json", await mismatched.json());
} finally {
  await syl.close();
}
