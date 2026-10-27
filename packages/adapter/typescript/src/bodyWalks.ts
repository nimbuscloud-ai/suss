/**
 * bodyWalks.ts: the walks over a function body that do not depend on
 * which unit is being read, done once per body while the store's facts
 * stay the same.
 *
 * A component with a GraphQL operation per hook is read once for each
 * operation, and each read walks the same body for its terminals, its
 * calls, and what each recognizer makes of them. A repeat gets copies
 * of the first walk's results, since passes after assembly edit effects
 * in place, and replays what the walk left behind: the named types it
 * defined, the files it read, and the effects each pack's recognizers
 * counted. A walk that read new facts into the store is not kept, since
 * its first questions saw fewer facts than a repeat would.
 */

import { recordFileDependency, withFilesNoted } from "./depTracking.js";
import {
  definitionsInProgress,
  withDefinitionsNoted,
  writeNotedDefinitions,
} from "./shapes/definitions.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { PackTally, RawCondition } from "@suss/extractor";
import type { Node } from "ts-morph";
import type { ResolutionStore } from "./facts/store.js";
import type {
  InvocationEffectLocation,
  RecognizedEffectLocation,
} from "./resolve/invocationEffects.js";
import type { FoundTerminal } from "./terminals/shared.js";

export interface BodyWalk {
  terminals: FoundTerminal[];
  invocations: InvocationEffectLocation[];
  recognized: RecognizedEffectLocation[];
}

/** What a walk was asked with. A walk asked differently is a different walk. */
export interface BodyWalkInputs {
  terminalPatterns: readonly object[];
  invocationRecognizers: readonly object[];
  accessRecognizers: readonly object[];
  barriers: ReadonlySet<Node>;
  resolution: ResolutionStore | undefined;
  /** Whether the walk can ask where a value comes from, find anchors, and resolve callees. */
  callbacks: readonly boolean[];
}

interface KeptWalk {
  key: string;
  facts: number;
  walk: BodyWalk;
  definitions: Array<[string, TypeShape]>;
  files: string[];
  effectsByTally: Map<PackTally, number>;
}

const keptByBody = new WeakMap<Node, KeptWalk[]>();
const talliesByRecognizer = new WeakMap<object, PackTally>();
const ids = new WeakMap<object, number>();
let nextId = 1;

/** Say which pack's tally a recognizer counts its effects into. */
export function noteRecognizerTally(
  recognizer: object,
  tally: PackTally,
): void {
  talliesByRecognizer.set(recognizer, tally);
}

/**
 * The walk's results, from `walk` or from an earlier walk of the same
 * body asked the same way over the same facts.
 */
export function walkBodyOnce(
  body: Node,
  inputs: BodyWalkInputs,
  walk: () => BodyWalk,
): BodyWalk {
  const key = keyOf(inputs);
  const facts = inputs.resolution?.sourceFactCount() ?? -1;
  const kept = keptByBody
    .get(body)
    ?.find((one) => one.key === key && one.facts === facts);
  if (kept !== undefined) {
    return replay(kept);
  }

  const before = new Map(
    [...talliesOf(inputs)].map((tally) => [tally, tally.effectsRecognized]),
  );
  const read = withFilesNoted(() => withDefinitionsNoted(walk));
  const { value, noted } = read.value;
  const factsAfter = inputs.resolution?.sourceFactCount() ?? -1;
  if (noted === null || factsAfter !== facts) {
    return value;
  }
  const effectsByTally = new Map<PackTally, number>();
  for (const [tally, count] of before) {
    effectsByTally.set(tally, tally.effectsRecognized - count);
  }
  const entry: KeptWalk = {
    key,
    facts,
    walk: copyWalk(value),
    definitions: noted.map(([name, shape]) => [name, structuredClone(shape)]),
    files: read.files,
    effectsByTally,
  };
  const forBody = keptByBody.get(body);
  if (forBody === undefined) {
    keptByBody.set(body, [entry]);
  } else {
    forBody.push(entry);
  }
  return value;
}

function replay(kept: KeptWalk): BodyWalk {
  writeNotedDefinitions(kept.definitions);
  for (const filePath of kept.files) {
    recordFileDependency(filePath);
  }
  for (const [tally, count] of kept.effectsByTally) {
    tally.effectsRecognized += count;
  }
  return copyWalk(kept.walk);
}

function keyOf(inputs: BodyWalkInputs): string {
  const barrierIds = [...inputs.barriers].map(idOf).sort((a, b) => a - b);
  return [
    inputs.terminalPatterns.map(idOf).join(","),
    idOf(inputs.invocationRecognizers),
    idOf(inputs.accessRecognizers),
    barrierIds.join(","),
    inputs.resolution === undefined ? 0 : idOf(inputs.resolution),
    inputs.callbacks.map((present) => (present ? 1 : 0)).join(""),
    // A walk with no table to write named types into notes none, so it
    // cannot stand in for one that has a table.
    definitionsInProgress() === null ? 0 : 1,
  ].join("|");
}

function idOf(value: object): number {
  const known = ids.get(value);
  if (known !== undefined) {
    return known;
  }
  const id = nextId++;
  ids.set(value, id);
  return id;
}

function talliesOf(inputs: BodyWalkInputs): Set<PackTally> {
  const tallies = new Set<PackTally>();
  for (const recognizer of [
    ...inputs.invocationRecognizers,
    ...inputs.accessRecognizers,
  ]) {
    const tally = talliesByRecognizer.get(recognizer);
    if (tally !== undefined) {
      tallies.add(tally);
    }
  }
  return tallies;
}

/** A copy whose plain data is new and whose syntax nodes are the same. */
function copyWalk(walk: BodyWalk): BodyWalk {
  return {
    terminals: walk.terminals.map((found) => ({
      ...found,
      terminal: structuredClone(found.terminal),
      ...(found.whenAlso === undefined
        ? {}
        : { whenAlso: copyCondition(found.whenAlso) }),
    })),
    invocations: walk.invocations.map((site) => ({
      ...site,
      effect: structuredClone(site.effect),
    })),
    recognized: walk.recognized.map((site) => ({
      ...site,
      effect: structuredClone(site.effect),
      preconditions: site.preconditions.map(copyCondition),
      ...(site.slots === undefined
        ? {}
        : { slots: site.slots.map((slot) => ({ ...slot })) }),
    })),
  };
}

function copyCondition(condition: RawCondition): RawCondition {
  return structuredClone(condition);
}
