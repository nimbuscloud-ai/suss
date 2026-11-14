/**
 * Reads `config/routes.rb`, or the file a project points this pack at,
 * into a table from controller action to HTTP method and path.
 *
 * The routing calls are declared once, as roles in `RAILS_ROUTES`, and
 * `@suss/recognize` composes the routes from them. The README lists
 * every call the grammar covers and where each one stops. A call outside
 * it, such as `direct`, is reported once per file as a gap, and a gem's
 * block written in the grammar is walked as if the call were not there.
 *
 * What stays here needs the file system or Rails itself: which files to
 * read, which owner is the app, where `draw` finds a file, the inflector,
 * a path's optional segments, and the text of each gap.
 */

import fs from "node:fs";
import path from "node:path";

import { moduleOpsForFile, pluralize, singularize } from "@suss/adapter-ruby";
import { composeRoutes, rowRoutes } from "@suss/recognize";

import { pathWithOptionalGroups } from "./optionalSegments.js";

import type { RbInflections } from "@suss/adapter-ruby";
import type {
  ExpandsRole,
  ExpansionRow,
  RouteGap,
  RouteSet,
  RouteSources,
  RouteTableDeclaration,
  ServesRole,
  TableOwner,
} from "@suss/recognize";
import type { RailsEngine } from "./engines.js";

export interface Route {
  method: string;
  path: string;
  /** True for a route that says `format: false`, which Rails serves with no `.:format` after its path. */
  formatless?: true;
}

export interface RouteTable {
  /**
   * Every method and path that reaches one controller's action, in the
   * order the file declares them, or none. `controllerKey` is lowercase
   * and slash-joined the way the routes file writes it: `admin/orders`
   * for `namespace :admin do resources :orders end`.
   */
  routesFor(controllerKey: string, actionName: string): Route[];
  /** Messages about declarations left unread, or one saying the routes file does not exist. */
  readonly gaps: readonly string[];
  /**
   * False when the routes file does not exist. Only then does a caller
   * fall back to the naming convention.
   */
  readonly fileFound: boolean;
}

/**
 * `get "x", to: "c#a"`, `get "x" => "c#a"`, and inside a resource a bare
 * `get :x`, which routes to the action `x` at the path `x`.
 */
const VERB = (method: string): ServesRole => ({
  role: "serves",
  methods: [method],
  path: [{ pair: "key" }, { at: 0 }],
  handler: [{ keyword: "to" }, { pair: "value" }],
  bare: {
    path: { at: 0 },
    action: { keyword: "action" },
    controller: { keyword: "controller" },
    on: { keyword: "on" },
    // ActionDispatch writes `post "reset-score"` as the action `reset_score`.
    wordRule: { replace: ["-", "_"] },
  },
  formatless: { pick: { keyword: "format" }, when: false },
});

/** The routes `resources` gives each of Rails' seven actions; `update` is served under PATCH and PUT. */
const PLURAL_ROWS: Readonly<Record<string, readonly ExpansionRow[]>> = {
  index: [{ method: "GET", suffix: "" }],
  create: [{ method: "POST", suffix: "" }],
  new: [{ method: "GET", suffix: "/new" }],
  show: [{ method: "GET", suffix: "{member}" }],
  edit: [{ method: "GET", suffix: "{member}/edit" }],
  update: [{ method: "update", suffix: "{member}" }],
  destroy: [{ method: "DELETE", suffix: "{member}" }],
};

const SINGULAR_ROWS: Readonly<Record<string, readonly ExpansionRow[]>> = {
  create: [{ method: "POST", suffix: "" }],
  new: [{ method: "GET", suffix: "/new" }],
  show: [{ method: "GET", suffix: "" }],
  edit: [{ method: "GET", suffix: "/edit" }],
  update: [{ method: "update", suffix: "" }],
  destroy: [{ method: "DELETE", suffix: "" }],
};

/**
 * What `resources` and `resource` share. Rails routes a singular
 * resource to the plural controller, and a singular one has no id, so
 * a resource nested inside it goes under its own path.
 */
const RESOURCE: Omit<
  ExpandsRole,
  "rows" | "controllerNaming" | "nested" | "member"
> = {
  role: "expands",
  name: { at: 0 },
  only: { keyword: "only" },
  except: { keyword: "except" },
  controller: { keyword: "controller" },
  path: { keyword: "path" },
  module: { keyword: "module" },
  concerns: { keyword: "concerns" },
  param: { keyword: "param" },
  shallow: { keyword: "shallow" },
  children: { in: "block" },
};

