// Routes a function returns, once as the children of a route and once
// as the whole list a router is created from. The reader does not
// follow a call into the function, so it reads neither list.

import { createBrowserRouter } from "react-router-dom";

import {
  Calendar,
  EmbedWidget,
  NotificationSettings,
  PreferencesShell,
} from "./pages";

function preferenceRoutes() {
  return [{ path: "notifications", element: <NotificationSettings /> }];
}

function embedRoutes() {
  return [{ path: "/embed", element: <EmbedWidget /> }];
}

export const router = createBrowserRouter([
  { path: "/calendar", element: <Calendar /> },
  {
    path: "/preferences",
    element: <PreferencesShell />,
    children: preferenceRoutes(),
  },
]);

export function createEmbedRouter() {
  return createBrowserRouter(embedRoutes());
}
