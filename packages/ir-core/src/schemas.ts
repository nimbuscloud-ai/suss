/**
 * The zod schemas for the primitives every suss IR uses.
 *
 * `TypeShape` is the structure of a value. `BoundaryBinding` and its
 * `Semantics` variants identify a boundary. `SourceLocation` says where
 * something is in the source, and `Confidence` says how much to trust a
 * claim. Behavioral summaries and intent docs are both built from these,
 * so they live in a package of their own and neither IR depends on the
 * other.
 *
 * The schemas are the source of truth. The package index derives the
 * types from them with `z.infer`.
 */

import { z } from "zod";

import { SemanticsSchema } from "./semantics/registry.js";

// The `@suss/ir-core/schemas` subpath is public, so it re-exports each
// protocol's schema from that protocol's own module.
export { DeployableUnitSchema } from "./deployableUnit.js";
export { FunctionCallSemanticsSchema } from "./semantics/functionCall.js";
export { GraphqlOperationSemanticsSchema } from "./semantics/graphqlOperation.js";
export { GraphqlResolverSemanticsSchema } from "./semantics/graphqlResolver.js";
export { MessageBusSemanticsSchema } from "./semantics/messageBus.js";
export { SemanticsSchema } from "./semantics/registry.js";
export { RestSemanticsSchema } from "./semantics/rest.js";
export { RuntimeConfigSemanticsSchema } from "./semantics/runtimeConfig.js";
export { StorageSemanticsSchema } from "./semantics/storage.js";

// ---------------------------------------------------------------------------
// Confidence: how a claim was produced, and how much to trust it.
// ---------------------------------------------------------------------------

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "derived",
]);

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

/**
 * The result of checking a claim by running the code (`suss
 * corroborate`). The harness generates inputs that satisfy the claim's
 * own conditions and runs the function on them.
 *
 * - `observed`: every run agreed with the claim.
 * - `refuted`: at least one run disagreed, which is either an extractor
 *   bug or a surprise. `counterexample` gives the input.
 * - `untested`: no run produced a verdict. No satisfying input was
 *   found, or every run hit a dependency the harness cannot supply.
 *
 * Corroboration adds evidence to a derived claim and never rewrites it.
 */
export const CorroborationSchema = z.object({
  outcome: z.enum(["observed", "refuted", "untested"]),
  /** Executions that produced a verdict for this claim. */
  runs: z.number(),
  /** Present when refuted: the input and observation that disagreed. */
  counterexample: z.unknown().optional(),
  /** Present when untested: why no verdict was reachable. */
  reason: z.string().optional(),
});

export const ConfidenceInfoSchema = z.object({
  source: ConfidenceSourceSchema,
  level: ConfidenceLevelSchema,
  corroboration: CorroborationSchema.optional(),
});

// ---------------------------------------------------------------------------
// Source location.
// ---------------------------------------------------------------------------

export const SourceLocationSchema = z.object({
  file: z.string(),
  /** Line numbers, for a person reading the summary or an editor link. */
  range: z.object({ start: z.number(), end: z.number() }),
  /**
   * Character offsets of the unit in its file. Identity and joins use
   * these, because two functions can share a line but never an offset
   * range. `range` gives the same place in lines. Absent on a summary
   * with no source position, such as one read from a contract.
   */
  span: z.object({ start: z.number(), end: z.number() }).optional(),
  exportName: z.string().nullable(),
  /**
   * The project the extract ran on, by the name the project gives
   * itself.
   *
   * Paths are relative to wherever the extract ran, so two services in
   * one repository can both report `src/handlers.ts`, and merging their
   * summaries would mix them up. This field tells them apart, and a
   * reader groups by it.
   */
  workspace: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Boundary binding: transport (the wire), semantics (the pairing rule),
// and recognition (how the unit was found).
// ---------------------------------------------------------------------------

export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
});

// ---------------------------------------------------------------------------
// TypeShape: the structure of a value, used to compare bodies,
// payloads, and fields across every IR.
// ---------------------------------------------------------------------------

