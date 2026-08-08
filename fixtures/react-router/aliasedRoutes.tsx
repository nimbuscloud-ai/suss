// The same declaration under a local name. A project that renames the
// import writes the same route, and the alias is the name the JSX is
// written with.

import { Route as AppRoute, Routes } from "react-router";

import { Reports } from "./pages";

export function ReportRoutes() {
  return (
    <Routes>
      <AppRoute path="/reports" element={<Reports />} />
    </Routes>
  );
}
