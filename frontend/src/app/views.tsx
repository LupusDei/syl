import type { ReactElement } from "react";

import { token, type SemanticToken } from "../theme/tokens";
import { NAV_ITEMS, type NavItem, type NavStatus } from "./nav";

/**
 * The landing view. Deliberately small: it says what is wired, what is not,
 * and which bead owns each gap. The viewers themselves are `syl-004.2.*` and
 * are blocked on the API contract.
 */
export function OverviewView(): ReactElement {
  return (
    <section className="view">
      <h1 className="view__title">Overview</h1>
      <p className="view__lede">
        The admin shell is up. The viewers below land as their beads close — each one needs the
        OpenAPI contract in <code>shared/</code>, which is being written now.
      </p>

      <table className="table">
        <caption className="table__caption">Sections</caption>
        <thead>
          <tr>
            <th scope="col">Section</th>
            <th scope="col">State</th>
            <th scope="col">Bead</th>
            <th scope="col">What it will show</th>
          </tr>
        </thead>
        <tbody>
          {NAV_ITEMS.map((item) => (
            <tr key={item.path}>
              <th scope="row">{item.label}</th>
              <td>
                <StatusDot status={item.status} />
              </td>
              <td className="mono">{item.bead}</td>
              <td className="table__prose">{item.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A section that is routed and navigable but has no data behind it yet. */
export function PlaceholderView({ item }: { item: NavItem }): ReactElement {
  return (
    <section className="view">
      <h1 className="view__title">{item.label}</h1>
      <p className="view__lede">{item.summary}</p>
      <div className="notice">
        Not built yet — owned by bead <code>{item.bead}</code>, which is blocked on the API
        contract.
      </div>
    </section>
  );
}

export function NotFoundView(): ReactElement {
  return (
    <section className="view">
      <h1 className="view__title">Not found</h1>
      <p className="view__lede">No section is routed at this path.</p>
    </section>
  );
}

/**
 * Which semantic token colours each state. Naming the token rather than a
 * colour is the convention for anything styled from TypeScript: the value is a
 * `var(--syl-…)` string the browser resolves, so it follows a palette swap
 * with no re-render.
 */
const STATUS_TOKEN: Record<NavStatus, SemanticToken> = {
  ready: "stateOk",
  planned: "statePending",
};

function StatusDot({ status }: { status: NavStatus }): ReactElement {
  return (
    <span className="status">
      <span
        className="status__dot"
        style={{ background: token[STATUS_TOKEN[status]] }}
        aria-hidden="true"
      />
      {status === "ready" ? "live" : "planned"}
    </span>
  );
}
