/**
 * The database work a body does, as the hooks packs declared with
 * `@suss/recognize` read it. The SQLAlchemy and SQLModel packs declare
 * their session, query and statement chains that way, under the name
 * `python-storage`. This module runs the hooks over a body's calls and
 * adds what a chain cannot know: one container per construction of the
 * method's class when the chain reads `self.model`. DESIGN.md says how
 * the chains match.
 */

import { runPackRecognizer } from "@suss/extractor";
import { factCallOps, SlotsHeard } from "@suss/recognize/ops";

import { children, enclosingFunction, field, rangeOf } from "./ast.js";
import {
  classesNamed,
  classNameOf,
  constructionRef,
  fieldArguments,
} from "./constructions.js";
import { pythonFactSource } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { rootOf } from "./modelNames.js";
import { bodyCalls } from "./paths/effects.js";
import { ownReceiverName } from "./reach/receivers.js";
import { constructionSitesOf, evaluationScope } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { PackRecognizer } from "@suss/extractor";
import type { HeardSlot } from "@suss/recognize/ops";
import type { PyNode } from "./parser.js";
import type { EffectAt } from "./paths/effects.js";
import type { BoundPythonFile } from "./routers.js";

/** The name the storage chains' accesses are recognized under. */
const STORAGE_RECOGNITION = "python-storage";

/**
 * The model a chain reads off its method's own receiver, as
 * `select(self.model)` does, under each construction of the method's
 * class. A method every repository shares has one model per repository,
 * so the binding has no container and a reader picks the one the
 * caller's repository gives. Null when no construction settles one.
 */
function containerByConstruction(
  root: PyNode,
  options: ConstructionLookup,
): Record<string, string> | null {
  const files = options.files;
  const model = receiverFieldModel(root, options);
  const name =
    model === null ? null : (field(model, "attribute")?.text ?? null);
  if (files === undefined || model === null || name === null) {
    return null;
  }
  const sites = constructionSitesOf(model, options.facts);
  const argumentKeys = fieldArguments(name, sites, options.facts, files);
  const classes = classesNamed(
    [...argumentKeys.values()],
    options.facts,
    files,
  );
  const found: Record<string, string> = {};
  for (const [site, key] of argumentKeys) {
    const cls = classes.get(key);
    const className = cls === undefined ? null : classNameOf(cls);
    const ref = constructionRef(site, files);
    if (className !== null && ref !== null) {
      found[ref] = className;
    }
  }
  return Object.keys(found).length === 0 ? null : found;
}

/** What naming a model by the constructions of a method's class reads. */
interface ConstructionLookup {
  readonly facts: Database;
  readonly filePath: string;
  readonly files?: ReadonlyMap<string, BoundPythonFile>;
}

/** The statement's model argument when it is a field of the method's own receiver, `self.model`, or null. */
function receiverFieldModel(
  root: PyNode,
  options: ConstructionLookup,
): PyNode | null {
  const args = field(root, "arguments");
  const first = (args === null ? [] : children(args)).find(
    (argument) => argument.type !== "keyword_argument",
  );
  const object = first?.type === "attribute" ? field(first, "object") : null;
  const fn = first === undefined ? null : enclosingFunction(first);
  if (first === undefined || object?.type !== "identifier" || fn === null) {
    return null;
  }
  return object.text === ownReceiverName(options.facts, options.filePath, fn)
    ? first
    : null;
}

/**
 * What discovery uses for one file. `factsPath` is the path the facts were
 * keyed under, which is the absolute one, while a summary shows the short one.
 */
export interface StorageLookup {
  readonly facts: Database;
  readonly factsPath: string;
  /** Every file in the run by absolute path, for naming a construction a model depends on. */
  readonly files?: ReadonlyMap<string, BoundPythonFile>;
  /** The hooks packs declared with `@suss/recognize`, run over every call in a body. */
  readonly declared?: readonly PackRecognizer[];
}

/** One column of one effect, and the key the rules read its value at. */
export interface EffectSlot extends HeardSlot {
  effect: Effect;
}

/** Effects, and the value each of their columns is given. */
export interface SlottedEffects {
  effects: EffectAt[];
  slots: EffectSlot[];
}

/** Each body's storage work by its node id, for as long as one evaluator lasts. */
const storageByScope = new WeakMap<object, Map<string, SlottedEffects>>();

/**
 * The database work a body does through a library and through SQL it
 * wrote itself, with the value each column is given.
 *
 * A file asks for its bodies' slot values before its units are built,
 * and each unit then reads its own body again, so the answer is kept.
 * It is kept per evaluator because a cache charge that starts evaluation
 * over has to recognize the body again to be charged for what it reads.
 * Every lookup in one run differs only by the file, which the key has.
 */
export function bodyStorage(
  definitionNode: PyNode,
  lookup: StorageLookup,
): SlottedEffects {
  const scope = evaluationScope(lookup.facts);
  if (scope === undefined) {
    return recognizeBodyStorage(definitionNode, lookup);
  }
  let kept = storageByScope.get(scope);
  if (kept === undefined) {
    kept = new Map();
    storageByScope.set(scope, kept);
  }
  const key = nodeId(lookup.factsPath, definitionNode);
  const known = kept.get(key);
  if (known !== undefined) {
    return known;
  }
  const found = recognizeBodyStorage(definitionNode, lookup);
  kept.set(key, found);
  return found;
}

function recognizeBodyStorage(
  definitionNode: PyNode,
  lookup: StorageLookup,
): SlottedEffects {
  return callStorage(bodyCalls(definitionNode, lookup.facts), lookup);
}

