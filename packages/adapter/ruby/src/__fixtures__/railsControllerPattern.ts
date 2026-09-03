// Rails' own controller-action vocabulary, the same values a project's
// pack config would supply. None of these strings appear anywhere in
// the adapter's own source.

import type { RailsControllerAction, RubyPack } from "../pack.js";

const RESTFUL_ACTIONS: RailsControllerAction["actions"] = {
  index: { method: "GET", pathTemplate: "/:resource" },
  show: { method: "GET", pathTemplate: "/:resource/:id" },
  new: { method: "GET", pathTemplate: "/:resource/new" },
  create: { method: "POST", pathTemplate: "/:resource" },
  edit: { method: "GET", pathTemplate: "/:resource/:id/edit" },
  update: { method: "PATCH", pathTemplate: "/:resource/:id" },
  destroy: { method: "DELETE", pathTemplate: "/:resource/:id" },
};

export function railsControllerActionPattern(
  overrides: Partial<RailsControllerAction> = {},
): RailsControllerAction {
  return {
    type: "railsControllerAction",
    // Every Rails app scaffolds this class; the library's own base
    // comes one hop further up, past what a project reader can open.
    baseClassNames: ["ApplicationController"],
    root: "/app/controllers",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: ["ActionController::Base", "ActionController::API"],
    actions: RESTFUL_ACTIONS,
    defaultStatusCode: 200,
    ...overrides,
  };
}

export function railsTestPack(
  overrides: Partial<RailsControllerAction> = {},
): RubyPack {
  return {
    name: "rails",
    protocol: "http",
    discovery: [railsControllerActionPattern(overrides)],
  };
}
