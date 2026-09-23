// The controller-action values the Rails pack supplies. The adapter's own
// source contains none of these strings.

import type { ControllerActions, RubyPack } from "../pack.js";

export function controllerActionsPattern(
  overrides: Partial<ControllerActions> = {},
): ControllerActions {
  return {
    type: "controllerActions",
    // Rails generates this class in every app. The library's own base class
    // is one step further up, in a gem the adapter does not read.
    baseClassNames: ["ApplicationController"],
    root: "/app/controllers",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: ["ActionController::Base", "ActionController::API"],
    defaultStatusCode: 200,
    routesFile: "/config/routes.rb",
    routeFor: () => null,
    ...overrides,
  };
}

export function railsTestPack(
  overrides: Partial<ControllerActions> = {},
): RubyPack {
  return {
    name: "rails",
    protocol: "http",
    discovery: [controllerActionsPattern(overrides)],
  };
}
