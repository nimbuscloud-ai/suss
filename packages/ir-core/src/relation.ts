/**
 * What a unit does at a boundary, in the words `suss ask` uses.
 *
 * A user asks `what writes postgresql:invoices`, and an intent doc
 * asserts "this outcome writes postgresql:invoices". The report, the
 * question parser and the intent reader all have to spell the verbs the
 * same way, so the verbs are defined here once.
 *
 * `provides` is a boundary the unit serves. `reads`, `writes` and
 * `invokes` are what a call site does at a boundary somebody else
 * serves. Calling a deployed unit by name is its own act, so it gets
 * its own verb.
 */

import { z } from "zod";

export const RelationSchema = z.enum([
  "provides",
  "reads",
  "writes",
  "invokes",
]);

export type Relation = z.infer<typeof RelationSchema>;

/**
 * The verbs an effect can have. A boundary a unit serves is not an
 * effect of the unit, so `provides` is not one of them.
 */
export const EffectRelationSchema = RelationSchema.exclude(["provides"]);

export type EffectRelation = z.infer<typeof EffectRelationSchema>;