export const RAILS_ROUTES: RouteTableDeclaration = {
  roots: {
    calledOn: "routes",
    // Rails runs every `prepend` block first, then each `draw`, then
    // every `append`.
    kinds: { prepend: 0, draw: 1, append: 2 },
    children: { in: "block" },
  },
  handler: { separator: "#", namespaceJoin: "/" },
  loops: ["each", "each_with_index"],
  methodAliases: { update: ["PATCH", "PUT"] },
  roles: {
    get: VERB("GET"),
    post: VERB("POST"),
    patch: VERB("PATCH"),
    put: VERB("PUT"),
    delete: VERB("DELETE"),
    match: { ...VERB(""), methods: { pick: { keyword: "via" }, all: "all" } },
    root: {
      role: "serves",
      methods: ["GET"],
      path: { fixed: "scope" },
      handler: [{ keyword: "to" }, { at: 0 }],
    },
    resources: {
      ...RESOURCE,
      rows: PLURAL_ROWS,
      controllerNaming: "asWritten",
      nested: "singularId",
      member: "id",
    },
    resource: {
      ...RESOURCE,
      rows: SINGULAR_ROWS,
      controllerNaming: "plural",
      nested: "self",
      member: "self",
    },
    namespace: {
      role: "scopes",
      both: { at: 0 },
      shallowPath: true,
      children: { in: "block" },
    },
    // `scope "v1"` and `scope path: "v1"` both set the path in Rails.
    scope: {
      role: "scopes",
      path: [{ keyword: "path" }, { at: 0 }],
      namespace: [{ keyword: "module" }],
      children: { in: "block" },
    },
    // `constraints` narrows which requests match and leaves the path alone.
    constraints: { role: "scopes", children: { in: "block" } },
    with_options: { role: "defaults", children: { in: "block" } },
    member: { role: "base", which: "member", children: { in: "block" } },
    collection: {
      role: "base",
      which: "collection",
      children: { in: "block" },
    },
    concern: { role: "fragment", name: { at: 0 }, children: { in: "block" } },
    concerns: { role: "replay", names: { from: 0 } },
    draw: { role: "include", name: { at: 0 } },
    mount: {
      role: "mount",
      table: [{ at: 0 }, { pair: "key" }],
      at: [{ keyword: "at" }, { pair: "value" }],
    },
  },
};

/**
 * The routes `resources` gives one of Rails' seven actions under `base`,
 * such as `/orders`, or none for any other action.
 */
export function restfulRoutes(action: string, base: string): Route[] {
  if (!Object.hasOwn(PLURAL_ROWS, action)) {
    return [];
  }
  return (PLURAL_ROWS[action] ?? []).flatMap((row) =>
    rowRoutes(RAILS_ROUTES, row, { collection: base, member: `${base}/:id` }),
  );
}

/**
 * Rails serves each optional group a path writes, such as `(/:page)`,
 * both with and without it, so each distinct route is kept once after
 * the groups are read.
 */
function routesWithOptionalGroups(
  set: RouteSet,
  controllerKey: string,
  action: string,
): Route[] {
  const routes: Route[] = [];
  for (const route of set.routesFor(controllerKey, action)) {
    const routePath = pathWithOptionalGroups(route.path);
    if (
      !routes.some(
        (one) => one.method === route.method && one.path === routePath,
      )
    ) {
      routes.push({
        method: route.method,
        path: routePath,
        ...(route.formatless === true ? { formatless: true } : {}),
      });
    }
  }
  return routes;
}

/** Each gap's message: the unread calls per file, the gem blocks walked per file, then each file `draw` did not find. */
function gapMessages(
  gaps: readonly RouteGap[],
  drawDirectory: string,
): string[] {
  return [
    ...[...namesByFile(gaps, "unread")].map(
      ([file, names]) =>
        `${file} also declares ${names}, which this pack does not read; whatever those declarations route is missing from what suss reports`,
    ),
    ...[...namesByFile(gaps, "walkedBlock")].map(
      ([file, names]) =>
        `${file} wraps routes in ${names}, which this pack does not know; it read the routes inside as though the wrapper changed nothing about their path or controller`,
    ),
    ...gaps.flatMap((gap) =>
      gap.kind === "missingInclude"
        ? [
            `${gap.file} draws ${gap.name}, but there is no ${gap.name}.rb under ${path.basename(drawDirectory)}/ beside it to read; whatever that file routes is missing from what suss reports`,
          ]
        : [],
    ),
  ];
}

