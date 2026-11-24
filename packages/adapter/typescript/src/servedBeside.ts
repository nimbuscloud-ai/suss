/**
 * What a framework serves besides its routes, read the way its pack's
 * `servedBeside` says, and written on every route the pack recognized.
 * The checker reports a call to a missing route only in a service whose
 * routes all carry one. Static directories and page files are listed
 * from where they are, the config file and the middleware matcher are
 * read through the module ops, and the mounts come from the mount index.
 */

import fs from "node:fs";
import path from "node:path";

import picomatch from "picomatch";

import { stampServedBeside, staticDirectoryEntries } from "@suss/extractor";

import { moduleOpsFor } from "./discovery/declared.js";
import { routePathFromFile } from "./discovery/filenameRoute.js";

import type { BehavioralSummary, ServedBesideEntry } from "@suss/behavioral-ir";
import type {
  ModuleOps,
  PatternPack,
  ServedBesideDeclaration,
  ServedConfig,
  ServedMiddleware,
  ValueOps,
} from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";
import type { MountBeside } from "./discovery/mountPrefix.js";
import type { ResolutionStore } from "./facts/store.js";

export interface ServedBesideRun {
  frameworks: readonly PatternPack[];
  project: Project;
  store: ResolutionStore;
  /** The project's root, which the pack's files and directories are read from. */
  root: string | undefined;
  sourceFiles: readonly SourceFile[];
  /** What each pack's mount calls serve beside its routes, by pack. */
  mounts: ReadonlyMap<string, readonly MountBeside[]>;
}

type Syntax = NonNullable<ServedBesideDeclaration["patternSyntax"]>;

/** Writes, on each route of every pack that states it, what the pack read beside its routes. */
export function stampServedBesideOn(
  summaries: readonly BehavioralSummary[],
  run: ServedBesideRun,
): void {
  const { root } = run;
  if (root === undefined) {
    return;
  }
  const recognized = new Set(
    summaries.map((summary) => summary.identity.boundaryBinding?.recognition),
  );
  for (const pack of run.frameworks) {
    const declared = pack.servedBeside;
    if (declared === undefined || !recognized.has(pack.name)) {
      continue;
    }
    const syntax = declared.patternSyntax ?? "routePath";
    const read = moduleReader(run);
    const configFile = firstExisting(root, declared.config?.files ?? []);
    stampServedBeside(summaries, pack.name, [
      ...pageEntries(declared, run.sourceFiles),
      ...staticDirectoryEntries(root, declared.staticDirectories ?? []),
      ...(declared.config === undefined || configFile === null
        ? []
        : configEntries(declared.config, configFile, read, syntax)),
      ...(declared.middleware === undefined
        ? []
        : middlewareEntries(declared.middleware, root, read, syntax)),
      ...mountEntries(run.mounts.get(pack.name) ?? []),
    ]);
  }
}

/** Each page file's path, which serves GET. */
function pageEntries(
  declared: ServedBesideDeclaration,
  sourceFiles: readonly SourceFile[],
): ServedBesideEntry[] {
  return (declared.pages ?? []).flatMap((pages) => {
    const matches = picomatch(pages.filePattern, { dot: true });
    return sourceFiles.flatMap((sourceFile) => {
      const file = sourceFile.getFilePath();
      const served = matches(file) ? routePathFromFile(file, pages.path) : null;
      if (served === null) {
        return [];
      }
      const suffix =
        pages.suffixed === true && served !== "/" ? "{suffix*}" : "";
      return [
        {
          by: "page" as const,
          path: `${served}${suffix}`,
          methods: ["GET", "HEAD"],
          file,
          line: 1,
        },
      ];
    });
  });
}

/**
 * The rules the config file's exported object sends requests elsewhere
 * with, and any key that moves every route. A config suss cannot read
 * may do either, so it covers every path.
 */
