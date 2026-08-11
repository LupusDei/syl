import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { ApiKeyGate } from "../auth/ApiKeyGate";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { ConversationsView } from "../features/conversations/ConversationsView";
import { DeliveryView } from "../features/delivery/DeliveryView";
import { DevicesView } from "../features/devices/DevicesView";
import { JobsView } from "../features/jobs/JobsView";
import { LogsView } from "../features/logs/LogsView";
import { MemoryView } from "../features/memory/MemoryView";
import { ThemeProvider } from "../theme/ThemeProvider";
import type { StorageLike } from "../storage";
import { AppLayout } from "./AppLayout";
import { ADMIN_BASENAME } from "./basename";
import { NAV_ITEMS } from "./nav";
import { NotFoundView, OverviewView, PlaceholderView } from "./views";

/**
 * Which nav paths have a viewer behind them. A path with no entry here still
 * routes — to the placeholder that names the bead that owns it — so the
 * sidebar and the route table cannot drift apart while the epic lands one
 * viewer at a time.
 */
const VIEWS: Readonly<Record<string, ReactElement>> = {
  "/jobs": <JobsView />,
  "/logs": <LogsView />,
  "/memory": <MemoryView />,
  "/delivery": <DeliveryView />,
  "/conversations": <ConversationsView />,
  "/devices": <DevicesView />,
};

/**
 * Routes that are not their own nav entry: a selection that lives in the URL
 * so it can be linked to and survive a reload.
 */
const DETAIL_ROUTES: readonly { readonly path: string; readonly element: ReactElement }[] = [
  { path: "/jobs/:jobId", element: <JobsView /> },
  { path: "/conversations/:conversationId", element: <ConversationsView /> },
];

/** The route table. Generated from `NAV_ITEMS` plus the detail routes above. */
export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewView />} />
        {NAV_ITEMS.filter((item) => item.path !== "/").map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={VIEWS[item.path] ?? <PlaceholderView item={item} />}
          />
        ))}
        {DETAIL_ROUTES.map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
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
        {/* Syl serves this bundle under a prefix; the router has to agree with
            the server about which one. See `basename.ts`. */}
        <BrowserRouter basename={ADMIN_BASENAME}>
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
