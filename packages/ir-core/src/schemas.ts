/**
 * @suss/ir-core schemas: primitives shared by every suss IR.
 *
 * These are the types that any IR built on suss references: the
 * structure of a value (`TypeShape`), the identity of a boundary
 * (`BoundaryBinding` and its `Semantics` variants), where something is
 * in the source (`SourceLocation`), and how much to trust a claim
 * (`Confidence`). Behavioural summaries, intent docs, and later on
 * observation records all speak in these terms, so they are defined
 * here, in one place none of those IRs needs another IR to reach.
 *
 * The schemas are the single source of truth, and the package's
 * `index.ts` derives the types from them with `z.infer`.
 */

import { z } from "zod";

import { SemanticsSchema } from "./semantics/registry.js";

// The `@suss/ir-core/schemas` subpath is public, and each protocol's
// schema is now its own module under `semantics/`. These re-exports are
// what keep the subpath working for everyone importing from it.
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
 * What came of corroborating a claim by running the code
 * (`suss corroborate`). Inputs that satisfy the claim's own conditions
 * are generated and run through the function, and the observation
 * either agreed every time (`observed`), disagreed at least once
 * (`refuted`, which is either an extractor bug or a surprise, and the
 * counterexample says which input), or never produced a verdict
 * (`untested`, meaning no satisfying input was found, or every
 * satisfying run hit a dependency the harness cannot supply).
 *
 * Corroboration adds observations to a derivation. It is extra
 * evidence, and it never rewrites the derived claim.
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
   * The project the extract was pointed at, by the name that project
   * calls itself.
   *
   * Paths are relative to wherever the extract ran, so two services in
   * one repository both report `src/handlers.ts`, and merging their
   * summaries puts them on top of each other. This field is what tells
   * them apart, and what a reader groups by.
   */
  workspace: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Boundary binding: transport (the wire), semantics (the pairing rule),
// and recognition (how the unit was found). Each protocol's schema, and
// the semantics union, are one module apiece under `semantics/`.
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
 * The key a table of definitions uses for the type a ref points at.
 *
 * A ref has the name and the file that declares it, and that pair
 * already identifies the type, so a table keyed on it needs nothing new
 * on the ref. A name that the language or a dependency owns has no
 * file, and keys on the name alone.
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
 * It is the same limit the shape walk itself stops at, so a shape read
 * back out of a table looks like one that was never in a table.
 */
const MAX_DEFINITION_DEPTH = 6;

/**
 * A shape with the definitions it refers to substituted back into it.
 *
 * Comparing two shapes means comparing their structure, and a ref has
 * none. Rather than teach every comparison to look in a table, the
 * definitions go back into the shape once and everything downstream
 * reads what it always read.
 *
 * Substituting a definition is not a level of nesting, so it does not
 * spend depth. Counting it meant a type six deep came back three deep,
 * and a consumer reading a field past that was told the provider did
 * not have it. A type that refers to itself is stopped by the names
 * already substituted on this path, the shape walk's own cycle guard.
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
    // A ref with no key was never written down anywhere, which is what
    // a name the language owns looks like.
    if (key === null) {
      return shape;
    }
    const defined = definitions[key];
    // A ref with nothing in the table stays a ref, which says what it
    // means: here is the name, and nobody wrote the type down. A name
    // already on this path stays a ref too, or recursion would not end.
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
