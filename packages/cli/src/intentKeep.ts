/**
 * `suss intent keep` turns a change list into boundary intent documents
 * once the work is done, so a team that keeps intent does not write down
 * again what the agent already said.
 *
 * Each `adds` or `changes` entry compiles into transitions of a
 * `kind: boundary` document: one per outcome a boundary entry lists, and
 * one for an effect entry. A `removes` entry has nothing to compile to,
 * because a document states what a boundary does and not what it
 * stopped doing. The documents take `source: author`, the request as
 * their purpose, and each transition's `when` from the code as it is
 * now, the same way `suss infer intent` writes it.
 */

import fs from "node:fs";
import path from "node:path";

import { BOUNDARY_ROLE, deploymentOf, displayLabel } from "@suss/behavioral-ir";
import {
  codeEffectsOf,
  effectMatches,
  endingOf,
  outcomeMatches,
} from "@suss/checker-intent";
import { loadIntentDoc } from "@suss/contract-intent";
import { toIntentEffect } from "@suss/intent-ir";
import { namesBoundaryExactly } from "@suss/ir-core";

import { readChangeList } from "./intentCheckCommand.js";
import {
  boundaryBlock,
  PARAGRAPHS,
  readSummariesFile,
  render,
  slug,
  statusOutcomeId,
  unique,
} from "./intentDraftCommand.js";
import { draftedWhen } from "./intentWhen.js";

import type {
  BehavioralSummary,
  Deployment,
  Transition,
} from "@suss/behavioral-ir";
import type {
  ChangeListSummary,
  ChangeOutcome,
  EffectOutcome,
  IntentChange,
  IntentEffect,
  When,
} from "@suss/intent-ir";

/** A transition as the document writes it. */
export interface KeptTransition {
  id: string;
  when: When;
  response?: { status: number };
  returns?: Record<string, never>;
  throws?: { errorType?: string };
  results?: EffectOutcome[];
}

export interface KeptDocument {
  file: string;
  boundary: string;
  yaml: string;
}

export interface KeepResult {
  kept: KeptDocument[];
  /** Entries and boundaries that got no document, and why. */
  skipped: string[];
}

export interface IntentKeepOptions {
  /** The change list. */
  changes: string;
  /** The summaries of the code as it is now: a folder or one file. */
  dir: string;
  /** Who calls these boundaries, for the documents' `audience`. */
  audience: string;
  /** Where the documents go. Default: `intent/`. */
  into?: string;
}

const DEFAULT_INTO = "intent";

/**
 * The transitions one entry compiles to. `when` is the entry's note, or
 * else the request it quotes, until the code supplies one.
 */
export function changeTransitions(change: IntentChange): KeptTransition[] {
  if (change.verb === "removes") {
    return [];
  }
  const when =
    change.note ?? change.asked ?? "the change list gives no condition";
  if (change.subject.kind === "effect") {
    return [effectTransition(change.subject.effect, when)];
  }
  return change.outcomes.map((outcome) => outcomeTransition(outcome, when));
}

const ENDINGS: Record<
  ChangeOutcome["kind"],
  (outcome: ChangeOutcome) => Omit<KeptTransition, "when">
> = {
  response: (outcome) => ({
    id: statusOutcomeId(outcome.status ?? 0),
    response: { status: outcome.status ?? 0 },
  }),
  return: () => ({ id: "returns", returns: {} }),
  throw: (outcome) =>
    outcome.errorType === null
      ? { id: "throws", throws: {} }
      : {
          id: `throws-${slug(outcome.errorType)}`,
          throws: { errorType: outcome.errorType },
        },
  effect: () => ({ id: "effect" }),
};

function outcomeTransition(outcome: ChangeOutcome, when: When): KeptTransition {
  return { ...ENDINGS[outcome.kind](outcome), when };
}

function effectTransition(effect: IntentEffect, when: When): KeptTransition {
  const line: EffectOutcome = {
    [effect.does]: effect.names,
    ...(effect.fields.length > 0 ? { fields: effect.fields } : {}),
    ...(effect.by.length > 0 ? { by: effect.by } : {}),
  };
  return { id: slug(`${effect.does} ${effect.names}`), when, results: [line] };
}

