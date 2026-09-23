/**
 * Matches a boundary question against storage accesses by their deployed
 * names as well as their written ones.
 *
 * A question matches a binding by its tokens, and a storage access whose
 * container is a reference is written `{SUBSCRIBER_TABLE}` instead of the
 * store it reaches once deployed. Grounding supplies the deployed name:
 * the value a wrangler `[vars]` block sets, or the argument a caller
 * passed. The join is the checker's `groundStorageAccesses`, the same one
 * `check` uses to attribute findings. Matching then follows the
 * provider-access claims, so a question that matched one side of a pair
 * reports the other side too, and both names for one store give the same
 * answer.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";
import { groundStorageAccesses } from "@suss/checker";

import {
  boundariesTouchedBy,
  boundarySpelling,
  namesBoundary,
  spellingTokens,
} from "./boundaryReach.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type {
  GroundedBy,
  GroundedStorageAccess,
  GroundedStorageProvider,
} from "@suss/checker";
import type { TouchedBoundary } from "./boundaryReach.js";
import type { TargetTouch } from "./target.js";

/** One deployed name an access grounds to, and who supplied it. */
export interface GroundingNote {
  to: string;
  /** Who supplied the name, as the answer prints it: a manifest file or a caller's id. */
  by: string;
}

export interface GroundedTouch extends TargetTouch {
  /** Set when the touch's container grounds to a deployed name. */
  grounding?: GroundingNote[];
}

export interface GroundedTouches {
  touches: GroundedTouch[];
  /**
   * One sentence per ungrounded access on the storage system the question
   * mentions, saying which input would show whether it belongs in the
   * answer.
   */
  hints: string[];
}

/**
 * Every unit that does something at the boundary in the question. A unit
 * matches by its binding's own words, by a deployed name that grounding
 * found, or through a provider-access claim between the two.
 */
export function groundedTouchesAt(
  subject: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): GroundedTouches {
  const { accesses, providers } = groundStorageAccesses([...summaries]);
  const byBinding = new Map(accesses.map((record) => [record.binding, record]));

  const matchedBindings = new Set<BoundaryBinding>();
  for (const record of accesses) {
    if (matchesAccess(subject, record)) {
      matchedBindings.add(record.binding);
    }
  }

  const matchedProviders = new Set<BehavioralSummary>();
  for (const provider of providers) {
    if (matchesProvider(subject, provider)) {
      matchedProviders.add(provider.summary);
    }
  }

  closeOverClaims(accesses, matchedBindings, matchedProviders);

  const touches: GroundedTouch[] = [];
  // One line per unit, boundary and relation, however many accesses
  // record it. See `keep` for which record wins.
  const answered = new Map<string, number>();

  // Storage touches come from the grounded accesses because only they say
  // which table a read through a relation arrives at. The effects would
  // put it on the queried table, which `check` says it does not touch.
  for (const record of accesses) {
    if (!matchedBindings.has(record.binding)) {
      continue;
    }
    const touched: TouchedBoundary = {
      label: boundarySpelling(record.binding),
      binding: record.binding,
      relation: record.kind === "read" ? "reads" : "writes",
      callee: record.callee,
      detail: undefined,
      transitionId: undefined,
    };
    const key = asTouchKey({ summary: record.summary, touched });
    const notes = groundingNotes(record);
    keep(touches, answered, key, {
      summary: record.summary,
      touched,
      ...(notes.length > 0 ? { grounding: notes } : {}),
    });
  }

  for (const summary of summaries) {
    for (const touched of boundariesTouchedBy(summary)) {
      const included =
        namesBoundary(subject, touched.binding) ||
        matchedBindings.has(touched.binding) ||
        (touched.relation === "provides" && matchedProviders.has(summary));
      if (!included) {
        continue;
      }
      const notes = groundingNotes(byBinding.get(touched.binding));
      keep(touches, answered, asTouchKey({ summary, touched }), {
        summary,
        touched,
        ...(notes.length > 0 ? { grounding: notes } : {}),
      });
    }
  }

  return {
    touches,
    hints: ungroundedHints(subject, accesses, matchedBindings),
  };
}

/**
 * Keeps one line per key. A later record replaces an earlier one only
 * when it has the callee and the earlier one does not, so the line with
 * the callee is kept whichever loop found it first.
 */
function keep(
  touches: GroundedTouch[],
  answered: Map<string, number>,
  key: string,
  touch: GroundedTouch,
): void {
  const at = answered.get(key);
  if (at === undefined) {
    answered.set(key, touches.length);
    touches.push(touch);
    return;
  }
  const kept = touches[at];
  if (
    kept !== undefined &&
    kept.touched.callee === undefined &&
    touch.touched.callee !== undefined
  ) {
    touches[at] = touch;
  }
}

