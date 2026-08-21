/**
 * What a unit does at a boundary, and how somebody spells a boundary
 * they want to ask about.
 *
 * `suss check --at` and `suss ask` both start by working out which
 * boundary the words in front of them mean. Those words get cut into
 * tokens, the boundary does too, and a boundary matches when it has
 * every token somebody wrote. So `aws.dynamodb:editions` matches the table
 * and every index on it, and adding `#by-publication` narrows it to the
 * one index.
 */

import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import { storageBoundaryKey } from "@suss/checker";
import { boundaryLabel, displayLabel } from "@suss/ir-core";

import type {
  BehavioralSummary,
  BoundaryBinding,
  BoundaryRole,
  Effect,
} from "@suss/behavioral-ir";

type Interaction = Extract<Effect, { type: "interaction" }>["interaction"];

/**
 * Protocols that spell a boundary somewhere other than the semantics
 * registry, asked in turn. Each returns null for semantics that are not
 * its own.
 */
const SPELLED_BY_ITS_OWN_PASS = [storageBoundaryKey];

/** How a report writes this boundary, and how somebody types it back. */
export function boundarySpelling(binding: BoundaryBinding): string {
  const fromRegistry = boundaryLabel(binding);
  if (fromRegistry !== null) {
    return fromRegistry;
  }

  for (const spell of SPELLED_BY_ITS_OWN_PASS) {
    const spelled = spell(binding.semantics);
    if (spelled !== null) {
      return spelled;
    }
  }
  return displayLabel(binding);
}

/**
 * The words in a boundary spelling. Separators between parts of a name
 * are cut, and the characters inside one part are left alone, so
 * `by-publication` stays one word and `{id}` and `:id` both come out as
 * `id`.
 */
export function spellingTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .split(/[\s:#,()/]+/)
    .filter((token) => token.length > 0);
}

/** Every word this boundary can be asked about by. */
export function bindingTokens(binding: BoundaryBinding): Set<string> {
  const tokens = new Set(spellingTokens(boundarySpelling(binding)));
  for (const value of Object.values(binding.semantics)) {
    if (typeof value === "string") {
      for (const token of spellingTokens(value)) {
        tokens.add(token);
      }
    }
  }
  // A word OpenTelemetry spells with a dot in it, "aws.dynamodb", is
  // askable by its parts too, so somebody types the product name.
  for (const token of [...tokens]) {
    for (const part of token.split(".")) {
      tokens.add(part);
    }
  }
  return tokens;
}

/**
 * Whether what somebody typed is the whole of this boundary's name
 * rather than part of it. `POST /articles` is exactly the collection
 * route and only part of `POST /articles/{slug}/comments`.
 */
export function namesBoundaryExactly(
  subject: string,
  binding: BoundaryBinding,
): boolean {
  const wanted = new Set(spellingTokens(subject));
  if (wanted.size === 0) {
    return false;
  }
  const spelled = new Set(spellingTokens(boundarySpelling(binding)));
  if (spelled.size !== wanted.size) {
    return false;
  }
  return [...spelled].every((token) => wanted.has(token));
}

/** Whether what somebody typed picks out this boundary. */
export function namesBoundary(
  subject: string,
  binding: BoundaryBinding,
): boolean {
  const wanted = spellingTokens(subject);
  if (wanted.length === 0) {
    return false;
  }
  const tokens = bindingTokens(binding);
  return wanted.every((token) => tokens.has(token));
}

/**
 * What a unit does at a boundary. A unit that serves the boundary
 * provides it; a unit that goes through it reads it, writes it, or
 * both.
 */
export type Relation = "provides" | "reads" | "writes";

export interface TouchedBoundary {
  label: string;
  binding: BoundaryBinding;
  relation: Relation;
  /** The call as the source writes it, when the effect recorded one. */
  callee: string | undefined;
  transitionId: string | undefined;
}

type RelationTable = {
  [K in Interaction["class"]]: (
    interaction: Extract<Interaction, { class: K }>,
  ) => Relation[];
};

/**
 * A request sends a body out and gets a response back, so a service
 * call both reads and writes. Scheduling a callback crosses no
 * boundary, so it does neither.
 */
const RELATIONS: RelationTable = {
  "storage-access": (interaction) =>
    interaction.kind === "read" ? ["reads"] : ["writes"],
  "service-call": () => ["reads", "writes"],
  "message-send": () => ["writes"],
  "message-receive": () => ["reads"],
  "config-read": () => ["reads"],
  schedule: () => [],
};

export function relationsOf(interaction: Interaction): Relation[] {
  const handler = (
    RELATIONS as unknown as Record<string, (i: Interaction) => Relation[]>
  )[interaction.class];
  return handler(interaction);
}

/** What a unit does at the boundary its own identity is bound to. */
const OWN_BINDING: Record<BoundaryRole, Relation[]> = {
  provider: ["provides"],
  consumer: ["reads", "writes"],
};

/**
 * Every boundary this unit touches: the one it serves, and one entry
 * per relation for each call site that goes through one. The call sites
 * narrow to the given transitions when a caller asks about part of a
 * unit.
 */
export function boundariesTouchedBy(
  summary: BehavioralSummary,
  transitionIds?: ReadonlySet<string>,
): TouchedBoundary[] {
  const touched: TouchedBoundary[] = [];
  // What a unit does at its own boundary is true of every line in it,
  // so asking about one line still reports it. A unit on the calling
  // side of a boundary is bound to it too, and it reads and writes
  // there the same way a call to a service does.
  const own = summary.identity.boundaryBinding;
  if (own !== null) {
    for (const relation of OWN_BINDING[BOUNDARY_ROLE[summary.kind]]) {
      touched.push({
        label: boundarySpelling(own),
        binding: own,
        relation,
        callee: undefined,
        transitionId: undefined,
      });
    }
  }

  for (const transition of summary.transitions) {
    if (transitionIds !== undefined && !transitionIds.has(transition.id)) {
      continue;
    }
    for (const effect of transition.effects) {
      if (effect.type !== "interaction") {
        continue;
      }
      for (const relation of relationsOf(effect.interaction)) {
        touched.push({
          label: boundarySpelling(effect.binding),
          binding: effect.binding,
          relation,
          callee: effect.callee,
          transitionId: transition.id,
        });
      }
    }
  }
  return touched;
}
