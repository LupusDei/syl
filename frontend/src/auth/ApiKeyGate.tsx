import { useId, useState, type FormEvent, type ReactElement } from "react";

import { API_BASE_URL } from "../api/base-url";
import { useAuth } from "./AuthProvider";

/**
 * The whole of authentication: paste the admin API key, and it is sent as a
 * bearer header from then on. There is no login round-trip because there is no
 * contract yet to round-trip against — the key is accepted locally and the
 * first rejected request signs the operator back out.
 */
export function ApiKeyGate(): ReactElement {
  const { signIn } = useAuth();
  const [value, setValue] = useState("");
  const fieldId = useId();
  const canSubmit = value.trim().length > 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;
    signIn(value);
  }

  return (
    <main className="gate">
      <form className="gate__card" aria-label="Connect to Syl" onSubmit={handleSubmit}>
        <h1 className="gate__title">Syl admin</h1>
        <p className="gate__lede">
          A development instrument for inspecting jobs, delivery and conversations. Not a product
          surface.
        </p>

        <label className="field__label" htmlFor={fieldId}>
          API key
        </label>
        <input
          id={fieldId}
          className="field__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />

        <p className="gate__target">
          Sent as a bearer header to <code data-testid="api-base-url">{API_BASE_URL}</code>. Stored
          in this browser only; clear it any time from the header.
        </p>

        <button className="button button--primary" type="submit" disabled={!canSubmit}>
          Connect
        </button>
      </form>
    </main>
  );
}