/**
 * The key for one unit doing one thing at one boundary. The callee is
 * left out, because a read recorded once with its callee and once without
 * would otherwise print twice and look like two reads.
 */
function asTouchKey(touch: {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
}): string {
  return [
    summaryIdentifier(touch.summary),
    touch.touched.label,
    touch.touched.relation,
  ].join("\u0000");
}

/**
 * Adds the other side of every claim the question matched, until nothing
 * new is added. A matched access brings in its providers, and a matched
 * provider brings in the other accesses it claims.
 */
function closeOverClaims(
  accesses: ReadonlyArray<GroundedStorageAccess>,
  matchedBindings: Set<BoundaryBinding>,
  matchedProviders: Set<BehavioralSummary>,
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of accesses) {
      if (matchedBindings.has(record.binding)) {
        for (const provider of record.providers) {
          if (!matchedProviders.has(provider)) {
            matchedProviders.add(provider);
            grew = true;
          }
        }
      } else if (
        record.providers.some((provider) => matchedProviders.has(provider))
      ) {
        matchedBindings.add(record.binding);
        grew = true;
      }
    }
  }
}

function matchesAccess(
  subject: string,
  record: GroundedStorageAccess,
): boolean {
  if (namesBoundary(subject, record.binding)) {
    return true;
  }
  return record.reached.some(
    (reached) =>
      reached.name !== record.container &&
      namesBoundary(subject, respelled(record.binding, reached.name)),
  );
}

/**
 * Whether the subject matches this provider, either by its binding's own
 * words or by another name the provider is declared under, such as the
 * name a deployment gives the store.
 */
function matchesProvider(
  subject: string,
  provider: GroundedStorageProvider,
): boolean {
  if (namesBoundary(subject, provider.binding)) {
    return true;
  }
  return provider.names.some((name) =>
    namesBoundary(subject, respelled(provider.binding, name)),
  );
}

/** The same binding, spelled with another container name. */
function respelled(
  binding: BoundaryBinding,
  container: string,
): BoundaryBinding {
  return {
    ...binding,
    semantics: { ...binding.semantics, container },
  } as BoundaryBinding;
}

function groundingNotes(
  record: GroundedStorageAccess | undefined,
): GroundingNote[] {
  if (record === undefined) {
    return [];
  }
  const notes: GroundingNote[] = [];
  for (const reached of record.reached) {
    if (reached.groundedBy === null) {
      continue;
    }
    notes.push({ to: reached.name, by: supplierSpelling(reached.groundedBy) });
  }
  return notes;
}

/** A runtime manifest is printed as its file, so a reader can open it, and a caller as its summary id. */
function supplierSpelling(groundedBy: GroundedBy): string {
  if (groundedBy.role === "runtime") {
    return groundedBy.summary.location.file;
  }
  return summaryIdentifier(groundedBy.summary);
}

/**
 * For each ungrounded access, the input that would show whether it
 * matches the question. Only accesses on the storage system the question
 * mentions get a hint, so a DynamoDB question does not ask for a Redis
 * value.
 */
function ungroundedHints(
  subject: string,
  accesses: ReadonlyArray<GroundedStorageAccess>,
  matchedBindings: ReadonlySet<BoundaryBinding>,
): string[] {
  const hints: string[] = [];
  for (const record of accesses) {
    if (
      record.ungrounded === undefined ||
      matchedBindings.has(record.binding) ||
      !mentionsStorageSystem(subject, record.binding)
    ) {
      continue;
    }
    const touch = boundariesTouchedBy(record.summary).find(
      (candidate) => candidate.binding === record.binding,
    );
    if (touch === undefined) {
      continue;
    }
    const doing = `${summaryIdentifier(record.summary)} ${touch.relation} ${touch.label}`;
    if (record.ungrounded.variable !== null) {
      hints.push(
        `${doing}, and nothing here says what ${record.ungrounded.variable} is set to. Read the deployment that sets it in, suss contract --from wrangler <wrangler.toml> -o summaries/infra.json, then ask again.`,
      );
    } else {
      hints.push(
        `${doing}, and the name is whatever its caller passes. No caller in these summaries settles it; extract the callers too, then ask again.`,
      );
    }
  }
  return hints;
}

function mentionsStorageSystem(
  subject: string,
  binding: BoundaryBinding,
): boolean {
  const semantics = binding.semantics as { storageSystem?: string | null };
  const storageSystem = semantics.storageSystem;
  if (storageSystem === undefined || storageSystem === null) {
    return false;
  }
  const tokens = new Set(spellingTokens(storageSystem));
  for (const token of [...tokens]) {
    for (const part of token.split(".")) {
      tokens.add(part);
    }
  }
  return spellingTokens(subject).some((token) => tokens.has(token));
}
