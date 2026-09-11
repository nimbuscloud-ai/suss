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
    /**
     * Methods beyond Rails' own that every controller in this project
     * gets without defining them, from a gem such as Devise. They are
     * left off an action's effects the same way Rails' own are.
     */
    inheritedMethodNames: z.array(z.string()).optional(),
    /** Where this project's routes live, relative to `configDirectory` when there is one. Every Rails app scaffolds this at `config/routes.rb`. */
    routesFile: z.string().optional(),
    /**
     * Directories the project keeps its own engines under, each one the
     * root a `Rails::Engine` subclass has its `lib/` and `config/routes.rb`
     * in. A `*` in a segment matches any one directory, so `plugins/*`
     * covers every plugin. Relative to `configDirectory`.
     */
    engineRoots: z.array(z.string()).optional(),
    /**
     * Files beyond the routes file that add routes through a
     * `Rails.application.routes.draw`, `.append` or `.prepend` block,
     * a plugin's `plugin.rb` being the usual one. Same `*` rule as
     * `engineRoots`. Relative to `configDirectory`.
     */
    routesFiles: z.array(z.string()).optional(),
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

/**
 * The four calls Rails gives an action for sending a response. `render`
 * takes the status as `status:`, `head` takes it first and also accepts
 * the keyword, and both redirects take the keyword. A redirect that writes
 * no status of its own sends 302 rather than the 200 the rest default to.
 */
const RESPONSE_STATUS_CALLS = [
  { name: "render", statusKeyword: "status" },
  { name: "head", statusArgument: 0, statusKeyword: "status" },
  { name: "redirect_to", statusKeyword: "status", defaultStatusCode: 302 },
  { name: "redirect_back", statusKeyword: "status", defaultStatusCode: 302 },
];

/**
 * The two class-level calls that put a controller's own method in front
 * of its actions. A `before_action` runs before the action and ends the
 * request when it responds; a `rescue_from` runs only after the action
 * raised. `only:` and `except:` narrow either to some of the actions,
 * and `skip_before_action` takes a before_action back off.
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
 * The methods `ActionController::Base` and `ActionController::API` give
 * every controller, so a project defines none of them and an action that
 * writes one is not reaching anything the project owns. Each one is an
 * instance method on one of those two bases; a controller helper a gem
 * adds, `current_user` from Devise being the common one, belongs to that
 * gem instead and comes in through `inheritedMethodNames`.
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
 * The five ActiveSupport calls whose block runs as part of the class or
 * module body it is written in. A concern's `included` and `prepended`
 * evaluate their block against the class doing the including, and only
 * a module gets them; `class_methods` evaluates its block against a
 * nested `ClassMethods` module that the including class extends, so a
 * `def` there is a class method. `Module#concerning` module_evals its
 * block against a new module and mixes that module in, and
 * `Object#with_options` runs its block with extra keywords wherever it
 * is written, so both reach a class body as well as a module's.
 */
const BODY_BLOCKS = [
  { name: "included", moduleOnly: true },
  { name: "prepended", moduleOnly: true },
  { name: "class_methods", moduleOnly: true, definesClassMethods: true },
  { name: "concerning" },
  { name: "with_options" },
];

/** What a project that registered nothing taught its inflector. */
const EMPTY_INFLECTIONS: Required<RbInflections> = {
  acronyms: [],
  irregular: [],
  uncountable: [],
  singular: [],
};

/** The routing key `config/routes.rb` gives a controller, from the class name the adapter reads: `Admin::OrdersController` -> `admin/orders`. */
function controllerKeyFromQualified(
  qualifiedName: string,
  acronyms: readonly string[],
): string {
  const withoutSuffix = qualifiedName.endsWith("Controller")
    ? qualifiedName.slice(0, -"Controller".length)
    : qualifiedName;
  return underscoreConstantPath(withoutSuffix, acronyms);
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

  const displayPathOf = (file: string) =>
    options.configDirectory === undefined
      ? file
      : path.relative(options.configDirectory, file);
  const engineRoots = () =>
    expandPatterns(options.configDirectory, options.engineRoots);
  const extraRoutesFiles = () =>
    expandPatterns(options.configDirectory, options.routesFiles);

  // The acronyms decide how every constant maps to a file and a routing
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

  // Lazy: the WASM grammar this reads with loads once the adapter's own
  // file loop has started, and this pack is constructed before that.
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
    bodyBlocks: BODY_BLOCKS,
    inflections,
    // Every file routing or naming is read from decides an action's
    // binding without being walked, so the cache key has to read them
    // here. This runs before the grammar loads, so nothing parses Ruby.
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

/** What this pack reads, and what a project has to be using for it to. */
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
    "Rails controller actions (Ruby), bound to the method and path \`config/routes.rb\` gives each one; an action the routes file does not reach is discovered with no boundary.",
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
