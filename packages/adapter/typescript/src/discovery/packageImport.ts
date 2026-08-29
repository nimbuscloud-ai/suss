/**
 * packageImport.ts (discovery handler): emit one consumer-side unit
 * per (enclosing function × consumed binding) for any call into a
 * targeted package. Pairs with packageExports-discovered providers.
 *
 * Attribution asks the resolution store, per the walkers-and-rules
 * design: `importOriginsOf` derives what a callee or a receiver comes
 * down to through the comesFrom, callsInto, and madeFrom rules, so a
 * named import, an alias, a namespace member, a rebound local, and a
 * factory result are all one question. A shape the store leaves
 * unresolved is a missing base fact to emit, not a walk to add here.
 */

import {
  type CallExpression,
  type ImportSpecifier,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";

import { type DiscoveredUnit, findEnclosingFunction } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * Whether a file is one of TypeScript's own lib files, which declare
 * what every value can do: `Array.map`, `Promise.then`, `String.trim`.
 */
function isLanguageLib(file: SourceFile): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\..*\.d\.ts$/.test(file.getFilePath());
}

function splitPackageSpec(spec: string): {
  packageName: string;
  subPath: string[];
} {
  // Scoped packages keep the first two segments together (`@scope/pkg`).
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) {
      return { packageName: spec, subPath: [] };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subPath = parts.slice(2);
    return { packageName, subPath };
  }
  const parts = spec.split("/");
  return {
    packageName: parts[0],
    subPath: parts.slice(1),
  };
}

function enclosingFunctionName(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    const n = func.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(func)) {
    const n = func.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  // Arrow / anonymous: climb to the containing variable or property.
  const parent = func.getParent();
  if (parent !== undefined) {
    if (Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return "<anon>";
}

/** One call site attributed to a package export. */
export interface AttributedCall {
  readonly call: CallExpression;
  readonly packageName: string;
  readonly exportPath: string[];
}

export function attributedCalls(
  sourceFile: SourceFile,
  packages: readonly string[],
  resolution: ResolutionStore,
): AttributedCall[] {
  if (packages.length === 0) {
    return [];
  }

  // A file that cannot reach the package has no call to attribute,
  // and asking the store per call pays the wave walk for every miss.
  const [reaching] = resolution.filesImportingTransitively([
    { sourceFiles: [sourceFile], packages: [...packages] },
  ]);
  if (reaching === undefined || !reaching.has(sourceFile)) {
    return [];
  }

  // Every callee and receiver in the file goes into one batched ask,
  // so the whole file pays one demand set and one derivation. Names
  // that can never be a package's export are not seeded.
  const calls: CallExpression[] = [];
  const candidates = new Set<Node>();
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    calls.push(node);
    const callee = node.getExpression();
    if (couldBePackageLinked(callee, packages)) {
      candidates.add(callee);
    }
    if (
      Node.isPropertyAccessExpression(callee) &&
      couldBePackageLinked(callee.getExpression(), packages)
    ) {
      candidates.add(callee.getExpression());
    }
  });
  const origins = resolution.importOriginsOfMany(
    [...candidates],
    [...packages],
  );

  // The store refuses two candidates rather than picking one, and so
  // does this: one origin is an attribution, several are an ambiguity.
  function originOf(
    value: Node,
  ): { packageName: string; exportPath: string[] } | null {
    const found = origins.get(value) ?? [];
    const first = found[0];
    if (first === undefined || found.length > 1) {
      return null;
    }
    const { packageName, subPath } = splitPackageSpec(first.module);
    return { packageName, exportPath: [...subPath, ...first.path] };
  }

  function attributeCall(
    callee: Node,
  ): { packageName: string; exportPath: string[] } | null {
    const direct = originOf(callee);
    if (direct !== null) {
      return direct;
    }

    if (!Node.isPropertyAccessExpression(callee)) {
      return null;
    }
    const subject = originOf(callee.getExpression());
    if (subject === null) {
      return null;
    }
    // A method the package declares extends the export path; one the
    // language gives every value (`.map`, `.then`) says nothing about
    // the package, so the path stops at what was called.
    if (!methodComesFromSource(callee)) {
      return subject;
    }
    return {
      packageName: subject.packageName,
      exportPath: [...subject.exportPath, callee.getName()],
    };
  }

  const results: AttributedCall[] = [];
  for (const call of calls) {
    const provenance = attributeCall(call.getExpression());
    if (provenance !== null) {
      results.push({ call, ...provenance });
    }
  }

  return results;
}

/**
 * Whether this name could possibly come down to a package's export. A
 * local function, method, or class declaration is the project's own,
 * and an import from a relative specifier points at a project file,
 * so neither is worth a store seed. Everything else stays a
 * candidate.
 */
function couldBePackageLinked(
  value: Node,
  packages: readonly string[],
): boolean {
  if (!Node.isIdentifier(value)) {
    return true;
  }
  const declarations = value.getSymbol()?.getDeclarations() ?? [];
  if (declarations.length === 0) {
    return true;
  }
  return !declarations.every(
    (declaration) =>
      Node.isFunctionDeclaration(declaration) ||
      Node.isMethodDeclaration(declaration) ||
      Node.isClassDeclaration(declaration) ||
      (Node.isImportSpecifier(declaration) &&
        importAimsElsewhere(declaration, packages)),
  );
}

/** A relative import, or one of a package nobody asked about. */
function importAimsElsewhere(
  declaration: ImportSpecifier,
  packages: readonly string[],
): boolean {
  const specifier = declaration
    .getImportDeclaration()
    .getModuleSpecifierValue();
  if (specifier.startsWith(".")) {
    return true;
  }
  const { packageName } = splitPackageSpec(specifier);
  return !packages.some(
    (one) =>
      one === specifier || splitPackageSpec(one).packageName === packageName,
  );
}

/**
 * Whether a method is one somebody wrote, rather than one the language
 * gives every value. `map`, `then`, and `trim` are declared in
 * TypeScript's own lib files, and a method a package declares is
 * declared in that package.
 */
function methodComesFromSource(callee: PropertyAccessExpression): boolean {
  const declarations = callee.getNameNode().getSymbol()?.getDeclarations();
  if (declarations === undefined || declarations.length === 0) {
    // Nothing says where it came from, so the path keeps what the
    // source wrote, which is what it did before this check.
    return true;
  }
  return declarations.some(
    (declaration) => !isLanguageLib(declaration.getSourceFile()),
  );
}

export function discoverPackageImports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "packageImport" }>,
  kind: string,
  resolution: ResolutionStore,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  // One unit per (enclosing function × exportPath): the consumer
  // summary describes the function's behaviour around the boundary,
  // not each call site.
  const seen = new Set<string>();

  for (const one of attributedCalls(
    sourceFile,
    match.packages ?? [],
    resolution,
  )) {
    const enclosing = findEnclosingFunction(one.call);
    if (enclosing === null) {
      continue;
    }

    const key = `${enclosing.getStart()}-${enclosing.getEnd()}-${one.packageName}::${one.exportPath.join(".")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    results.push({
      func: enclosing,
      kind,
      name: enclosingFunctionName(enclosing),
      packageExportInfo: {
        packageName: one.packageName,
        exportPath: one.exportPath,
      },
    });
  }

  return results;
}
