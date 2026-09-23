/**
 * Reads Rails controller actions and the routes `config/routes.rb` gives
 * them. Every public instance method a controller defines is an action,
 * and the routes file sets the method and path that reach it. The routes
 * module reads that file with a fixed grammar.
 *
 * An action the routes file does not reach is still discovered and its
 * calls followed, with no boundary. The README covers the rest.
 */

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { underscoreConstantPath } from "@suss/adapter-ruby";

import {
  engineSourceFiles,
  expandPathPattern,
  readEngines,
} from "./engines.js";
import { inflectionFiles, readInflections } from "./inflections.js";
import { drawDirectoryOf, readRoutes } from "./routes.js";
import { RACK_STATUS_CODE_NAMES } from "./statusCodes.js";

import type {
  ControllerActions,
  RbInflections,
  RubyPack,
} from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";
import type { Route, RoutesInput } from "./routes.js";

/**
 * The CLI checks a `-f rails=config.json` file against this schema. A
 * config file may not set a key that only a dependency stub fills.
 */
export const optionsSchema = z
  .object({
    /**
     * The directory a bare controller name is looked up under, `app` in a
     * scaffolded Rails app.
     */
    root: z.string().optional(),
    /**
     * The CLI fills this in with the config file's directory, or with the
     * directory the run reads when there is no file. A relative `root` or
     * `routesFile` resolves against it. A config file does not set it.
     */
    configDirectory: z.string().optional(),
    /**
     * Base classes beyond `ApplicationController` whose subclasses are
     * controllers. A config file may not set this; a dependency stub
     * fills it.
     */
    baseClassNames: z.array(z.string()).optional(),
    /**
     * Controller methods a gem such as Devise adds, beyond the ones Rails
     * defines. They are left off an action's effects the same way Rails'
     * own are.
     */
    inheritedMethodNames: z.array(z.string()).optional(),
    /**
     * The routes file, `config/routes.rb` in a scaffolded app. A relative
     * path resolves against `configDirectory` when there is one.
     */
    routesFile: z.string().optional(),
    /**
     * Directories that each contain an engine, with its `Rails::Engine`
     * class under `lib/` and its routes in `config/routes.rb`. A `*` in a
     * segment matches any one directory, so `plugins/*` covers every
     * plugin. Relative paths resolve against `configDirectory`.
     */
    engineRoots: z.array(z.string()).optional(),
    /**
     * Other files that add routes through a `Rails.application.routes.draw`,
     * `.append` or `.prepend` block, most often a plugin's `plugin.rb`.
     * They take `*` the same way `engineRoots` does, and relative paths
     * resolve against `configDirectory`.
     */
    routesFiles: z.array(z.string()).optional(),
  })
  .strict();

export type RailsPackOptions = z.infer<typeof optionsSchema>;

/**
 * The classes Rails' generated `ApplicationController` extends. The
 * ancestry walk stops at these, so a stub statement for one adds nothing,
 * and `suss infer stub` skips them.
 */
export const RAILS_ROOT_CLASS_NAMES: readonly string[] = [
  "ActionController::Base",
  "ActionController::API",
];

/**
 * The naming-convention fallback, used only when the project has no
 * routes file. `:resource` is filled in from the controller's name.
 */
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

/**
 * `render` takes the status as `status:`, `head` takes it first or as the
 * keyword, and both redirects take the keyword. A redirect with no status
 * sends 302, where `render` and `head` default to 200.
 */
const RESPONSE_STATUS_CALLS = [
  { name: "render", statusKeyword: "status" },
  { name: "head", statusArgument: 0, statusKeyword: "status" },
  { name: "redirect_to", statusKeyword: "status", defaultStatusCode: 302 },
  { name: "redirect_back", statusKeyword: "status", defaultStatusCode: 302 },
];

/**
 * A `before_action` runs before the action and ends the request when its
 * method responds. `only:` and `except:` limit it to some actions, and
 * `skip_before_action` removes it again. A `rescue_from` handler runs
 * only after the action raised.
 */
const CONTROLLER_FILTERS = [
  {
    name: "before_action",
    methodFrom: "argument" as const,
    skippedBy: "skip_before_action",
    actionKeywords: { include: "only", exclude: "except" },
  },
  {
    name: "rescue_from",
    methodFrom: "withKeyword" as const,
    onThrow: true,
  },
];

/**
 * Instance methods `ActionController::Base` and `ActionController::API`
 * give every controller. A call to one reaches nothing in the project, so
 * it is left off the action's effects. A helper a gem adds, such as
 * Devise's `current_user`, comes in through `inheritedMethodNames`.
 */
const RAILS_CONTROLLER_METHODS = [
  "params",
  "request",
  "response",
  "session",
  "cookies",
  "flash",
  "headers",
  "render",
  "head",
  "redirect_to",
  "redirect_back",
  "respond_to",
  "render_to_string",
  "url_for",
  "helpers",
  "logger",
  "action_name",
  "controller_name",
  "controller_path",
];

/**
 * ActiveSupport calls whose block runs as part of the class or module
 * body it is written in. `included`, `prepended` and `class_methods`
 * exist only on a concern, and a `def` inside `class_methods` is a class
 * method. The README explains what each call does with its block.
 */
