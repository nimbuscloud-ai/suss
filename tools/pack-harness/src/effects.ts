// Reading an effect a pack emitted. TypeScript will not narrow through
// `.filter()` two levels into the Effect union, so a test that wants a
// storage access has to throw its way down. These are those throws.

import type { Effect, StorageSemantics } from "@suss/behavioral-ir";

/** An effect a pack emitted about talking to something else. */
export type InteractionEffect = Extract<Effect, { type: "interaction" }>;

/** What the code did across the boundary, by kind. */
export type InteractionClass = InteractionEffect["interaction"]["class"];

/** One kind of interaction, narrowed. */
export type InteractionOf<TClass extends InteractionClass> = Extract<
  InteractionEffect["interaction"],
  { class: TClass }
>;

/** A storage access, with the container and system it reached. */
export interface StorageAccess {
  semantics: StorageSemantics;
  interaction: InteractionOf<"storage-access">;
}

/** The storage access an effect is, or a throw saying what it was instead. */
export function storageOf(effect: Effect): StorageAccess {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  if (effect.interaction.class !== "storage-access") {
    throw new Error(`expected storage-access, got ${effect.interaction.class}`);
  }
  return { semantics, interaction: effect.interaction };
}

/** The storage access for one named operation, among several a snippet produced. */
export function storageByOperation(
  effects: Effect[],
  operation: string,
): StorageAccess {
  const found = effects.find(
    (effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access" &&
      effect.interaction.operation === operation,
  );
  if (found === undefined) {
    throw new Error(`no storage-access effect for operation "${operation}"`);
  }
  return storageOf(found);
}

/** Every interaction of one kind, narrowed to it. */
export function interactionsOf<TClass extends InteractionClass>(
  effects: Effect[],
  interactionClass: TClass,
): Array<InteractionEffect & { interaction: InteractionOf<TClass> }> {
  return effects.filter(
    (
      effect,
    ): effect is InteractionEffect & { interaction: InteractionOf<TClass> } =>
      effect.type === "interaction" &&
      effect.interaction.class === interactionClass,
  );
}
