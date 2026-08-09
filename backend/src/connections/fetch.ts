import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { classifyAddress, isPublicAddress, type AddressClass } from "./address-guard.js";

/**
 * Fetching things from the open internet, safely.
 *
 * Syl reads what the Commander sends her. That makes every fetch a request
 * whose destination was chosen by content she did not write, which is the
 * definition of an SSRF sink — and she sits on a tailnet where her own API,
 * Adjutant's backend, and his Mac are all reachable without any public
 * exposure. See `address-guard.ts` for why `100.64.0.0/10` is the block that
 * matters most.
 *
 * Three properties, and the third is the one usually missing:
 *
 * 1. **Only http and https.** `file:`, `gopher:`, `data:` are not fetches.
 * 2. **Every hop is re-checked, and a redirect may not change host.** A
 *    validated first request that follows a 302 to `100.100.42.7` has
 *    validated nothing.
 * 3. **The address that was validated is the address that is connected to.**
 *    Resolving a name, approving the answer, and then handing the *name* to
 *    the socket leaves a window in which DNS can answer differently the second
 *    time — the rebinding attack. A guarded `lookup` closes it, because the
 *    connection uses the address this module approved rather than resolving
 *    again.
 */

/** Why a fetch was refused. */
export type RefusalReason =
  | "scheme"
  | "malformed_url"
  | "dns"
  | "blocked_address"
  | "cross_host_redirect"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "transport";

/** Thrown for anything Syl declines to fetch, with the reason. */
export class FetchRefused extends Error {
  readonly reason: RefusalReason;
  /** For `blocked_address`, what the address was. */
  readonly addressClass: AddressClass | null;

  constructor(reason: RefusalReason, message: string, addressClass: AddressClass | null = null) {
    super(message);
    this.name = "FetchRefused";
    this.reason = reason;
    this.addressClass = addressClass;
  }
}

/** How long a single request may take. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How much body to read. An article is not a download. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** How many redirects to follow. All must stay on the same host. */
export const DEFAULT_MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Which addresses are acceptable. Defaults to {@link isPublicAddress}.
   *
   * Injected so tests can exercise the transport against a loopback server
   * without weakening the default — the guard itself is tested exhaustively
   * and separately, as a pure function.
   */
  readonly isAllowed?: (address: string) => boolean;
}

export interface FetchResult {
  /** The URL actually fetched, after any redirects. */
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
  /** Every URL in the chain, first to last. */
  readonly chain: readonly string[];
}

/**
 * A DNS lookup that refuses to answer with an address we will not connect to.
 *
 * This is what binds "the address we checked" to "the address we connect to".
 */
