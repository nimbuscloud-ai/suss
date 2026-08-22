/**
 * The grounded half of a boundary question.
 *
 * A boundary question matches by tokens against what a binding
 * spells, and a storage access whose container is a reference spells
 * `{SUBSCRIBER_TABLE}` rather than the store it reaches when
 * deployed. The deployed name comes out of grounding: the value a
 * wrangler `[vars]` block sets, or the argument a caller passed. The
 * join is the checker's (`groundStorageAccesses`), the same one the
 * check pass attributes findings with. Matching closes over the
 * claims, so a question that picked out one side of a provider-access
 * pair reports the other side too, and both spellings of one store
 * give the same pairs.
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
  /** The answer's spelling of the supplier: a manifest file or a caller. */
  by: string;
}

export interface GroundedTouch extends TargetTouch {
  /** Set when the touch's container grounds to a deployed name. */
  grounding?: GroundingNote[];
}

export interface GroundedTouches {
  touches: GroundedTouch[];
  /**
   * One sentence per access on the asked storage system whose name
   * nothing here grounds, saying which input would settle whether it
   * belongs in the answer.
   */
  hints: string[];
}

/**
 * Every unit that does something at the boundary somebody asked
 * about, matched by the binding's own words, by the deployed names
 * grounding computes, and through the provider-access claims between
 * them.
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
  // One unit doing one thing at one boundary is one line, however many
  // accesses say so, and the walk below adds only what is missing here.
  const answered = new Set<string>();

  // Storage comes from the grounded accesses rather than from the
  // effects, because only these say which table a read written under a
  // relation arrives at. Walking the effects here would put that read
  // on the table the query addressed, which is the table `check` says
  // it does not touch.
  for (const record of accesses) {
    if (!matchedBindings.has(record.binding)) {
      continue;
    }
    const touched: TouchedBoundary = {
      label: boundarySpelling(record.binding),
      binding: record.binding,
      relation: record.kind === "read" ? "reads" : "writes",
      callee: record.callee,
      transitionId: undefined,
    };
    const key = asTouchKey({ summary: record.summary, touched });
    if (answered.has(key)) {
      continue;
    }
    answered.add(key);
    const notes = groundingNotes(record);
    touches.push({
      summary: record.summary,
      touched,
      ...(notes.length > 0 ? { grounding: notes } : {}),
    });
  }

  for (const summary of summaries) {
    for (const touched of boundariesTouchedBy(summary)) {
      if (answered.has(asTouchKey({ summary, touched }))) {
        continue;
      }
      const included =
        namesBoundary(subject, touched.binding) ||
        matchedBindings.has(touched.binding) ||
        (touched.relation === "provides" && matchedProviders.has(summary));
      if (!included) {
        continue;
      }
      const notes = groundingNotes(byBinding.get(touched.binding));
      touches.push({
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

/** One unit doing one thing at one boundary. */
function asTouchKey(touch: {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
}): string {
  return [
    summaryIdentifier(touch.summary),
    touch.touched.label,
    touch.touched.relation,
    touch.touched.callee ?? "",
  ].join("\u0000");
}

/**
 * A question that picked out one side of a claim picks out the other,
 * to a fixpoint: the provider a grounded access pairs with brings in
 * the other accesses it claims.
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
 * Whether the subject picks out this provider: by its binding's own
 * words, or by any other name it is declared under, which is what a
 * deployment calls the store.
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

/**
 * A runtime's configuration is a manifest somebody can open, so the
 * note points at the file. A caller is a unit, so the note uses its
 * id.
 */
function supplierSpelling(groundedBy: GroundedBy): string {
  if (groundedBy.role === "runtime") {
    return groundedBy.summary.location.file;
  }
  return summaryIdentifier(groundedBy.summary);
}

/**
 * What would connect the question to an access nothing here grounds.
 * Only accesses on the storage system the question mentions are worth
 * a sentence; a question about DynamoDB is not missing a Redis value.
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
  const semantics = binding.semantics as { storageSystem?: string };
  if (semantics.storageSystem === undefined) {
    return false;
  }
  const tokens = new Set(spellingTokens(semantics.storageSystem));
  for (const token of [...tokens]) {
    for (const part of token.split(".")) {
      tokens.add(part);
    }
  }
  return spellingTokens(subject).some((token) => tokens.has(token));
}
