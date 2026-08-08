// declaredSurface.mjs
//
// What a package says it exposes, read from its own manifest through the
// TypeScript compiler. Nothing suss produced goes into the answer, which
// is what makes it worth checking a run against.
//
// Two readers share this. The invariant asks whether every declared
// export produced a summary. The dogfood count asks how many summaries
// are on that surface and how many are behind it. A second definition of
// "public surface" would let the two disagree about the same package,
// with the gate built on one of them and the invariant on the other.

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

/**
 * Each export surface a manifest declares, as the sub-path it is reached
 * by and the declaration file that describes it. A sub-path export shows
 * up in a boundary key with its own segment, so `./schemas` gets the
 * prefix `["schemas"]` and the root carries none.
 */
function declaredEntryPoints(packageJson, dir) {
  const entries = [];
  for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
    const types = typeof target === "string" ? null : target?.types;
    if (typeof types !== "string") {
      continue;
    }

    const declarationFile = path.join(dir, types);
    if (!fs.existsSync(declarationFile)) {
      continue;
    }

    entries.push({
      subpath,
      declarationFile,
      prefix: subpath === "." ? [] : subpath.replace(/^\.\//, "").split("/"),
    });
  }
  return entries;
}

/**
 * Every export of a declaration file, by name, saying which ones a
 * caller can call. A class is exported and not callable: `new Database()`
 * is a construct signature, and its methods are surface a caller reaches
 * even though the name itself takes no call.
 *
 * Memoised on the declaration file, because reading one means building a
 * TypeScript program for it and both readers ask about every package in
 * the workspace.
 */
const exportsByFile = new Map();

function moduleExports(declarationFile) {
  const memoised = exportsByFile.get(declarationFile);
  if (memoised !== undefined) {
    return memoised;
  }

  const program = ts.createProgram([declarationFile], {
    target: ts.ScriptTarget.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(declarationFile);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const names = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).map((symbol) => ({
        name: symbol.getName(),
        callable:
          checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures()
            .length > 0,
      }))
    : [];

  exportsByFile.set(declarationFile, names);
  return names;
}

/**
 * Every export a package declares, as the dotted path a boundary key
 * carries and a label naming it the way a person would.
 *
 * `callable` says whether a caller can call the name itself. Requiring a
 * summary is only meaningful for those, since a type alias has no
 * behaviour to summarise; deciding whether a summary describes the
 * public surface takes the wider set.
 */
export function declaredExports(packageJson, dir) {
  return declaredEntryPoints(packageJson, dir).flatMap((entry) =>
    moduleExports(entry.declarationFile).map((exported) => ({
      path: [...entry.prefix, exported.name].join("."),
      label: `${packageJson.name}${entry.subpath === "." ? "" : entry.subpath.slice(1)}::${exported.name}`,
      callable: exported.callable,
    })),
  );
}

/**
 * Whether an export path is reached through something the package
 * declares.
 *
 * An exact match is the common case. A longer path counts when one of
 * its prefixes is declared, which is how a method on a returned object
 * gets in: a caller who has `createTypeScriptAdapter` can call
 * `createTypeScriptAdapter.extractAll`, and consumers in this workspace
 * do. A path with no declared prefix is behind the surface however
 * suss reached it.
 */
function onDeclaredSurface(exportPath, declaredPaths) {
  return exportPath.some((_, i) =>
    declaredPaths.has(exportPath.slice(0, i + 1).join(".")),
  );
}

/**
 * A package's library summaries, split by whether they describe its
 * public surface or the code behind it.
 *
 * Both sides are worth counting and they answer different questions.
 * `exported` is how much of what the package promises callers suss can
 * describe, and it moves when the package's promises move. `internal`
 * is how far the transitive closure got into the package's own code,
 * and it moves when extraction changes or when someone refactors.
 * Adding a private helper is the case that makes mixing them wrong: it
 * changes nothing a caller can reach, and under one count it reads as
 * the package having grown its API.
 */
export function librarySummariesBySurface(summaries, declaredPaths) {
  const exported = [];
  const internal = [];
  for (const summary of summaries) {
    if (summary.kind !== "library") {
      continue;
    }
    const exportPath = summary.identity.boundaryBinding?.semantics?.exportPath;
    if (
      Array.isArray(exportPath) &&
      onDeclaredSurface(exportPath, declaredPaths)
    ) {
      exported.push(summary);
      continue;
    }
    internal.push(summary);
  }
  return { exported, internal };
}