// Exported as a named type rather than a `z.infer`, so that consuming
// packages' declaration files refer to `TypeShape` by name instead of
// inlining this recursive union, which bloats their .d.ts enormously.
export type TypeShape =
  | {
      type: "record";
      properties: Record<string, TypeShape>;
      spreads?: Array<{ sourceText: string }> | undefined;
    }
  | { type: "dictionary"; values: TypeShape }
  | { type: "array"; items: TypeShape }
  | {
      type: "literal";
      value: string | number | boolean;
      raw?: string | undefined;
    }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "undefined" }
  | { type: "union"; variants: TypeShape[] }
  | {
      type: "ref";
      name: string;
      /**
       * Where this type is written down, when it is written down
       * anywhere. It is the key into the summary's table of definitions.
       *
       * A name does not identify a type. Every instantiation of one
       * generic reports the generic's own name and file, so `Omit<User,
       * "secret">` and `Omit<Order, "total">` are both `Omit`, and a
       * table keyed on that gives the second one the first one's fields.
       * This key is built from what the type actually is.
       */
      def?: string | undefined;
      /**
       * The file that declares this type, when the project declares it.
       * Absent for a name the language or a dependency defines, which
       * means the same thing everywhere.
       *
       * A name on its own does not identify a type. Two modules that each
       * declare a `User` produce the same ref, and `from` is the only
       * field that tells them apart.
       */
      from?: string | undefined;
    }
  | { type: "unknown" };

/**
 * The key a table of definitions uses for the type a ref points at,
 * which is the ref's `def`. Null for a ref without one, such as a name
 * the language or a dependency defines, and such a ref is never looked
 * up.
 */
export function typeDefinitionKey(ref: {
  def?: string | undefined;
}): string | null {
  return ref.def ?? null;
}

export const TypeShapeSchema: z.ZodType<TypeShape> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("record"),
      properties: z.record(z.string(), TypeShapeSchema),
      spreads: z.array(z.object({ sourceText: z.string() })).optional(),
    }),
    z.object({ type: z.literal("dictionary"), values: TypeShapeSchema }),
    z.object({ type: z.literal("array"), items: TypeShapeSchema }),
    z.object({
      type: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean()]),
      raw: z.string().optional(),
    }),
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("integer") }),
    z.object({ type: z.literal("number") }),
    z.object({ type: z.literal("boolean") }),
    z.object({ type: z.literal("null") }),
    z.object({ type: z.literal("undefined") }),
    z.object({
      type: z.literal("union"),
      variants: z.array(TypeShapeSchema),
    }),
    z.object({
      type: z.literal("ref"),
      name: z.string(),
      from: z.string().optional(),
      def: z.string().optional(),
    }),
    z.object({ type: z.literal("unknown") }),
  ]),
);

/**
 * How deep the walk goes while definitions are substituted back in.
 *
 * The extractor's shape walk stops at the same depth, so a shape read
 * back out of a table looks like one that was never in a table.
 */
const MAX_DEFINITION_DEPTH = 6;

/**
 * A shape with the definitions it refers to substituted back into it.
 *
 * Comparing two shapes means comparing their structure, and a ref has
 * none. Substituting the definitions once means no comparison has to
 * look anything up in a table.
 *
 * Substituting a definition does not count as a level of nesting. If it
 * did, a type six levels deep would come back three deep, and a
 * consumer reading a field past that would be told the provider lacks
 * it. A type that refers to itself stops at a key already substituted
 * on this path, the same cycle guard the shape walk uses.
 */
export function withDefinitionsInlined(
  shape: TypeShape,
  definitions: Record<string, TypeShape> | undefined,
  depth = 0,
  inProgress: ReadonlySet<string> = new Set(),
): TypeShape {
  if (definitions === undefined || depth >= MAX_DEFINITION_DEPTH) {
    return shape;
  }
  const deeper = (inner: TypeShape): TypeShape =>
    withDefinitionsInlined(inner, definitions, depth + 1, inProgress);

  if (shape.type === "ref") {
    const key = typeDefinitionKey(shape);
    // A ref without a key has no definition anywhere, as with a name the
    // language defines.
    if (key === null) {
      return shape;
    }
    const defined = definitions[key];
    // A ref missing from the table stays a ref, so a reader still sees
    // the name. A key already on this path stays a ref too, or a
    // recursive type would never finish.
    if (defined === undefined || inProgress.has(key)) {
      return shape;
    }
    return withDefinitionsInlined(
      defined,
      definitions,
      depth,
      new Set([...inProgress, key]),
    );
  }
  if (shape.type === "record") {
    const properties: Record<string, TypeShape> = {};
    for (const [name, value] of Object.entries(shape.properties)) {
      properties[name] = deeper(value);
    }
    return { ...shape, properties };
  }
  if (shape.type === "array") {
    return { ...shape, items: deeper(shape.items) };
  }
  if (shape.type === "dictionary") {
    return { ...shape, values: deeper(shape.values) };
  }
  if (shape.type === "union") {
    return { ...shape, variants: shape.variants.map(deeper) };
  }
  return shape;
}