const BODY_BLOCKS = [
  { name: "included", moduleOnly: true },
  { name: "prepended", moduleOnly: true },
  { name: "class_methods", moduleOnly: true, definesClassMethods: true },
  { name: "concerning" },
  { name: "with_options" },
];

const EMPTY_INFLECTIONS: Required<RbInflections> = {
  acronyms: [],
  irregular: [],
  uncountable: [],
  singular: [],
};

/** The routing key for a controller class: `Admin::OrdersController` becomes `admin/orders`. */
function controllerKeyFromQualified(
  qualifiedName: string,
  acronyms: readonly string[],
): string {
  const withoutSuffix = qualifiedName.endsWith("Controller")
    ? qualifiedName.slice(0, -"Controller".length)
    : qualifiedName;
  return underscoreConstantPath(withoutSuffix, acronyms);
}

/**
 * The path and method Rails' naming convention gives one of the seven
 * conventional actions, or null for any other name.
 */
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

  const displayPathOf = (file: string) =>
    options.configDirectory === undefined
      ? file
      : path.relative(options.configDirectory, file);
  const engineRoots = () =>
    expandPatterns(options.configDirectory, options.engineRoots);
  const extraRoutesFiles = () =>
    expandPatterns(options.configDirectory, options.routesFiles);

  // The acronyms change how every constant maps to a file and a routing
  // key, so they are read once, before anything is resolved.
  const inflections =
    options.configDirectory === undefined
      ? EMPTY_INFLECTIONS
      : readInflections(options.configDirectory);
  const acronyms = inflections.acronyms;

  const routesInput = (): RoutesInput => ({
    routesFile: {
      file: routesFile,
      displayPath: options.routesFile ?? "config/routes.rb",
    },
    engines: readEngines(engineRoots(), acronyms).map((engine) => ({
      ...engine,
      displayPath:
        engine.routesFile === null
          ? engine.qualifiedName
          : displayPathOf(engine.routesFile),
    })),
    routesFiles: extraRoutesFiles().map((file) => ({
      file,
      displayPath: displayPathOf(file),
    })),
  });

  // Read lazily, because the WASM grammar loads once the adapter's file
  // loop has started, and this pack is built before that.
  let table: ReturnType<typeof readRoutes> | undefined;
  const routeTable = () => {
    table ??= readRoutes(routesInput());
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
    acronyms,
    ancestryRootClassNames: [...RAILS_ROOT_CLASS_NAMES],
    defaultStatusCode: 200,
    responseStatusCalls: RESPONSE_STATUS_CALLS,
    statusCodeNames: RACK_STATUS_CODE_NAMES,
    inheritedMethodNames: [
      ...RAILS_CONTROLLER_METHODS,
      ...(options.inheritedMethodNames ?? []),
    ],
    routesFile,
    filters: CONTROLLER_FILTERS,
    routeFor: (controllerQualifiedName, actionName) => {
      const key = controllerKeyFromQualified(controllerQualifiedName, acronyms);
      const found = routeTable();
      // When the routes file exists, an action it does not reach stays
      // unbound, even when its name is a conventional one.
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
    bodyBlocks: BODY_BLOCKS,
    inflections,
    // These files change an action's binding without being walked, so the
    // cache key has to list them. This runs before the grammar loads, so
    // nothing here parses Ruby.
    discoveryInputs: () => [
      routesFile,
      ...drawableRoutesFiles(routesFile),
      ...engineRoots().flatMap(engineSourceFiles),
      ...extraRoutesFiles(),
      ...(options.configDirectory === undefined
        ? []
        : inflectionFiles(options.configDirectory)),
    ],
  };
}

/** Every existing path the patterns match, resolved against the config directory. */
function expandPatterns(
  configDirectory: string | undefined,
  patterns: readonly string[] | undefined,
): string[] {
  return (patterns ?? []).flatMap((pattern) =>
    expandPathPattern(resolveAgainst(configDirectory, pattern)),
  );
}

/** Every `.rb` file in the directory `draw(:name)` reads from. */
function drawableRoutesFiles(routesFile: string): string[] {
  const directory = drawDirectoryOf(routesFile);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".rb"))
    .sort()
    .map((name) => path.join(directory, name));
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-rails",
  // An app that depends on the Rails gems one at a time has railties in
  // its Gemfile and no rails.
  dependencies: [
    { ecosystem: "rubygems", name: "rails" },
    { ecosystem: "rubygems", name: "railties" },
  ],
  reads:
    "Rails controller actions (Ruby), bound to the method and path \`config/routes.rb\` gives each one. An action the routes file does not reach is still discovered, with no boundary.",
  configuration: {
    file: "suss.rails.json",
    example: {
      root: "app",
      routesFile: "config/routes.rb",
      engineRoots: ["engines/*"],
      routesFiles: ["plugins/*/plugin.rb"],
    },
    required: false,
    why: "the app directory a controller is defined under and the routes file suss reads each action's method and path from; rails new scaffolds both at these paths. engineRoots lists where the project keeps engines it mounts, and routesFiles any other file that adds routes, when it has either.",
  },
};

export default railsFramework;
