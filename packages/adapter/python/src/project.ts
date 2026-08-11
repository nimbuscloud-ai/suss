// project.ts: the adapter's whole contract, which is to discover units,
// emit summaries in the shared IR, and emit facts.
//
// It parses every file it is given, runs the lexical binder and
// discovery over each one, hands each discovered unit to
// `@suss/extractor`'s `assembleSummary`, and emits this run's facts
// into one shared `Database`.
//
// `assembleSummary` is the same assembly layer the TypeScript adapter
// uses, so gap detection and confidence scoring are one implementation
// that both languages share.

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { assembleSummary } from "@suss/extractor";

import { field } from "./ast.js";
import { discoverUnits } from "./discovery.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitEntryFact, emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractorOptions } from "@suss/extractor";
import type { PythonPack, StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";

export interface ExtractPythonOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: PythonPack[];
  /** Directories an absolute import is resolved against. */
  roots: string[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** As well as deciding how much of what nobody could read reaches a summary, "strict" lets a route that cannot be built stop the run. */
  gapHandling?: ExtractorOptions["gapHandling"];
}

export interface ExtractPythonResult {
  summaries: BehavioralSummary[];
  facts: Database;
}

export async function extractPythonProject(
  options: ExtractPythonOptions,
): Promise<ExtractPythonResult> {
  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";

  // Every file is parsed and bound before discovery runs on any of them,
  // because the router index has to see a mount written in one file and the
  // router it refers to constructed in another.
  //
  // Facts keep the full filesystem path, because they are joined against
  // internally. Only a summary's `location.file` gets shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  const bound: BoundPythonFile[] = [];
  for (const file of options.files) {
    const source = fs.readFileSync(file, "utf8");
    const tree = await parsePython(source);
    bound.push({
      file,
      displayPath: displayPathOf(file),
      root: tree.rootNode,
      module: bindModule(tree.rootNode),
    });
  }

  // A pack that mounts routers may meet a loop over a call, and only the
  // rules can say what that call registers. The facts they read are built
  // once, here, for the packs that could need them.
  const mountsRouters = options.packs.some((pack) =>
    pack.discovery.some((pattern) => pattern.routerComposition !== undefined),
  );
  const storagePatterns = options.packs.flatMap((pack) => pack.storage ?? []);
  const needsValues = mountsRouters || storagePatterns.length > 0;
  // Which function a resolved key was written as, so a recognizer can read
  // what it says it returns.
  const definitions = new Map<string, PyNode>();
  for (const { file, root, module: moduleBinding } of bound) {
    emitModuleImportFacts(db, file, moduleBinding, { roots: options.roots });
    if (needsValues) {
      emitValueFacts(db, file, root);
    }
    if (storagePatterns.length > 0) {
      indexDefinitions(definitions, file, root);
    }
  }

  // A chain that matches starts at a method some file importing the library
  // declares, so its name is in here. A project that renames one on the way
  // through is missed, which is what asking about every call would cost a
  // minute to catch.
  const couldMatch = methodsDeclaredNear(db, storagePatterns, definitions);
  const leadsToStorage = functionsReachingStorage(definitions, couldMatch);

  const routerIndex = buildRouterIndex(bound, options.packs, {
    roots: options.roots,
    ...(mountsRouters ? { facts: db } : {}),
  });

  for (const { file, root, module: moduleBinding } of bound) {
    const displayPath = displayPathOf(file);

    const rawUnits = discoverUnits(root, moduleBinding, {
      packs: options.packs,
      filePath: displayPath,
      routerIndex,
      gapHandling,
      ...(storagePatterns.length > 0
        ? {
            storage: {
              facts: db,
              factsPath: file,
              patterns: storagePatterns,
              definitionAt: (key: string) => definitions.get(key),
              couldMatch,
              leadsToStorage,
            },
          }
        : {}),
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling });
      // `assembleSummary` scores confidence on the assumption that a unit's
      // branches came from tracing its body. Nothing here traces a body, so
      // that score would be meaningless and we set confidence directly.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);
    }
  }

  return { summaries, facts: db };
}

const SKIPPED_DIRECTORIES = new Set([
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".git",
]);

/** Every `.py` file under `root`, depth-first, skipping the usual non-source directories. */
export function findPythonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".py")) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Every function in a file, under the key the facts give it. */
function indexDefinitions(
  into: Map<string, PyNode>,
  file: string,
  node: PyNode,
): void {
  if (node.type === "function_definition") {
    into.set(nodeId(file, node), node);
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      indexDefinitions(into, file, child);
    }
  }
}

/** What a file importing one of the libraries declares, by name. */
function methodsDeclaredNear(
  db: Database,
  patterns: readonly StoragePattern[],
  definitions: ReadonlyMap<string, PyNode>,
): Set<string> {
  const modules = new Set(patterns.map((pattern) => pattern.module));
  const importing = new Set(
    db
      .facts("pyImport")
      .filter((row) => modules.has(String(row[1])))
      .map((row) => String(row[0])),
  );
  const found = new Set<string>();
  for (const [key, node] of definitions) {
    const at = key.lastIndexOf(":");
    if (at === -1 || !importing.has(key.slice(0, at))) {
      continue;
    }
    const name = field(node, "name");
    if (name !== null) {
      found.add(name.text);
    }
  }
  return found;
}

/** The method a call says, `query` in `Model.query()`. */
function calledName(call: PyNode): string {
  const callee = field(call, "function");
  if (callee === null) {
    return "";
  }
  return callee.type === "attribute"
    ? (field(callee, "attribute")?.text ?? "")
    : callee.text;
}

/** Every call written under a node, nested functions included. */
function callsUnder(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsUnder(child, found);
  }
  return found;
}

/**
 * Which functions reach the database, by name, following calls until the set
 * stops growing. A walk that followed every call would ask the rules about
 * every call in the project, which costs a minute on a large one.
 */
function functionsReachingStorage(
  definitions: ReadonlyMap<string, PyNode>,
  couldMatch: ReadonlySet<string>,
): Set<string> {
  const bodies: { name: string; calls: string[] }[] = [];
  for (const node of definitions.values()) {
    const name = field(node, "name");
    if (name === null) {
      continue;
    }
    bodies.push({ name: name.text, calls: callsUnder(node).map(calledName) });
  }

  const reaching = new Set<string>();
  for (const body of bodies) {
    if (body.calls.some((called) => couldMatch.has(called))) {
      reaching.add(body.name);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const body of bodies) {
      if (reaching.has(body.name) || !body.calls.some((c) => reaching.has(c))) {
        continue;
      }
      reaching.add(body.name);
      grew = true;
    }
  }
  return reaching;
}