/** The same work for a list of calls, such as the ones a lambda makes. */
export function callStorage(
  calls: readonly PyNode[],
  lookup: StorageLookup,
): SlottedEffects {
  const declared = declaredStorage(calls, lookup);
  const found = [
    ...inCallOrder(
      declared.effects.filter(({ effect }) => readHere(effect)),
      calls,
    ).filter(({ effect }) => !readsNoTable(effect)),
    ...declared.effects.filter(({ effect }) => !readHere(effect)),
  ];
  const kept = new Set(found.map(({ effect }) => effect));
  return {
    effects: found,
    slots: declared.slots.filter((one) => kept.has(one.effect)),
  };
}

/**
 * Whether the effect is a read with no table, not even one per
 * construction of its method's class. Nothing could pair with it, and
 * the columns it lists belong to no table.
 */
function readsNoTable(effect: Effect): boolean {
  return (
    withoutContainer(effect) &&
    effect.type === "interaction" &&
    effect.interaction.class === "storage-access" &&
    effect.interaction.kind === "read" &&
    effect.containerByConstruction === undefined
  );
}

/**
 * Whether the effect is one of the storage chains' accesses. A body
 * lists those together, before what other packs read in it.
 */
function readHere(effect: Effect): boolean {
  return (
    effect.type === "interaction" &&
    effect.binding?.recognition === STORAGE_RECOGNITION
  );
}

/** The effects in the order the body makes the calls they were read at. */
function inCallOrder(
  effects: readonly EffectAt[],
  calls: readonly PyNode[],
): EffectAt[] {
  const position = new Map(calls.map((call, at) => [call.id, at]));
  return [...effects].sort(
    (a, b) => (position.get(a.at.id) ?? 0) - (position.get(b.at.id) ?? 0),
  );
}

/**
 * What the hooks a pack declared with `@suss/recognize` make of each
 * call, over the ops in `@suss/recognize/ops`, with the slots they state
 * about each effect. A hook reads only the ops on its context, so it
 * runs here unchanged from TypeScript.
 */
function declaredStorage(
  calls: readonly PyNode[],
  lookup: StorageLookup,
): SlottedEffects {
  const found: SlottedEffects = { effects: [], slots: [] };
  const constructions: ConstructionLookup = {
    facts: lookup.facts,
    filePath: lookup.factsPath,
    ...(lookup.files === undefined ? {} : { files: lookup.files }),
  };
  for (const { call, effects, heard } of declaredReads(calls, lookup, true)) {
    for (const effect of effects) {
      const located = { ...effect, location: rangeOf(call) };
      const byConstruction = withoutContainer(located)
        ? containerByConstruction(rootOf(call), constructions)
        : null;
      if (located.type === "interaction" && byConstruction !== null) {
        located.containerByConstruction = byConstruction;
      }
      found.effects.push({ effect: located, at: call });
      found.slots.push(
        ...heard.of(effect).map((one) => ({ ...one, effect: located })),
      );
    }
  }
  return found;
}

/** Whether the effect is a storage access that states no container. */
function withoutContainer(effect: Effect): boolean {
  if (
    effect.type !== "interaction" ||
    effect.interaction.class !== "storage-access"
  ) {
    return false;
  }
  const semantics = effect.binding?.semantics;
  return (
    semantics !== undefined &&
    "container" in semantics &&
    semantics.container === null
  );
}

/**
 * The calls the declared hooks claim, by node id, so the reach walk does
 * not report them as lost: the call a hook read, or the call that starts
 * the chain for a hook that reads a chain at its last call.
 */
export function declaredCallIds(
  calls: readonly PyNode[],
  lookup: StorageLookup,
): number[] {
  return declaredReads(calls, lookup, false).flatMap(({ claims }) =>
    claims.map((claimed) => claimed.id),
  );
}

/** What the declared hooks made of one call. */
interface DeclaredRead {
  readonly call: PyNode;
  readonly effects: Effect[];
  readonly heard: SlotsHeard;
  /** The calls the hooks that matched claim. */
  readonly claims: PyNode[];
}

/**
 * Each call some declared hook read, with every effect the hooks made of
 * it, and when `listening`, the slots they stated about each one. A hook
 * that matches and records nothing still claims its call.
 */
function declaredReads(
  calls: readonly PyNode[],
  lookup: StorageLookup,
  listening: boolean,
): DeclaredRead[] {
  const hooks = lookup.declared ?? [];
  if (hooks.length === 0) {
    return [];
  }
  const source = pythonFactSource(lookup.facts);
  return calls.flatMap((call) => {
    const ops = factCallOps(nodeId(lookup.factsPath, call), source);
    const heard = new SlotsHeard();
    if (ops !== null && listening) {
      Object.assign(ops, { statesSlots: heard.listen });
    }
    const at = { file: lookup.factsPath, line: rangeOf(call).start };
    const read =
      ops === null
        ? []
        : hooks.flatMap((hook) => {
            const made = runPackRecognizer(hook, at, call, { ops });
            return made === null ? [] : [{ hook, made }];
          });
    if (read.length === 0) {
      return [];
    }
    const claims = read.map(({ hook }) =>
      hook.recognize.claimsChainStart === true ? rootOf(call) : call,
    );
    return [
      {
        call,
        effects: read.flatMap(({ made }) => made),
        heard,
        claims: [...new Map(claims.map((one) => [one.id, one])).values()],
      },
    ];
  });
}