function guardedLookup(
  isAllowed: (address: string) => boolean,
): (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
) => void {
  return (hostname, options, callback) => {
    // Node calls `lookup` with `{ all: true }` when it wants every answer, and
    // expects an ARRAY back in that case. Returning a bare string regardless
    // fails with "Invalid IP address: undefined" — a message that names
    // neither DNS nor this function.
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options
        ? // Safe assertion: guarded by the `in` check, and coerced to boolean.
          Boolean((options as { all?: unknown }).all)
        : false;

    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(new FetchRefused("dns", `Cannot resolve ${hostname}.`), "");
        return;
      }

      // Every answer must be acceptable, not merely the first. A name that
      // resolves to one public address and one tailnet address is a name that
      // reaches the tailnet on the next connection.
      const rejected = addresses.find((entry) => !isAllowed(entry.address));
      if (rejected !== undefined) {
        callback(
          new FetchRefused(
            "blocked_address",
            `${hostname} resolves to ${rejected.address}, which is ${classifyAddress(
              rejected.address,
            )} and not somewhere Syl will connect.`,
            classifyAddress(rejected.address),
          ),
          "",
        );
        return;
      }

      const first = addresses[0];
      if (first === undefined) {
        callback(new FetchRefused("dns", `${hostname} resolved to nothing.`), "");
        return;
      }
      if (wantsAll) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

/**
 * A URL's host as a bare IP address, or `null` if it is a name.
 *
 * WHATWG `hostname` keeps the brackets on an IPv6 literal.
 */
function literalAddress(url: URL): string | null {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return isIP(host) === 0 ? null : host;
}

/** Parse and vet a URL's scheme, and its host if that host is a literal IP. */
function parseUrl(raw: string, isAllowed: (address: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("malformed_url", `${raw} is not a URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchRefused(
      "scheme",
      `${url.protocol} is not a scheme Syl fetches. Only http and https are.`,
    );
  }

  // A literal IP host NEVER reaches the guarded `lookup`: Node connects
  // directly when the host is already an address, so the hook that exists to
  // vet the destination is simply not called. `http://100.100.42.7:4201/`
  // would sail straight through. Checking here is what closes that.
  const literal = literalAddress(url);
  if (literal !== null && !isAllowed(literal)) {
    throw new FetchRefused(
      "blocked_address",
      `${literal} is ${classifyAddress(literal)} and not somewhere Syl will connect.`,
      classifyAddress(literal),
    );
  }

  return url;
}

/** One request, no redirect following. */
function once(
  url: URL,
  options: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxBytes">> & {
    readonly headers: Readonly<Record<string, string>>;
    readonly isAllowed: (address: string) => boolean;
  },
): Promise<{ response: IncomingMessage; body: string; bytes: number }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = send(
      url,
      {
        method: "GET",
        headers: options.headers,
        lookup: guardedLookup(options.isAllowed),
        timeout: options.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            // Destroying rather than reading and discarding: a caller that
            // asked for 5MB must not be made to receive 5GB first.
            response.destroy();
            reject(
              new FetchRefused(
                "too_large",
                `That response is larger than the ${options.maxBytes} bytes Syl will read.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({ response, body: Buffer.concat(chunks).toString("utf8"), bytes });
        });
        response.on("error", (error: Error) => reject(asRefusal(error)));
      },
    );

    request.on("timeout", () => {
      request.destroy(new FetchRefused("timeout", `That request took longer than ${options.timeoutMs}ms.`));
    });
    request.on("error", (error: Error) => reject(asRefusal(error)));
    request.end();
  });
}

/** Anything the transport throws becomes a refusal with a reason. */
function asRefusal(error: unknown): FetchRefused {
  if (error instanceof FetchRefused) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FetchRefused("transport", message);
}

/**
 * Fetch a URL, refusing anything that would reach inside the trust zone.
 *
 * @throws {FetchRefused}
 */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<FetchResult> {
  const isAllowed = options.isAllowed ?? isPublicAddress;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const perRequest = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.5", ...(options.headers ?? {}) },
    isAllowed,
  };

  let url = parseUrl(raw, isAllowed);
  const chain: string[] = [url.toString()];

  for (let hop = 0; ; hop += 1) {
    const { response, body, bytes } = await once(url, perRequest);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status < 300 || status >= 400 || location === undefined) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value.join(", ");
      }
      return { url: url.toString(), status, headers, body, bytes, chain };
    }

    if (hop >= maxRedirects) {
      throw new FetchRefused(
        "too_many_redirects",
        `That URL redirected more than ${maxRedirects} times.`,
      );
    }

    const next = parseUrl(new URL(location, url).toString(), isAllowed);

    // A cross-host redirect is refused outright rather than re-validated.
    // Re-validating would be *almost* enough, and "almost" is how a hostile
    // article gets a second attempt at picking a destination — including one
    // that resolves differently the moment it is connected to.
    if (next.host !== url.host) {
      throw new FetchRefused(
        "cross_host_redirect",
        `${url.host} redirected to ${next.host}. Syl does not follow a redirect to another host.`,
      );
    }

    url = next;
    chain.push(url.toString());
  }
}
