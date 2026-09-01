/**
 * What a unit does at each boundary a summary mentions.
 *
 * The verbs are `@suss/ir-core`'s `Relation`, the same ones `suss ask`
 * asks with. This module says which verb each interaction class gets,
 * so a report, a question and an intent doc that states a boundary
 * effect all read one answer.
 */

import type { Relation } from "@suss/ir-core";
import type { BoundaryRole, Effect } from "./index.js";

export type Interaction = Extract<
  Effect,
  { type: "interaction" }
>["interaction"];

type RelationTable = {
  [K in Interaction["class"]]: (
    interaction: Extract<Interaction, { class: K }>,
  ) => Relation[];
};

/**
 * A request sends a body out and gets a response back, so a service
 * call both reads and writes. Scheduling crosses no boundary at all.
 */
const RELATIONS: RelationTable = {
  "storage-access": (interaction) =>
    interaction.kind === "read" ? ["reads"] : ["writes"],
  "service-call": () => ["reads", "writes"],
  "message-send": () => ["writes"],
  "unit-invoke": () => ["invokes"],
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
export const OWN_BINDING: Record<BoundaryRole, Relation[]> = {
  provider: ["provides"],
  consumer: ["reads", "writes"],
};

/**
 * Which container an access written under a relation reaches comes
 * from the provider's contract, so a walk over one summary cannot say.
 */
export function goesThroughRelation(interaction: Interaction): boolean {
  return (
    interaction.class === "storage-access" &&
    interaction.relationPath !== undefined
  );
}
