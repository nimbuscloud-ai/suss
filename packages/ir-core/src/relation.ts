/**
 * What a unit does at a boundary, in the words `suss ask` asks with.
 *
 * `what writes postgresql:invoices` is the question and "this outcome
 * writes postgresql:invoices" is the assertion, so the report, the
 * question parser and an intent doc all have to spell the verbs the
 * same way. They are here rather than beside any one of them.
 *
 * `provides` is the unit's own boundary; `reads`, `writes` and
 * `invokes` are what a call site does at somebody else's. Calling a
 * deployed unit by name is one act, so it gets a verb of its own.
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