/** Per file, the distinct names one kind of gap records, sorted and joined. */
function namesByFile(
  gaps: readonly RouteGap[],
  kind: RouteGap["kind"],
): Map<string, string> {
  const byFile = new Map<string, Set<string>>();
  for (const gap of gaps) {
    if (gap.kind !== kind) {
      continue;
    }
    const names = byFile.get(gap.file) ?? new Set<string>();
    names.add(gap.name);
    byFile.set(gap.file, names);
  }
  return new Map(
    [...byFile].map(([file, names]) => [file, [...names].sort().join(", ")]),
  );
}

/**
 * Where `draw(:name)` reads `name.rb` from: the directory beside the
 * routes file that shares its stem, so `config/routes/` for
 * `config/routes.rb`. Rails reads from the same directory.
 */
export function drawDirectoryOf(routesFile: string): string {
  return path.join(
    path.dirname(routesFile),
    path.basename(routesFile, path.extname(routesFile)),
  );
}

/** `Rails.application` and the `Shop::Application` class Rails generates are the same route set, the app's own. */
function isApplication(owner: string): boolean {
  return owner === "Rails.application" || /(^|::)Application$/.test(owner);
}

/** A routes file to read, with the path a gap message prints for it. */
export interface RoutesSource {
  readonly file: string;
  readonly displayPath: string;
}

export interface RoutesInput {
  /** The app's own routes file. When it is missing, no routing is read. */
  readonly routesFile: RoutesSource;
  /** Engines a `mount` may refer to, each with its own routes file to read the engine's route set from. */
  readonly engines: readonly (RailsEngine & { readonly displayPath: string })[];
  /** Files beyond the routes file that add routes, by a `routes.draw`, `routes.append` or `routes.prepend` block written anywhere in them. */
  readonly routesFiles: readonly RoutesSource[];
  /**
   * The words the project's inflector declares, which change the
   * controller a singular resource routes to and the parameter a
   * resource nested inside a plural one is under.
   */
  readonly inflections: RbInflections;
}

/**
 * The files whose route declarations count, in the order Rails meets
 * them: the routes file, the other files that add routes, then each
 * engine's routes file.
 */
function declaringFiles(input: RoutesInput): RouteSources["files"] {
  const engineFiles = input.engines.flatMap((engine) =>
    engine.routesFile === null
      ? []
      : [{ file: engine.routesFile, displayPath: engine.displayPath }],
  );
  return [input.routesFile, ...input.routesFiles, ...engineFiles]
    .filter((source) => fs.existsSync(source.file))
    .map((source) => ({
      module: moduleOpsForFile(source.file),
      displayPath: source.displayPath,
    }));
}

/**
 * The route set an owner is, as a declaration's receiver or a mount
 * writes it: the app's own, an engine's by its class name, or neither.
 */
function ownerIn(
  engines: RoutesInput["engines"],
): (written: string) => TableOwner | null {
  const byName = new Map(
    engines.map((engine) => [engine.qualifiedName, engine]),
  );
  return (written) => {
    const owner = written.replace(/^::/, "");
    if (isApplication(owner)) {
      return { table: "app" };
    }
    const engine = byName.get(owner);
    return engine === undefined
      ? null
      : {
          table: "mounted",
          name: engine.qualifiedName,
          namespace: engine.modulePrefix,
        };
  };
}

/**
 * Reads the app's routes file, every engine's, and any other file that
 * adds routes, into one table keyed by controller routing key. An
 * engine's `Name::Engine.routes.draw` block is set aside and walked
 * under the path each `mount Name::Engine, at:` gives it. Every other
 * declaration adds to the app's route set, in the order Rails runs them.
 */
export function readRoutes(input: RoutesInput): RouteTable {
  if (!fs.existsSync(input.routesFile.file)) {
    return {
      routesFor: () => [],
      fileFound: false,
      gaps: [
        `${input.routesFile.displayPath} does not exist, so this run assumes each action's path and method from Rails' RESTful naming convention instead of reading it from routing`,
      ],
    };
  }
  const drawDirectory = drawDirectoryOf(input.routesFile.file);
  const set = composeRoutes(RAILS_ROUTES, {
    files: declaringFiles(input),
    ownerOf: ownerIn(input.engines),
    include: (name) => {
      const file = path.join(drawDirectory, `${name}.rb`);
      return fs.existsSync(file) ? moduleOpsForFile(file) : null;
    },
    naming: {
      singular: (word) => singularize(word, input.inflections),
      plural: (word) => pluralize(word, input.inflections),
    },
  });
  return {
    routesFor: (controllerKey, action) =>
      routesWithOptionalGroups(set, controllerKey, action),
    fileFound: true,
    gaps: gapMessages(set.gaps, drawDirectory),
  };
}
