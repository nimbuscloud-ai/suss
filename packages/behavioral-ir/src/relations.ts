/**
 * What a unit does at each boundary a summary mentions.
 *
 * The verbs are `@suss/ir-core`'s `Relation`, the same ones `suss ask`
 * uses. This module maps each interaction class to its verbs, so a
 * report, a question and an intent doc all use the same verbs for the
 * same effect.
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
 * call both reads and writes. Scheduling does not cross a boundary.
 */
const RELATIONS: RelationTable = {
  "storage-access": (interaction) =>
    interaction.kind === "read" ? ["reads"] : ["writes"],
  "service-call": () => ["reads", "writes"],
  "message-send": () => ["writes"],
  "unit-invoke": () => ["invokes"],
  "message-receive": () => ["reads"],
  "config-read": () => ["reads"],
  "metadata-read": () => ["reads"],
  schedule: () => [],
  "stream-write": () => ["writes"],
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
 * The name a read took that the boundary label leaves out. A store's
 * label already includes the container, but the label of a config or
 * metadata read only identifies the recognizer, so the detail is the
 * name that was read.
 */
export function interactionDetail(
  interaction: Interaction,
): string | undefined {
  if (
    interaction.class === "config-read" ||
    interaction.class === "metadata-read"
  ) {
    return interaction.name;
  }
  return undefined;
}

/**
 * Whether a storage access goes through a relation path. The container
 * such an access reaches comes from the provider's contract, so a walk
 * over one summary cannot work it out.
 */
export function goesThroughRelation(interaction: Interaction): boolean {
  return (
    interaction.class === "storage-access" &&
    interaction.relationPath !== undefined
  );
}
