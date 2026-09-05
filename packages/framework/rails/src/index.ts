/**
 * @suss/framework-rails: RubyPack for Rails controller actions and the
 * routes `config/routes.rb` gives them.
 *
 * Every instance method a controller defines is one of its actions;
 * `config/routes.rb` decides which method and path answer it, read
 * here with the bounded grammar `routes.ts` describes. An action the
 * routes file does not reach is still discovered, with its calls
 * followed, only with no boundary. See the README for the rest.
 */

import path from "node:path";

import { z } from "zod";

import { underscoreConstantPath } from "@suss/adapter-ruby";

import { readRoutesFile } from "./routes.js";

import type { ControllerActions, RubyPack } from "@suss/adapter-ruby";
import type { Route } from "./routes.js";

/**
 * What `-f rails=config.json` may say. The CLI parses the file against
 * it before the factory runs.
 */
export const optionsSchema = z
  .object({
    /** The app directory a bare controller name is looked up under. Every Rails app scaffolds this at `app`. */
    root: z.string().optional(),
    /**
     * The directory a relative `root` or `routesFile` is read against: the
     * config file's own directory, or the directory the run reads when the
     * options came without one. The CLI supplies this; it is not written in
     * the file itself.
     */
    configDirectory: z.string().optional(),
    /** Base classes beyond `ApplicationController` that also mark a class as a controller. */
    baseClassNames: z.array(z.string()).optional(),
    /** Where this project's routes live, relative to `configDirectory` when there is one. Every Rails app scaffolds this at `config/routes.rb`. */
    routesFile: z.string().optional(),
  })
  .strict();

export type RailsPackOptions = z.infer<typeof optionsSchema>;

/**
 * The classes Rails' own generated `ApplicationController` extends.
 * A project's ancestry walk ends at one of them, so putting one in a
 * stub changes nothing.
 */
export const RAILS_ROOT_CLASS_NAMES: readonly string[] = [
  "ActionController::Base",
  "ActionController::API",
];

/** Method and path template for each of Rails' seven conventional actions, `:resource` filled in from the controller's own name. Used only when a project has no routes file to read instead. */
const RESTFUL_ACTIONS: Record<
  string,
  { method: string; pathTemplate: string }
> = {
  index: { method: "GET", pathTemplate: "/:resource" },
  show: { method: "GET", pathTemplate: "/:resource/:id" },
  new: { method: "GET", pathTemplate: "/:resource/new" },
  create: { method: "POST", pathTemplate: "/:resource" },
  edit: { method: "GET", pathTemplate: "/:resource/:id/edit" },
  update: { method: "PATCH", pathTemplate: "/:resource/:id" },
  destroy: { method: "DELETE", pathTemplate: "/:resource/:id" },
};

/** The routing key `config/routes.rb` gives a controller, from the class name the adapter reads: `Admin::OrdersController` -> `admin/orders`. */
function controllerKeyFromQualified(qualifiedName: string): string {
  const withoutSuffix = qualifiedName.endsWith("Controller")
    ? qualifiedName.slice(0, -"Controller".length)
    : qualifiedName;
  return underscoreConstantPath(withoutSuffix);
}

/** The path and method Rails' naming convention gives one of the seven conventional actions. Null for any other action name, since a naming convention says nothing about a custom one. */
function conventionalRoute(
  controllerKey: string,
  actionName: string,
): Route | null {
  const template = RESTFUL_ACTIONS[actionName];
  if (template === undefined) {
    return null;
  }
  const resource = controllerKey.split("/").pop() ?? controllerKey;
  return {
    method: template.method,
    path: template.pathTemplate.replace(":resource", resource),
  };
}

function resolveAgainst(
  configDirectory: string | undefined,
  value: string,
): string {
  if (configDirectory === undefined || path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(configDirectory, value);
}

export function railsFramework(options: RailsPackOptions = {}): RubyPack {
  const root = resolveAgainst(options.configDirectory, options.root ?? "app");
  const routesFile = resolveAgainst(
    options.configDirectory,
    options.routesFile ?? "config/routes.rb",
  );

  // Lazy: the WASM grammar this reads with loads once the adapter's own
  // file loop has started, and this pack is constructed before that.
  let table: ReturnType<typeof readRoutesFile> | undefined;
  const routeTable = () => {
    table ??= readRoutesFile(
      routesFile,
      options.routesFile ?? "config/routes.rb",
    );
    return table;
  };

  const pattern: ControllerActions = {
    type: "controllerActions",
    baseClassNames: [
      "ApplicationController",
      ...(options.baseClassNames ?? []),
    ],
    root,
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: [...RAILS_ROOT_CLASS_NAMES],
    defaultStatusCode: 200,
    routesFile,
    routeFor: (controllerQualifiedName, actionName) => {
      const key = controllerKeyFromQualified(controllerQualifiedName);
      const found = routeTable();
      // A routes file that exists is the source of truth: an action it
      // does not reach is unbound, not filled in from the convention.
      return found.fileFound
        ? found.routeFor(key, actionName)
        : conventionalRoute(key, actionName);
    },
    routingGaps: () => routeTable().gaps,
  };

  return {
    name: "rails",
    protocol: "http",
    discovery: [pattern],
    // The routes file decides every action's method and path but is
    // never walked, so the cache key has to read it here.
    discoveryInputs: () => [routesFile],
  };
}

export default railsFramework;
