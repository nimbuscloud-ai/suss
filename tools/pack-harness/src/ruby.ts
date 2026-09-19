/**
 * Running a Ruby pack over a project, the way extraction runs it.
 *
 * The TypeScript harness next to this one writes snippets into a
 * ts-morph project. Ruby has no compiler to hand a snippet to, so this
 * parses the files, emits the same facts a run emits, binds the
 * evaluator to them, and asks the storage recognizer what the calls in
 * one file come to.
 */

import fs from "node:fs";
import path from "node:path";

import {
  bindEvaluator,
  collectFileConstants,
  emitConstantBindings,
  emitValueFacts,
  findRubyFiles,
  methodDefinitionsIn,
  parseRuby,
  storageEffects,
} from "@suss/adapter-ruby";
import { Database } from "@suss/datalog";

import type { RbNode, RubyPack } from "@suss/adapter-ruby";
import type { Effect } from "@suss/behavioral-ir";

/** A Ruby pack, ready to be asked what it makes of some code. */
export interface RubyPackHarness {
  /** The effects the pack emits over one file, given the files around it. */
  effectsAcross(
    files: Record<string, string>,
    entry: string,
  ): Promise<Effect[]>;
  /** The same over every `.rb` file under a directory, reporting the calls in `entry`. */
  effectsUnder(directory: string, entry: string): Promise<Effect[]>;
}

export function rubyPackUnderTest(...packs: RubyPack[]): RubyPackHarness {
  const options = storageOptionsOf(packs);

  const effectsAcross = async (
    files: Record<string, string>,
    entry: string,
  ): Promise<Effect[]> => {
    const db = new Database();
    const parsed: Array<{ file: string; root: RbNode }> = [];
    const constants = [];
    for (const [file, source] of Object.entries(files)) {
      const tree = await parseRuby(source);
      emitValueFacts(db, file, tree.rootNode);
      constants.push(collectFileConstants(file, tree.rootNode, []));
      parsed.push({ file, root: tree.rootNode });
    }
    emitConstantBindings(db, constants);
    bindEvaluator(db, {
      files: parsed,
      definitions: new Map(
        parsed.flatMap(({ file, root }) => [
          ...methodDefinitionsIn(file, root),
        ]),
      ),
    });

    const read = parsed.find(({ file }) => file === entry);
    if (read === undefined) {
      const given = Object.keys(files).join(", ");
      throw new Error(`the entry "${entry}" is not among the files: ${given}`);
    }
    return storageEffects(callsUnder(read.root), entry, {
      ...options,
      facts: db,
    });
  };

  return {
    effectsAcross,
    effectsUnder: async (directory, entry) => {
      const files = Object.fromEntries(
        findRubyFiles(directory).map((file) => [
          file,
          fs.readFileSync(file, "utf8"),
        ]),
      );
      return effectsAcross(files, path.join(directory, entry));
    },
  };
}

/** What every pack in the run says about the database, pooled the way a run pools it. */
function storageOptionsOf(packs: readonly RubyPack[]) {
  return {
    patterns: packs.flatMap((pack) => pack.storage ?? []),
    loaders: packs.flatMap((pack) => pack.loaders ?? []),
    rawSql: packs.flatMap((pack) => pack.rawSql ?? []),
  };
}

/** Every call written under a node. */
function callsUnder(node: RbNode, found: RbNode[] = []): RbNode[] {
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
