import type { ReactElement } from "react";

import { token, type SemanticToken } from "../theme/tokens";
import { NAV_ITEMS, type NavItem, type NavStatus } from "./nav";

/**
 * The landing view. Deliberately small: it says what is wired, what is not,
 * and which bead owns each section.
 */
export function OverviewView(): ReactElement {
  return (
    <section className="view">
      <h1 className="view__title">Overview</h1>
      <p className="view__lede">
        A development instrument, not a product surface. Every shape it renders comes from the
        OpenAPI contract in <code>shared/</code>; nothing here describes a payload of its own.
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

/**
 * A section that is routed and navigable but has no viewer behind it yet.
 *
 * Every section currently has one, so this is the fallback for the *next* one
 * added: `App.tsx` falls back to it for any nav path with no entry in `VIEWS`,
 * which keeps the sidebar and the route table from drifting apart while a
 * viewer is being built.
 */
export function PlaceholderView({ item }: { item: NavItem }): ReactElement {
  return (
    <section className="view">
      <h1 className="view__title">{item.label}</h1>
      <p className="view__lede">{item.summary}</p>
      <div className="notice">
        Not built yet — owned by bead <code>{item.bead}</code>.
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
