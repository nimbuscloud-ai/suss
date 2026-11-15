// Routes behind a feature flag and routes mapped from a list, both
// written as expressions among a route's children. React Router skips
// a `false` child and flattens an array, so each one is a child route.

import { Route, Routes } from "react-router-dom";

import { DailyReport, Dashboard, Labs, LabsBeta, WeeklyReport } from "./pages";

const REPORT_ROUTES = [
  { path: "daily", Report: DailyReport },
  { path: "weekly", Report: WeeklyReport },
];

export function DashboardRoutes({ labsEnabled }: { labsEnabled: boolean }) {
  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />}>
        {labsEnabled && (
          <>
            <Route path="labs" element={<Labs />} />
            <Route path="labs/beta" element={<LabsBeta />} />
          </>
        )}
        {REPORT_ROUTES.map(({ path, Report }) => (
          <Route key={path} path={path} element={<Report />} />
        ))}
      </Route>
    </Routes>
  );
}