function configEntries(
  declared: ServedConfig,
  file: string,
  read: (file: string) => ModuleOps | null,
  syntax: Syntax,
): ServedBesideEntry[] {
  // A CommonJS `module.exports`, or a JavaScript file the program does
  // not read, states no export, and so reads as a config suss cannot see.
  const config = read(file)?.export(["default"])?.object?.() ?? null;
  if (config === null) {
    return [unreadEntry(file, "the object the config file exports")];
  }
  // A spread's entries are dropped when its object does not settle, and
  // they may be the very rules this reads, so any spread covers every path.
  const keys = config.entries("nothing");
  if (
    keys.some((entry) => entry.key === null) ||
    (config.source?.() ?? "...").includes("...")
  ) {
    return [unreadEntry(file, "a key the config spreads or computes")];
  }
  const moved = declared.unread.filter((key) => config.property(key) !== null);
  return [
    ...moved.map((key) => unreadEntry(file, key)),
    ...declared.rules.flatMap(({ key, by }) => {
      const rules = config.property(key);
      return rules === null ? [] : ruleEntries(rules, by, file, syntax);
    }),
  ];
}

/** Every `source` the rules function returns, in each list it returns. */
function ruleEntries(
  rules: ValueOps,
  by: "rewrite" | "redirect",
  file: string,
  syntax: Syntax,
): ServedBesideEntry[] {
  const lists = ruleLists(rules);
  if (lists === null) {
    return [unreadEntry(file, `the rules ${by}s returns`)];
  }
  return lists.flatMap((list) =>
    list.map((rule) => {
      const source = rule.property("source")?.evaluated?.() ?? null;
      return typeof source === "string"
        ? patternEntry(by, source, file, syntax)
        : unreadEntry(file, `a ${by} whose source is not one string`);
    }),
  );
}

/**
 * The lists of rules a rules function returns: one list, or an object
 * of lists such as Next.js's `beforeFiles`, `afterFiles` and `fallback`.
 * Null when it returns anything else.
 */
function ruleLists(rules: ValueOps): ValueOps[][] | null {
  const fn = rules.function?.() ?? null;
  const returned = fn?.returns?.() ?? [];
  if (returned.length === 0) {
    return null;
  }
  const lists: ValueOps[][] = [];
  for (const value of returned) {
    const items = listItems(value);
    if (items !== null) {
      lists.push([...items]);
      continue;
    }
    const parts = value.object?.()?.entries("nothing") ?? [];
    if (parts.length === 0) {
      return null;
    }
    for (const part of parts) {
      const inner = listItems(part.value);
      if (part.key === null || inner === null) {
        return null;
      }
      lists.push([...inner]);
    }
  }
  return lists;
}

/** The items of a list the source writes out, or null for anything else. */
function listItems(value: ValueOps): readonly ValueOps[] | null {
  const written = value.writtenItems?.() ?? null;
  if (written === null || written.some((item) => item.startsWith("..."))) {
    return null;
  }
  return value.items();
}

/**
 * The paths the middleware runs for: what its matcher says, or every
 * path when it states no matcher.
 */
function middlewareEntries(
  declared: ServedMiddleware,
  root: string,
  read: (file: string) => ModuleOps | null,
  syntax: Syntax,
): ServedBesideEntry[] {
  const file = firstExisting(root, declared.files);
  if (file === null) {
    return [];
  }
  const module = read(file);
  if (module === null) {
    return [unreadEntry(file, "the middleware file")];
  }
  const matcher =
    module.export([declared.export])?.object?.()?.property(declared.property) ??
    null;
  if (matcher === null) {
    return [{ by: "middleware", path: "/{path*}", file, line: 1 }];
  }
  const single = matcher.evaluated?.() ?? null;
  if (typeof single === "string") {
    return [patternEntry("middleware", single, file, syntax)];
  }
  const items = listItems(matcher);
  if (items === null || items.length === 0) {
    return [unreadEntry(file, "the matcher")];
  }
  return items.map((item) => {
    const source =
      item.evaluated?.() ??
      item.object?.()?.property("source")?.evaluated?.() ??
      null;
    return typeof source === "string"
      ? patternEntry("middleware", source, file, syntax)
      : unreadEntry(file, "a matcher that is not one string");
  });
}

function mountEntries(mounts: readonly MountBeside[]): ServedBesideEntry[] {
  return mounts.map((mount) => ({
    by: mount.by,
    ...(mount.prefix === null ? {} : { path: everyPathUnder(mount.prefix) }),
    ...(mount.by === "static" ? { methods: ["GET", "HEAD"] } : {}),
    file: mount.file,
    line: mount.line,
    written: mount.written,
  }));
}

