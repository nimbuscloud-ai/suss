// A router created from routes another package declares, cast to the
// router's own type because the package types them loosely. The routes
// are not written in this project, so none of them are read.

import { createBrowserRouter, type RouteObject } from "react-router-dom";

import { pluginRoutes } from "@acme/plugins";

export const pluginRouter = createBrowserRouter(pluginRoutes as RouteObject[]);
