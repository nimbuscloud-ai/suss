/**
 * What every unit is read with beyond its own pack's patterns, whichever
 * pack discovered it: the terminals a runtime ends the process with, and
 * the command-line parsers it provides. A pack's recognizers reach every
 * unit the same way, and are collected on their own.
 */

import type {
  ArgumentParser,
  PatternPack,
  TerminalPattern,
} from "@suss/extractor";

export interface EveryUnitDeclarations {
  terminals: readonly TerminalPattern[];
  argumentParsers: readonly ArgumentParser[];
}

export const NOTHING_IN_EVERY_UNIT: EveryUnitDeclarations = {
  terminals: [],
  argumentParsers: [],
};

export function everyUnitDeclarationsOf(
  frameworks: readonly PatternPack[],
): EveryUnitDeclarations {
  return {
    terminals: frameworks.flatMap((pack) =>
      pack.terminals.filter((pattern) => pattern.inEveryUnit === true),
    ),
    argumentParsers: frameworks.flatMap((pack) => pack.argumentParsers ?? []),
  };
}
