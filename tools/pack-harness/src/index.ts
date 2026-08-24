// @suss/pack-harness: what a pack's tests would otherwise write by hand.

export {
  interactionsOf,
  storageByOperation,
  storageOf,
} from "./effects.js";
export { packUnderTest } from "./harness.js";

export type {
  InteractionClass,
  InteractionEffect,
  InteractionOf,
  StorageAccess,
} from "./effects.js";
export type { PackHarness, PackHarnessOptions } from "./harness.js";
