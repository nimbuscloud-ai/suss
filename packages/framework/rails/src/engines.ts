/**
 * Rails engines a project keeps in its own tree. An engine is a class
 * extending `Rails::Engine`; Rails takes its root as the directory
 * that class's `lib/` is in, loads `<root>/config/routes.rb` along
 * with the app's own routes file, and serves the engine's route set
 * wherever the app writes `mount Name::Engine, at: "/prefix"`. An
 * `isolate_namespace Name` inside the class puts every controller the
 * engine routes under that module, so `"items#index"` in its routes
 * means `Name::ItemsController`.
 *
 * Rails finds an engine by loading Ruby, which a static reader cannot
 * do, so a project says which directories contain one, and this module
 * reads the class and the routes file out of each.
 */

import fs from "node:fs";
import path from "node:path";

import {
  bodyStatements,
  field,
  parseRubySync,
  underscoreConstantPath,
} from "@suss/adapter-ruby";

import type { RbNode } from "@suss/adapter-ruby";

export interface RailsEngine {
  /** The class as a mount would spell it, `Billing::Engine`. */
  readonly qualifiedName: string;
  /** The routing key prefix `isolate_namespace` gives every controller the engine routes, `billing`, or "" for an engine that isolates nothing. */
  readonly modulePrefix: string;
  /** The engine's own `config/routes.rb`, or null when the root has none. */
  readonly routesFile: string | null;
}

const ENGINE_BASE_NAMES = new Set(["Rails::Engine", "::Rails::Engine"]);
const CONSTANT_TYPES = new Set(["constant", "scope_resolution"]);

/** Every engine defined under one of `roots`, in the order the roots were given. A root with no engine class under its `lib/` is skipped. */
export function readEngines(roots: readonly string[]): RailsEngine[] {
  const engines: RailsEngine[] = [];
  for (const root of roots) {
    const routesFile = engineRoutesFile(root);
    for (const file of engineFilesUnder(root)) {
      const source = fs.readFileSync(file, "utf8");
      for (const found of engineClassesIn(parseRubySync(source).rootNode)) {
        engines.push({ ...found, routesFile });
      }
    }
  }
  return engines;
}

/**
 * The files an engine under `root` is read from, for a cache key: the
 * files under its `lib/` that spell `Rails::Engine`, and its routes file.
 * Found by text alone, since this runs before the grammar is loaded.
 */
export function engineSourceFiles(root: string): string[] {
  const routesFile = engineRoutesFile(root);
  return [
    ...engineFilesUnder(root),
    ...(routesFile === null ? [] : [routesFile]),
  ];
}

function engineRoutesFile(root: string): string | null {
  const routesFile = path.join(root, "config", "routes.rb");
  return fs.existsSync(routesFile) ? routesFile : null;
}

function engineFilesUnder(root: string): string[] {
  const directory = path.join(root, "lib");
  if (!fs.existsSync(directory)) {
    return [];
  }
  return rubyFilesUnder(directory).filter((file) =>
    fs.readFileSync(file, "utf8").includes("Rails::Engine"),
  );
}

/**
 * Every existing path matching `pattern`, where a `*` in a segment
 * matches any run of characters in one directory entry. A pattern with
 * no `*` is one path, kept when it exists.
 */
export function expandPathPattern(pattern: string): string[] {
  const segments = pattern.split(path.sep).filter((s) => s !== "");
  const start = path.isAbsolute(pattern) ? path.sep : ".";
  let candidates = [start];
  for (const segment of segments) {
    if (!segment.includes("*")) {
      candidates = candidates.map((base) => path.join(base, segment));
      continue;
    }
    const matcher = new RegExp(
      `^${segment.split("*").map(escapeRegExp).join(".*")}$`,
    );
    candidates = candidates.flatMap((base) =>
      fs.existsSync(base)
        ? fs
            .readdirSync(base)
            .filter((name) => matcher.test(name))
            .sort()
            .map((name) => path.join(base, name))
        : [],
    );
  }
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rubyFilesUnder(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rb"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function engineClassesIn(
  node: RbNode,
  enclosing: readonly string[] = [],
): Omit<RailsEngine, "routesFile">[] {
  const found: Omit<RailsEngine, "routesFile">[] = [];
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "class" && extendsEngine(child)) {
      const name = definedName(child);
      if (name !== undefined) {
        found.push({
          qualifiedName: [...enclosing, name].join("::"),
          modulePrefix: isolatedNamespaceOf(child),
        });
      }
      continue;
    }
    const nested =
      child.type === "module" || child.type === "class"
        ? [...enclosing, definedName(child) ?? ""]
        : enclosing;
    found.push(...engineClassesIn(child, nested));
  }
  return found;
}

/** The constant a `module`/`class` line defines, with a leading `::` dropped: `module ::Billing` defines `Billing`. */
function definedName(definition: RbNode): string | undefined {
  return field(definition, "name")?.text.replace(/^::/, "");
}

function extendsEngine(classNode: RbNode): boolean {
  const superclass = field(classNode, "superclass");
  const base = superclass?.namedChildren.find(
    (child) => child !== null && CONSTANT_TYPES.has(child.type),
  );
  return (
    base !== undefined && base !== null && ENGINE_BASE_NAMES.has(base.text)
  );
}

/** The module `isolate_namespace Name` puts the engine's controllers under, as a routing key prefix. */
function isolatedNamespaceOf(classNode: RbNode): string {
  const body = field(classNode, "body");
  if (body === null) {
    return "";
  }
  for (const statement of bodyStatements(body)) {
    if (
      statement.type !== "call" ||
      field(statement, "method")?.text !== "isolate_namespace"
    ) {
      continue;
    }
    const arguments_ = field(statement, "arguments");
    const argument =
      arguments_ === null ? undefined : bodyStatements(arguments_)[0];
    if (argument !== undefined && CONSTANT_TYPES.has(argument.type)) {
      return underscoreConstantPath(argument.text.replace(/^::/, ""));
    }
  }
  return "";
}
