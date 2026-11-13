/**
 * Reads the Rails engines a project keeps in its own tree. Rails finds an
 * engine by loading Ruby, which a static reader cannot do, so the project
 * lists the directories that contain one.
 *
 * In each directory, the engine is the class under `lib/` that extends
 * `Rails::Engine`, and its routes are in `config/routes.rb`. The README
 * covers how `mount` and `isolate_namespace` shape the routes.
 */

import fs from "node:fs";
import path from "node:path";

import { moduleOpsForFile, underscoreConstantPath } from "@suss/adapter-ruby";

import type { ClassValueOps, Inherits, ModuleOps } from "@suss/extractor";

export interface RailsEngine {
  /** The class as a `mount` call writes it, such as `Billing::Engine`. */
  readonly qualifiedName: string;
  /**
   * The routing key prefix `isolate_namespace` gives every controller the
   * engine routes, such as `billing`, or "" when it isolates nothing.
   */
  readonly modulePrefix: string;
  /** The engine's own `config/routes.rb`, or null when the root has none. */
  readonly routesFile: string | null;
}

/** The base every engine class extends, which Ruby reaches through Rails' own constant. */
const RAILS_ENGINE: Inherits = { from: ["Rails"], named: ["Engine"] };

/**
 * Every engine defined under one of `roots`, in the order the roots were
 * given. A root with no engine class under its `lib/` is skipped.
 * `acronyms` are the project's inflector acronyms, which change the
 * routing key an isolated namespace gets.
 */
export function readEngines(
  roots: readonly string[],
  acronyms: readonly string[] = [],
): RailsEngine[] {
  const engines: RailsEngine[] = [];
  for (const root of roots) {
    const routesFile = engineRoutesFile(root);
    for (const file of engineFilesUnder(root)) {
      for (const found of engineClassesIn(moduleOpsForFile(file), acronyms)) {
        engines.push({ ...found, routesFile });
      }
    }
  }
  return engines;
}

/**
 * The files an engine under `root` is read from, for a cache key: the
 * files under its `lib/` that mention `Rails::Engine`, and its routes
 * file. It matches by text alone, because this runs before the grammar
 * is loaded.
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

/** Each class in the file that extends `Rails::Engine`, by the name its namespaces give it. */
function engineClassesIn(
  module: ModuleOps,
  acronyms: readonly string[],
): Omit<RailsEngine, "routesFile">[] {
  return module.classes().flatMap((cls) => {
    const name = cls.name();
    return name === null || !cls.inherits(RAILS_ENGINE)
      ? []
      : [
          {
            qualifiedName: name,
            modulePrefix: isolatedNamespaceOf(cls, acronyms),
          },
        ];
  });
}

/** The module `isolate_namespace Name` puts the engine's controllers under, as a routing key prefix. */
function isolatedNamespaceOf(
  cls: ClassValueOps,
  acronyms: readonly string[],
): string {
  const isolates = cls
    .bodyCalls()
    .find(
      (call) => (call.method() ?? call.calleeText()) === "isolate_namespace",
    );
  const written = isolates?.valueAt(0)?.source?.() ?? null;
  return written === null
    ? ""
    : underscoreConstantPath(written.replace(/^::/, ""), acronyms);
}
