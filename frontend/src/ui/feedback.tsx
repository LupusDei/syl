import type { ReactElement, ReactNode } from "react";

import type { AdminApiError } from "../api/errors";

/**
 * The three things every viewer has to say when it has no rows to show, said
 * the same way in each of them.
 *
 * The error notice is deliberately the loudest thing on the page. This surface
 * is an instrument: a panel that is empty because the request failed and a
 * panel that is empty because there is nothing to show must never look alike.
 */

export function Loading({ label = "Loading…" }: { label?: string }): ReactElement {
  return (
    <p className="feedback" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="feedback feedback--empty">{children}</p>;
}

export interface ErrorNoticeProps {
  readonly error: AdminApiError;
  readonly onRetry?: (() => void) | undefined;
}

export function ErrorNotice({ error, onRetry }: ErrorNoticeProps): ReactElement {
  return (
    <div className="notice notice--fail" role="alert">
      <div className="notice__head">
        <strong>{headline(error)}</strong>
        {onRetry !== undefined && (
          <button className="button" type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
      <p className="notice__body">{error.message}</p>
      <p className="notice__meta mono">
        {error.kind}
        {error.status !== null && ` · HTTP ${error.status}`}
        {error.retryable ? " · retryable" : " · not retryable"}
        {error.retryAfterMs !== null && ` · retry after ${error.retryAfterMs}ms`}
      </p>
    </div>
  );
}

/**
 * What the operator should do about it, in four words.
 *
 * The taxonomy exists so this can be honest: a malformed response is a
 * contract problem and a network failure is a tunnel problem, and telling
 * someone "request failed" for both wastes the debugging session this surface
 * is meant to shorten.
 */
function headline(error: AdminApiError): string {
  switch (error.kind) {
    case "api":
      return `Syl refused: ${error.code ?? "unknown code"}`;
    case "network":
      return "No answer from Syl";
    case "malformed":
      return "Syl answered with something off-contract";
    default:
      return "Something threw";
  }
}
