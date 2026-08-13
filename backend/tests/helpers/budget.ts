import { HEAVY_TIMEOUT_MS } from "../../../vitest.shared.js";

/**
 * How long a test HELPER waits before it gives up and says so itself.
 *
 * Every deadline inside a helper — waiting for a service to bind, for an MCP
 * server to answer its handshake, for a log line to be flushed — is answering
 * the same question, and every one of them used to answer it with its own
 * number: 10 000 here, 30 000 there, `sleep 0.6` somewhere else. Those numbers
 * were all measured on an idle machine, which is why the suite went red in a
 * different place on every loaded run.
 *
 * There is one number now, and it is DERIVED from the budget the heavy pass
 * gives a whole test rather than retyped beside it. A third of that budget,
 * because a helper's deadline has to expire strictly BEFORE vitest's: whoever
 * gives up first writes the error message, and "the MCP server did not answer
 * tools/call within 40000ms; stderr: ..." is a diagnosis where "Test timed out
 * in 120000ms" is only a symptom. A third leaves room for two such waits in one
 * test and still gets the useful message out.
 *
 * Raising the class budget in `vitest.shared.ts` therefore raises these with
 * it, which is the property that was missing: a cap that was generous on an
 * idle laptop is not generous on a machine running five agents.
 */
export const HELPER_DEADLINE_MS = Math.floor(HEAVY_TIMEOUT_MS / 3);