/** One document per boundary the entries add to or change. */
export function keptDocuments(
  list: ChangeListSummary,
  summaries: BehavioralSummary[],
  audience: string,
): KeepResult {
  const result: KeepResult = { kept: [], skipped: [] };
  const deploymentOfUnit = deploymentOf(summaries);
  const names = new Set<string>();
  for (const [place, changes] of byBoundary(list, result.skipped)) {
    const server = summaries.find(
      (summary) =>
        BOUNDARY_ROLE[summary.kind] === "provider" &&
        summary.identity.boundaryBinding !== null &&
        namesBoundaryExactly(place, summary.identity.boundaryBinding),
    );
    const binding = server?.identity.boundaryBinding ?? null;
    const block = binding === null ? null : boundaryBlock(binding);
    if (server === undefined || binding === null || block === null) {
      result.skipped.push(
        `${place}: nothing in these summaries serves it, so there is no boundary block to write.`,
      );
      continue;
    }
    const asked = [...new Set(changes.flatMap((change) => change.asked ?? []))];
    if (asked.length === 0) {
      result.skipped.push(
        `${place}: no entry about it quotes the request, so the document would have no purpose.`,
      );
      continue;
    }

    const deployment = deploymentFor(server, deploymentOfUnit);
    const ids = new Set<string>();
    const transitions = changes
      .flatMap(changeTransitions)
      .map(({ id, when, ...ending }) => ({
        id: unique(id, ids),
        when: whenInCode({ id, when, ...ending }, server, deployment),
        ...ending,
      }));
    const label = displayLabel(binding);
    const doc = {
      kind: "boundary" as const,
      name: unique(slug(label) || "boundary", names),
      purpose: asked.join(" "),
      audience,
      source: "author" as const,
      boundary: block,
      transitions,
    };
    loadIntentDoc(doc);
    result.kept.push({
      file: `${doc.name}.intent.yaml`,
      boundary: label,
      yaml: `${header(label).join("\n")}\n\n${render(doc, {}, PARAGRAPHS)}`,
    });
  }
  return result;
}

/** What the deployment sets the unit's variables to, so `when` spells a store the way `results` does. */
function deploymentFor(
  server: BehavioralSummary,
  deploymentOfUnit: (unit: BehavioralSummary) => Deployment,
): Deployment {
  return deploymentOfUnit(server);
}

/**
 * The entries that compile to something, by the boundary they are about.
 * An effect entry with no `at` belongs to no one document, so it is
 * reported and left out.
 */
function byBoundary(
  list: ChangeListSummary,
  skipped: string[],
): Map<string, IntentChange[]> {
  const groups = new Map<string, IntentChange[]>();
  for (const change of list.changes) {
    if (changeTransitions(change).length === 0) {
      continue;
    }
    const place =
      change.subject.kind === "boundary" ? change.subject.names : change.at;
    if (place === null) {
      skipped.push(
        `${change.subject.kind === "effect" ? `${change.subject.effect.does} ${change.subject.effect.names}` : "an entry"}: it gives no at, so no one boundary's document can take it.`,
      );
      continue;
    }
    groups.set(place, [...(groups.get(place) ?? []), change]);
  }
  return groups;
}

/**
 * The condition the code has now for this outcome, written the way the
 * drafter writes it. The compiled `when` stays when no transition of the
 * serving unit ends that way, or makes that effect itself.
 */
function whenInCode(
  transition: KeptTransition,
  server: BehavioralSummary,
  deployment: Deployment,
): When {
  const index = server.transitions.findIndex((candidate) =>
    endsOrActsAs(transition, candidate, deployment),
  );
  const found = server.transitions[index];
  return found === undefined
    ? transition.when
    : draftedWhen(found, server, index === 0, deployment);
}

function endsOrActsAs(
  transition: KeptTransition,
  candidate: Transition,
  deployment: Deployment,
): boolean {
  const wanted = endingWanted(transition);
  if (wanted !== null) {
    const ending = endingOf(candidate);
    return ending !== null && outcomeMatches(wanted, ending);
  }
  const effects = (transition.results ?? []).map(toIntentEffect);
  const made = codeEffectsOf(candidate, deployment);
  return effects.every((effect) =>
    made.some((one) => effectMatches(effect, one)),
  );
}

function endingWanted(transition: KeptTransition): ChangeOutcome | null {
  if (transition.response !== undefined) {
    return {
      kind: "response",
      status: transition.response.status,
      errorType: null,
    };
  }
  if (transition.returns !== undefined) {
    return { kind: "return", status: null, errorType: null };
  }
  if (transition.throws !== undefined) {
    return {
      kind: "throw",
      status: null,
      errorType: transition.throws.errorType ?? null,
    };
  }
  return null;
}

function header(label: string): string[] {
  return [
    `# ${label}, kept from the change list of a supervised session.`,
    "#",
    "# purpose is the request that asked for the work, and each when is the",
    "# condition the code had when the work was done. Rename the outcome ids",
    "# to what your team calls them.",
  ];
}

export function intentKeep(options: IntentKeepOptions): number {
  const list = readChangeList(options.changes);
  const result = keptDocuments(
    list,
    readSummariesFile(options.dir),
    options.audience,
  );
  const dir = path.resolve(options.into ?? DEFAULT_INTO);
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const doc of result.kept) {
    const target = path.join(dir, doc.file);
    if (fs.existsSync(target)) {
      result.skipped.push(
        `${doc.boundary}: ${target} already exists, so merge the two by hand.`,
      );
      continue;
    }
    fs.writeFileSync(target, doc.yaml);
    written.push(target);
  }

  const lines = [
    written.length === 0
      ? "Kept no intent documents."
      : `Kept ${written.length} intent document${written.length === 1 ? "" : "s"}:`,
    ...written.map((file) => `  ${file}`),
    ...(result.skipped.length === 0 ? [] : ["", "Left out:"]),
    ...result.skipped.map((reason) => `  - ${reason}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return written.length === 0 ? 1 : 0;
}
