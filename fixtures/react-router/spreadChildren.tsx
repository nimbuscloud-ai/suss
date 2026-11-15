// A feature area that exports its own routes, spread into the children
// of the route it lives under. The spread's routes are declared in
// another module, which this run does not enumerate.

import { createBrowserRouter } from "react-router-dom";

import { adminRoutes } from "./adminRoutes";
import { AdminHome, AdminShell } from "./pages";

export const adminRouter = createBrowserRouter([
  {
    path: "/admin",
    element: <AdminShell />,
    children: [{ index: true, element: <AdminHome /> }, ...adminRoutes],
  },
]);
