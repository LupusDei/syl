import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { ApiKeyGate } from "../auth/ApiKeyGate";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { ThemeProvider } from "../theme/ThemeProvider";
import type { StorageLike } from "../storage";
import { AppLayout } from "./AppLayout";
import { NAV_ITEMS } from "./nav";
import { NotFoundView, OverviewView, PlaceholderView } from "./views";

/**
 * The route table. Generated from `NAV_ITEMS` so the sidebar and the routes
 * cannot drift apart; the viewers each replace one `PlaceholderView` when
 * their bead lands.
 */
export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewView />} />
        {NAV_ITEMS.filter((item) => item.path !== "/").map((item) => (
          <Route key={item.path} path={item.path} element={<PlaceholderView item={item} />} />
        ))}
        <Route path="*" element={<NotFoundView />} />
      </Route>
    </Routes>
  );
}

/** Gate or chrome. Must sit inside `AuthProvider`. */
export function AppShell(): ReactElement {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <AppRoutes /> : <ApiKeyGate />;
}

export interface AppProps {
  /** Injectable so tests never touch the real `localStorage`. */
  storage?: StorageLike | undefined;
}

export function App({ storage }: AppProps): ReactElement {
  return (
    <ThemeProvider storage={storage}>
      <AuthProvider storage={storage}>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
