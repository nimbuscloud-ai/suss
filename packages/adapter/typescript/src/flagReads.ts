/**
 * The flags a command takes, read off the parser it hands its arguments to.
 *
 * ```ts
 * const { values } = parseArgs({ args, options: { dir: { type: "string" } } });
 * ```
 *
 * A command written that way receives `--dir` through `args`, and its
 * body never spells `args.dir`: the options object is the only place
 * the flag is written. Each of its keys becomes an input read of
 * `--<key>` off the parameter the call passes as its arguments, so an
 * intent document lists the flag as `"args.--dir"`.
 */

import { Node } from "ts-morph";

import { importedNamesOf, importedRootsOf } from "./discovery/importScan.js";
import {
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyOf,
} from "./discovery/resolveValue.js";
import {
  type DescentBarriers,
  NO_BARRIERS,
  startsItsOwnScope,
} from "./walk/descent.js";

import type { ArgumentParser, InputRead } from "@suss/extractor";
import type { CallExpression, SourceFile } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore } from "./facts/store.js";

export function flagReads(
  func: FunctionRoot,
  parameterNames: readonly string[],
  parsers: readonly ArgumentParser[],
  resolution: ResolutionStore | undefined,
  barriers: DescentBarriers = NO_BARRIERS,
): InputRead[] {
  if (
    parsers.length === 0 ||
    parameterNames.length === 0 ||
    resolution === undefined
  ) {
    return [];
  }
  const imported = parsers.filter((parser) =>
    importsParser(func.getSourceFile(), parser),
  );
  if (imported.length === 0) {
    return [];
  }
  const modules = [...new Set(imported.map((parser) => parser.module))];

  // Every callee goes into one question, so a function pays one
  // derivation however many calls it makes.
  const calls = namedCallsIn(func, barriers);
  const origins = resolution.importOriginsOfMany(
    calls.map((call) => call.getExpression()),
    modules,
  );
  return calls.flatMap((call) => {
    const parser = parserCalled(origins.get(call.getExpression()), imported);
    return parser === null
      ? []
      : flagsDeclared(call, parser, parameterNames, resolution);
  });
}

/**
 * Whether the file imports the parser itself, or the whole module it
 * comes from. Most files that import the module take something else
 * from it, and asking the store about each of their calls costs
 * seconds on a large project.
 */
function importsParser(
  sourceFile: SourceFile,
  parser: ArgumentParser,
): boolean {
  const modules = [parser.module];
  return (
    importedRootsOf(sourceFile, modules).size > 0 ||
    [...importedNamesOf(sourceFile, modules).values()].includes(parser.name)
  );
}

/** The calls in a body whose callee is a name or a member read. */
function namedCallsIn(
  func: FunctionRoot,
  barriers: DescentBarriers,
): CallExpression[] {
  const calls: CallExpression[] = [];
  func.forEachDescendant((node, traversal) => {
    if (barriers.has(node) || startsItsOwnScope(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) {
      calls.push(node);
    }
  });
  return calls;
}

/** The parser a call goes to, by the module export its callee comes from. */
function parserCalled(
  origins: ReadonlyArray<{ module: string; path: string[] }> | undefined,
  parsers: readonly ArgumentParser[],
): ArgumentParser | null {
  return (
    parsers.find((parser) =>
      (origins ?? []).some(
        (origin) =>
          origin.module === parser.module && origin.path[0] === parser.name,
      ),
    ) ?? null
  );
}

/** One read per flag the settings object declares, when it takes its arguments from a parameter. */
function flagsDeclared(
  call: CallExpression,
  parser: ArgumentParser,
  parameterNames: readonly string[],
  resolution: ResolutionStore,
): InputRead[] {
  const settingsArgument = call.getArguments()[parser.argument];
  const settings =
    settingsArgument === undefined
      ? null
      : objectLiteralOf(settingsArgument, resolution);
  if (settings === null) {
    return [];
  }
  const argv = propertyOf(settings, parser.argsKey, resolution);
  const input = argv === null ? null : argv.getText();
  const declared = propertyOf(settings, parser.optionsKey, resolution);
  const options =
    declared === null ? null : objectLiteralOf(declared, resolution);
  if (input === null || !parameterNames.includes(input) || options === null) {
    return [];
  }
  return propertiesOf(options, resolution).flatMap((option) => {
    const flag = propertyNameOf(option);
    return flag === null ? [] : [{ input, path: [`--${flag}`] }];
  });
}
