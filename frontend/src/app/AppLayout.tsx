import { useId, type ReactElement } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { API_BASE_URL } from "../api/base-url";
import { useAuth } from "../auth/AuthProvider";
import { useTheme } from "../theme/ThemeProvider";
import { isThemeName } from "../theme/tokens";
import { NAV_ITEMS } from "./nav";

/**
 * The persistent chrome: which backend we are pointed at, which palette is
 * active, a way to drop the key, and the section list. Everything below the
 * header is a routed view.
 */
export function AppLayout(): ReactElement {
  const { signOut } = useAuth();
  const { theme, themes, setTheme } = useTheme();
  const paletteId = useId();

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">Syl · admin</span>

        <span className="shell__target">
          API <code className="mono" data-testid="api-base-url">{API_BASE_URL}</code>
        </span>

        <span className="shell__spacer" />

        <label className="field field--inline" htmlFor={paletteId}>
          Palette
          <select
            id={paletteId}
            className="field__select"
            value={theme}
            onChange={(event) => {
              const next = event.target.value;
              // The <select> can only offer registered names, but narrowing
              // here keeps the guard next to the boundary rather than relying
              // on the markup staying honest.
              if (isThemeName(next)) setTheme(next);
            }}
          >
            {themes.map((option) => (
              <option key={option.name} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button className="button" type="button" onClick={signOut}>
          Clear key
        </button>
      </header>

      <div className="shell__body">
        <nav className="nav" aria-label="Sections">
          <ul className="nav__list">
            {NAV_ITEMS.map((item) => (
              <li key={item.path}>
                <NavLink
                  className={({ isActive }) => (isActive ? "nav__link nav__link--active" : "nav__link")}
                  to={item.path}
                  end={item.path === "/"}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="shell__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
