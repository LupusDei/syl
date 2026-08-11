import type { ApiKeyService } from "./api-key-service.js";

/**
 * Syl's own credential: minted by the service, for the service, at boot.
 *
 * ## Why she needs one at all
 *
 * Her tools call Syl's own HTTP API over loopback rather than reaching into
 * `ReminderService` in process — validation, idempotency, quiet-hours deferral
 * and the store's CHECK constraints are enforced at the API boundary, and a
 * second path into the same data would have to re-implement every one of them.
 * One door. Which means she has to queue at it like everyone else, and to do
 * that she needs a token.
 *
 * ## Why it is not the phone's token
 *
 * Three separate reasons, and each on its own would be enough:
 *
 * - **Attribution.** Her actions would be indistinguishable from his in the
 *   log, which makes "what did she do on my machine" unanswerable.
 * - **Revocation.** Taking her hands away would mean unpairing his phone.
 * - **Capability.** A device token can pair another device and reach every
 *   surface in the contract. She must never be able to do either.
 *
 * ## Why it cannot be escalated into over the network
 *
 * The same argument `admin` makes, one step stronger. `POST /auth/pair` always
 * mints `device` and `pair()` takes no scope argument at all, so no future
 * route is one refactor away from accepting one. `admin` comes from a console
 * command that needs write access to `syl.db`. And `agent` comes from *this
 * function*, which is called by `bootstrap` and by nothing else — there is no
 * route, no CLI flag and no frame that reaches it. **No code path in this
 * service puts an agent token onto a socket**, so obtaining one remotely is not
 * a matter of finding a guard that is missing; there is nothing to find.
 *
 * ## Why every boot mints a new one
 *
 * Because the alternative does not exist. `api_keys` stores only the SHA-256 of
 * a token — that is the property that makes a stolen copy of `syl.db` worthless
 * — so the plaintext of the key a previous process minted died with that
 * process. A surviving row is not a credential anybody can present; it is a
 * hash. "Reuse the existing one" is not a decision that was rejected, it is not
 * available.
 *
 * The one thing that follows from that is worth doing deliberately rather than
 * leaving to accumulate: the stale rows are **revoked**, not left live. A live
 * key nobody holds is indistinguishable, in the key list, from a live key
 * somebody does, and "how many of Syl's credentials are outstanding" should
 * have the answer one.
 *
 * The alternative — writing the plaintext beside the database so it could
 * survive a restart — was rejected. It would turn *read* access to the service's
 * state directory into a working credential for writing the Commander's
 * reminders, where today read access to `syl.db` yields nothing presentable at
 * all. Rotating on every boot costs one row and gains a secret that exists only
 * in memory.
 */

/** What the key list shows for her. Not a device; say so plainly. */
export const AGENT_KEY_LABEL = "Syl (her own hands)";

/** Why a previous boot's key was cut off. Stored on the row. */
export const SUPERSEDED_AT_BOOT = "superseded at boot: the token it hashes died with that process";

/** The credential this process holds, and nothing else does. */
export interface AgentCredential {
  /**
   * The bearer token, in memory only.
   *
   * Never logged, never serialised into a response, never written beside the
   * database. It reaches exactly one place — the loopback client in
   * `tools/client.ts` — and the MCP configuration handed to the commander lane.
   */
  readonly token: string;
  /** The row's id, which is the handle for revoking her. */
  readonly keyId: string;
  /** When the token stops working on its own. */
  readonly expiresAt: string | null;
  /** How many stale agent keys this boot cut off. Normally one after a restart. */
  readonly superseded: number;
}

export interface EnsureAgentKeyOptions {
  readonly keys: ApiKeyService;
}

/**
 * Make sure this process holds a working `agent` credential.
 *
 * Supersedes any agent key a previous boot left behind, mints a fresh one, and
 * returns it. Idempotent in the only sense that matters: called twice, the
 * store still holds exactly one live agent key afterwards.
 *
 * @throws if the store refuses the mint, which would mean the schema predates
 * `0015_agent_scope.sql`. Failing loudly is correct — a service that came up
 * without hands would answer every request and quietly do nothing.
 */
export function ensureAgentKey(options: EnsureAgentKeyOptions): AgentCredential {
  const { keys } = options;

  // Before the mint, so a failure to revoke cannot leave two live keys.
  const stale = keys.liveKeysWithScope("agent");
  for (const key of stale) keys.revoke(key.id, SUPERSEDED_AT_BOOT);

  const grant = keys.mint(AGENT_KEY_LABEL, { scope: "agent" });
  const minted = keys.liveKeysWithScope("agent")[0];
  if (minted === undefined) {
    throw new Error(
      "Minted an agent key and the store reports none live. The schema is older than " +
        "0015_agent_scope.sql, or something revoked it in between.",
    );
  }

  return {
    token: grant.token,
    keyId: minted.id,
    expiresAt: minted.expiresAt,
    superseded: stale.length,
  };
}