/** Every path under a prefix, as a route path the checker reads the way it reads a route's. */
function everyPathUnder(prefix: string): string {
  return `${prefix.replace(/\/+$/, "")}/{path*}`;
}

function patternEntry(
  by: ServedBesideEntry["by"],
  written: string,
  file: string,
  syntax: Syntax,
): ServedBesideEntry {
  const requests = requestsOf(written, syntax);
  return requests === null
    ? unreadEntry(file, written)
    : { by, ...requests, file, line: 1, written };
}

function unreadEntry(file: string, written: string): ServedBesideEntry {
  return { by: "unread", file, line: 1, written };
}

/**
 * The requests a rule's path takes, as a route path when the syntax
 * says nothing a route path cannot, and otherwise as a regular
 * expression. Null when the path uses a part of the syntax not read.
 */
function requestsOf(
  written: string,
  syntax: Syntax,
): { path: string } | { pattern: string } | null {
  if (syntax === "routePath" || !/[(){}\\]/.test(written)) {
    return { path: written };
  }
  const pattern = pathToRegexpSource(written);
  return pattern === null ? null : { pattern };
}

const PARAMETER = /^:([A-Za-z0-9_]+)/;

/**
 * A path-to-regexp pattern, as Next.js writes its matchers, rewrites and
 * redirects, as a regular expression over the request path. A parameter
 * with `?`, `*` or `+` takes the slash before it along, the way the
 * library reads it. Null for a `{}` group, which is not read.
 */
export function pathToRegexpSource(written: string): string | null {
  let out = "";
  let at = 0;
  while (at < written.length) {
    const piece = pieceAt(written, at);
    if (piece === null) {
      return null;
    }
    if (piece.kind === "text") {
      out += piece.source;
      at = piece.end;
      continue;
    }
    const next = written[piece.end] ?? "";
    const modifier = /[?*+]/.test(next) ? next : "";
    const slash = modifier !== "" && out.endsWith("\\/");
    const before = slash ? out.slice(0, -2) : out;
    out = `${before}(?:${slash ? "\\/" : ""}(?:${piece.source}))${modifier}`;
    at = piece.end + modifier.length;
  }
  return `^${out}\\/?$`;
}

interface Piece {
  kind: "text" | "group";
  source: string;
  end: number;
}

function pieceAt(written: string, at: number): Piece | null {
  const char = written[at] as string;
  if (char === "{" || char === "}") {
    return null;
  }
  if (char === "\\") {
    return {
      kind: "text",
      source: escaped(written[at + 1] ?? ""),
      end: at + 2,
    };
  }
  const parameter = PARAMETER.exec(written.slice(at));
  if (parameter !== null) {
    const after = at + parameter[0].length;
    if (written[after] === "(") {
      return groupAt(written, after);
    }
    return { kind: "group", source: "[^/]+", end: after };
  }
  if (char === "(") {
    return groupAt(written, at);
  }
  return { kind: "text", source: escaped(char), end: at + 1 };
}

/** The regular expression in the parentheses at `open`, kept as written. */
function groupAt(written: string, open: number): Piece | null {
  let depth = 0;
  for (let at = open; at < written.length; at += 1) {
    const char = written[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    }
    if (char === ")") {
      depth -= 1;
    }
    if (depth === 0) {
      return {
        kind: "group",
        source: written.slice(open + 1, at),
        end: at + 1,
      };
    }
  }
  return null;
}

function escaped(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function firstExisting(root: string, files: readonly string[]): string | null {
  for (const file of files) {
    const at = path.join(root, file);
    if (fs.existsSync(at)) {
      return at;
    }
  }
  return null;
}

/**
 * The module ops for a file, loading it into the program when the
 * project's own config leaves it out, as it does a `.js` config file.
 */
function moduleReader(
  run: ServedBesideRun,
): (file: string) => ModuleOps | null {
  return (file) => {
    let sourceFile = run.project.getSourceFile(file);
    if (sourceFile === undefined) {
      try {
        sourceFile = run.project.addSourceFileAtPath(file);
      } catch {
        return null;
      }
    }
    return moduleOpsFor(sourceFile, run.store);
  };
}
