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
import type { CallExpression } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore } from "./facts/store.js";

export function flagReads(
  func: FunctionRoot,
  parameterNames: readonly string[],
  parsers: readonly ArgumentParser[],
  resolution: ResolutionStore | undefined,
  barriers: DescentBarriers = NO_BARRIERS,
): InputRead[] {
  const text = func.getSourceFile().getFullText();
  const imported = parsers.filter((parser) => text.includes(parser.module));
  if (
    imported.length === 0 ||
    parameterNames.length === 0 ||
    resolution === undefined
  ) {
    return [];
  }

  const reads: InputRead[] = [];
  func.forEachDescendant((node, traversal) => {
    if (barriers.has(node) || startsItsOwnScope(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const parser = parserCalled(node, imported, resolution);
    if (parser !== null) {
      reads.push(...flagsDeclared(node, parser, parameterNames, resolution));
    }
  });
  return reads;
}

/** The parser a call goes to, by the module export its callee comes from. */
function parserCalled(
  call: CallExpression,
  parsers: readonly ArgumentParser[],
  resolution: ResolutionStore,
): ArgumentParser | null {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const origins = resolution.importOriginsOf(
    callee,
    parsers.map((parser) => parser.module),
  );
  return (
    parsers.find((parser) =>
      origins.some(
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
