import { isIP } from "node:net";

/**
 * Which IP addresses Syl is allowed to open a connection to.
 *
 * The list below is longer than the usual "block RFC 1918" because Syl runs
 * inside a tailnet, and that changes the threat model in a way that is easy to
 * get wrong:
 *
 * **`100.64.0.0/10` is the one that matters.** Tailscale assigns addresses out
 * of the CGNAT range, so every machine on the Commander's tailnet — including
 * Syl's own API, Adjutant's backend, and his Mac — is reachable at a
 * `100.x.y.z` address that is neither loopback nor RFC 1918. A hostile article
 * that redirects to `http://100.100.42.7:4201/api/v1/...` reaches Syl's own
 * service *from inside her trust zone*, with whatever the fetch carries.
 *
 * Two entirely reasonable decisions made separately — "put the service on a
 * tailnet so it needs no public exposure" and "let Syl read articles the
 * Commander sends her" — combine into a bad one. Neither is wrong; the
 * combination is, and this file is where that is paid for.
 *
 * `169.254.169.254` deserves its own mention: the cloud metadata endpoint,
 * inside `169.254.0.0/16`, and historically the single most productive SSRF
 * target in existence.
 */

/** Why an address was refused, or `"public"` if it was not. */
export type AddressClass =
  | "public"
  | "malformed"
  | "loopback"
  | "private"
  | "carrier_grade_nat"
  | "link_local"
  | "unique_local"
  | "multicast"
  | "reserved";

interface V4Range {
  readonly cidr: string;
  readonly kind: AddressClass;
}

/**
 * Every IPv4 block Syl will not connect to.
 *
 * Ordered from most specific to least only for readability; matching checks
 * all of them.
 */
const V4_BLOCKS: readonly V4Range[] = [
  { cidr: "0.0.0.0/8", kind: "reserved" }, // "this network"
  { cidr: "10.0.0.0/8", kind: "private" },
  { cidr: "100.64.0.0/10", kind: "carrier_grade_nat" }, // Tailscale lives here
  { cidr: "127.0.0.0/8", kind: "loopback" },
  { cidr: "169.254.0.0/16", kind: "link_local" }, // includes cloud metadata
  { cidr: "172.16.0.0/12", kind: "private" },
  { cidr: "192.0.0.0/24", kind: "reserved" },
  { cidr: "192.0.2.0/24", kind: "reserved" }, // TEST-NET-1
  { cidr: "192.88.99.0/24", kind: "reserved" }, // 6to4 relay anycast
  { cidr: "192.168.0.0/16", kind: "private" },
  { cidr: "198.18.0.0/15", kind: "reserved" }, // benchmarking
  { cidr: "198.51.100.0/24", kind: "reserved" }, // TEST-NET-2
  { cidr: "203.0.113.0/24", kind: "reserved" }, // TEST-NET-3
  { cidr: "224.0.0.0/4", kind: "multicast" },
  { cidr: "240.0.0.0/4", kind: "reserved" }, // includes 255.255.255.255
];

/** Parse dotted-quad into a 32-bit unsigned integer. */
function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // `Number` rather than `parseInt`: "1abc" must not become 1, and a leading
    // zero must not be read as octal by anything downstream.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const PARSED_V4_BLOCKS = V4_BLOCKS.map((block) => {
  const [network, bits] = block.cidr.split("/");
  const base = v4ToInt(network ?? "");
  const prefix = Number(bits);
  if (base === null || !Number.isInteger(prefix)) {
    throw new Error(`Unparseable CIDR in the SSRF block list: ${block.cidr}`);
  }
  // `>>> 0` keeps the mask unsigned; a /0 would shift by 32, which is a no-op
  // in JavaScript, but no block here is /0.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { kind: block.kind, base: (base & mask) >>> 0, mask };
});

/** Classify an IPv4 address. */
function classifyV4(address: string): AddressClass {
  const value = v4ToInt(address);
  if (value === null) return "malformed";

  for (const block of PARSED_V4_BLOCKS) {
    if (((value & block.mask) >>> 0) === block.base) return block.kind;
  }
  return "public";
}

/** Expand an IPv6 address into its eight 16-bit groups. */
function v6Groups(address: string): number[] | null {
  let text = address;

  // A zone index (`fe80::1%en0`) is not part of the address.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // An IPv4-mapped or -embedded tail: ::ffff:192.168.0.1
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const value = v4ToInt(tail);
    if (value === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((value >>> 16) & 0xffff)
      .toString(16)
      .padStart(4, "0")}:${(value & 0xffff).toString(16).padStart(4, "0")}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? "");
  const rest = parse(halves[1] ?? "");
  if (head === null || rest === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const missing = 8 - head.length - rest.length;
  if (missing < 0) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest];
}

/** Classify an IPv6 address. */
function classifyV6(address: string): AddressClass {
  const groups = v6Groups(address);
  if (groups === null) return "malformed";

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // An IPv4-mapped address is an IPv4 address wearing a different notation.
  // `::ffff:127.0.0.1` must be refused for exactly the reasons `127.0.0.1` is;
  // treating the two differently is how a block list gets walked around.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyV4(
      [(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff].join("."),
    );
  }

  // NAT64 (64:ff9b::/96) embeds an IPv4 address the same way.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyV4(
      [(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff].join("."),
    );
  }

  const allZero = groups.every((group) => group === 0);
  if (allZero) return "reserved"; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return "loopback"; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return "unique_local"; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (g0 === 0x2002) return "reserved"; // 6to4, deprecated and v4-embedding

  return "public";
}

/**
 * Classify an IP address.
 *
 * Pure, so the whole block list is testable without opening a socket — which
 * matters, because the only other way to find out that `100.64.0.0/10` was
 * missing is for something to reach the tailnet.
 */
export function classifyAddress(address: string): AddressClass {
  switch (isIP(address)) {
    case 4:
      return classifyV4(address);
    case 6:
      return classifyV6(address);
    default:
      return "malformed";
  }
}

/** Whether Syl may open a connection to this address. */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}
