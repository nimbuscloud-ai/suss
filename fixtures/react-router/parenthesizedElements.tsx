// Routes whose element is written in parentheses, the way a formatter
// lays out an element that runs over several lines. The parentheses
// change nothing about what the route renders.

import { createBrowserRouter, Route, Routes } from "react-router-dom";

import { TeamPath } from "@acme/paths";

import { Audit, PageLoader, Profile, Team } from "./pages";

export function AccountRoutes() {
  return (
    <Routes>
      <Route
        path="/profile"
        element={(
          <Profile />
        )}
      />
    </Routes>
  );
}

// The second route's path is a member of an enum another package
// declares, which this run does not read.
export const accountRouter = createBrowserRouter([
  {
    path: "/audit",
    element: (
      <PageLoader>
        <Audit />
      </PageLoader>
    ),
  },
  {
    path: TeamPath.Members,
    element: (
      <PageLoader>
        <Team />
      </PageLoader>
    ),
  },
]);
