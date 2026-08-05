// @suss/ir-core schemas — primitives shared by every suss IR.
//
// These are the types that any IR built on top of suss references:
// the shape of a value (`TypeShape`), the identity of a boundary
// (`BoundaryBinding` + its `Semantics` variants), where something
// lives in source (`SourceLocation`), and how much to trust a claim
// (`Confidence`). Behavioural summaries, intent docs, and (later)
// observation records all speak in these terms, so they live in one
// place that none of those IRs has to depend on each other to reach.
//
// Schemas are the single source of truth; the package's `index.ts`
// derives the types via `z.infer`.

import { z } from "zod";

import { SemanticsSchema } from "./semantics/registry.js";

// The `@suss/ir-core/schemas` subpath is a public surface. The
// protocol schemas moved into one module per protocol under
// `semantics/`; these re-exports keep the subpath's contract.
export { DeployableUnitSchema } from "./deployableUnit.js";
export { FunctionCallSemanticsSchema } from "./semantics/functionCall.js";
export { GraphqlOperationSemanticsSchema } from "./semantics/graphqlOperation.js";
export { GraphqlResolverSemanticsSchema } from "./semantics/graphqlResolver.js";
export { MessageBusSemanticsSchema } from "./semantics/messageBus.js";
export { SemanticsSchema } from "./semantics/registry.js";
export { RestSemanticsSchema } from "./semantics/rest.js";
export { RuntimeConfigSemanticsSchema } from "./semantics/runtimeConfig.js";
export { StorageRelationalSemanticsSchema } from "./semantics/storageRelational.js";

// ---------------------------------------------------------------------------
// Confidence — how a claim was produced and how much to trust it.
// ---------------------------------------------------------------------------

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "derived",
]);

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

/**
 * The result of corroborating a claim against real execution
 * (`suss corroborate`): generated inputs satisfying the claim's own
 * conditions were run through the actual function and the observation
 * either agreed every time (`observed`), disagreed at least once
 * (`refuted` — an extractor bug or a genuine surprise; the
 * counterexample says which input), or never produced a verdict
 * (`untested` — no satisfying input was found, or every satisfying
 * run hit a dependency the harness cannot supply).
 *
 * Corroboration upgrades a *derivation* with *observations*; it is
 * additive evidence, never a rewrite of the derived claim.
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
  range: z.object({ start: z.number(), end: z.number() }),
  exportName: z.string().nullable(),
  /**
   * What the extract was pointed at, as that project calls itself.
   *
   * A path is relative to wherever the extract ran, so two services in
   * one repository both say `src/handlers.ts` and merging their
   * summaries puts them on top of each other. This is what tells them
   * apart, and what a reader groups by.
   */
  workspace: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Boundary binding — three-layer model: transport (the wire), semantics
// (the pairing rule), recognition (how the unit was found). The
// semantics union and each protocol's schema live under `semantics/`,
// one module per protocol.
// ---------------------------------------------------------------------------

export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
});

// ---------------------------------------------------------------------------
// TypeShape — the structural shape of a value, used for body / payload
// / field comparison across every IR.
// ---------------------------------------------------------------------------

// Exported as a named type (not just `z.infer`) so that consuming
// packages' declaration files reference `TypeShape` by name across the
// package boundary rather than inlining this recursive union — inlining
// blows their .d.ts up by orders of magnitude.
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
       * Where this type is written down, when it is. The key into the
       * summary's table of definitions.
       *
       * A name does not identify a type. Every instantiation of one
       * generic reports the generic's own name and file, so `Omit<User,
       * "secret">` and `Omit<Order, "total">` are both `Omit`, and a
       * table keyed on that hands the second one the first one's
       * fields. This is built from what the type actually is.
       */
      def?: string | undefined;
      /**
       * The file that declares this type, when the project declares it.
       * Absent for a name the language or a dependency owns, which means
       * the same thing everywhere.
       *
       * A name on its own does not identify a type. Two modules each
       * declaring a `User` produce the same ref, and a checker comparing
       * them has nothing to go on. This is what tells them apart.
       */
      from?: string | undefined;
    }
  | { type: "unknown" };

/**
 * How a table of definitions names the type a ref points at.
 *
 * A ref carries the name and the file that declares it, and that pair
 * already identifies the type, so a table keyed on it needs nothing new
 * on the ref. A name the language or a dependency owns has no file and
 * keys on the name alone.
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
 * How deep a shape is walked while definitions are put back.
 *
 * The same number the shape walk itself stops at, so a shape read from
 * a table looks like the one that was never in a table.
 */
const MAX_DEFINITION_DEPTH = 6;

/**
 * A shape with the definitions it names put back into it.
 *
 * Comparing two shapes means comparing their structure, and a ref has
 * none. Rather than teach every comparison to look in a table, the
 * table goes back into the shape once, and everything downstream reads
 * what it always read.
 *
 * Putting a definition back is a substitution rather than a level of
 * nesting, so it does not spend depth. Counting it did: a type six
 * deep came back three deep, and a consumer reading a field past that
 * point was told the provider did not have it. What stops a type that
 * names itself is the set of names already being put back on this
 * path, which is how the shape walk guards its own cycles.
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
    // A ref with no key was never written down, which is what a name
    // the language owns looks like.
    if (key === null) {
      return shape;
    }
    const defined = definitions[key];
    // A ref naming nothing in the table stays a ref, which is what it
    // means: this is the name, and nobody wrote the type down. A name
    // already on this path stays a ref too, or a type that names itself
    // would be put back for ever.
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
