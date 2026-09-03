// Rails' own controller-action vocabulary, the same values a project's
// pack config would supply. None of these strings appear anywhere in
// the adapter's own source.

import type { ControllerActions, RubyPack } from "../pack.js";

export function controllerActionsPattern(
  overrides: Partial<ControllerActions> = {},
): ControllerActions {
  return {
    type: "controllerActions",
    // Every Rails app scaffolds this class; the library's own base
    // comes one hop further up, past what a project reader can open.
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
