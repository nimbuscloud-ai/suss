// schema.ts — Zod schema for the intent-spec file format (v0.1).
//
// Two top-level shapes, discriminated by `kind`:
//
//   kind: boundary  — engineer-authored system intent for a single
//                     REST boundary. Pairs against derived code via
//                     the existing checkIntentAgreement machinery.
//   kind: prd       — PM-authored outcome intent. Scenarios reference
//                     system-intent outcomes by qualified id; checked
//                     by the new PRD coverage checker.
//
// More system-intent kinds (workflow, concept) and the runtime
// observation half land in v0.2 / v0.3 / v0.4 — see the proposal at
// docs/internal/proposals/intent-specs.md.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive type aliases. The spec uses friendly names ("string") that map
// onto the IR's TypeShape names ("text"). Keeping the alias here means
// authors don't have to learn the IR vocabulary to write a spec.
// ---------------------------------------------------------------------------

const PrimitiveTypeName = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "unknown",
]);

type PrimitivePropertySchemaT = {
  type: z.infer<typeof PrimitiveTypeName>;
};

const PrimitivePropertySchema: z.ZodType<PrimitivePropertySchemaT> = z.object({
  type: PrimitiveTypeName,
});

// v0 supports only object-with-primitive-properties bodies — the dominant
// shape for HTTP responses. Nested objects, arrays, and unions are deferred;
// they're additive once the v0 reader is in production use.
const BodyShapeSchema = z
  .object({
    type: z.literal("object").optional(),
    properties: z.record(z.string(), PrimitivePropertySchema).optional(),
    required: z.array(z.string()).optional(),
  })
  .nullable();

// ---------------------------------------------------------------------------
// REST boundary, v0.1 — the only system-intent boundary shape this reader
// understands. Other semantics get their own variants in v0.2.
// ---------------------------------------------------------------------------

const RestBoundarySchema = z.object({
  transport: z.literal("http"),
  semantics: z.literal("rest"),
  method: z.string().min(1),
  path: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Boundary intent transition — one per outcome the boundary can produce.
// `id` is the outcome id PRDs reference by qualified name (e.g.
// `users-lookup.found-admin`). `when` is captured as an opaque predicate;
// the checker pairs by (kind, statusCode), not by predicate-text equality.
// ---------------------------------------------------------------------------

const BoundaryTransitionSchema = z.object({
  id: z.string().min(1),
  when: z.string().min(1),
  output: z.object({
    status: z.number().int().min(100).max(599),
    body: BodyShapeSchema.optional(),
  }),
});

// ---------------------------------------------------------------------------
// kind: boundary — system intent for a single REST boundary.
// ---------------------------------------------------------------------------

const BoundaryIntentSchema = z.object({
  kind: z.literal("boundary"),
  // `name` is what PRDs use to reference outcomes (`<name>.<transition-id>`).
  // Two boundary intents with the same `name` are an authoring error
  // (the coverage checker emits intentScenarioAmbiguous when references
  // resolve to multiple matches).
  name: z.string().min(1),
  // `purpose` and `audience` come from the concept-design framing — they're
  // what a well-formed system intent names. Required so a spec can't slip
  // into shape without an owner / a reason for existing.
  purpose: z.string().min(1),
  audience: z.string().min(1),
  boundary: RestBoundarySchema,
  transitions: z.array(BoundaryTransitionSchema).min(1),
});

// ---------------------------------------------------------------------------
// kind: prd — outcome intent (PM-authored scenarios).
// ---------------------------------------------------------------------------

const PrdScenarioSchema = z.object({
  // Optional human label for the scenario, useful in finding messages and
  // inspect output. The `when` field carries the actual condition.
  title: z.string().min(1).optional(),
  when: z.string().min(1),
  // Single qualified outcome ref or a list. Each ref is
  // `<system-intent-name>.<transition-id>`. The coverage checker resolves
  // each ref against loaded system intents and emits
  // intentScenarioUnmatched / intentScenarioAmbiguous when resolution fails.
  expect: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});

const PrdSchema = z.object({
  kind: z.literal("prd"),
  title: z.string().min(1),
  purpose: z.string().min(1),
  audience: z.string().min(1),
  scenarios: z.array(PrdScenarioSchema).min(1),
});

// ---------------------------------------------------------------------------
// Top-level discriminated union. The reader dispatches on `kind`.
// ---------------------------------------------------------------------------

export const IntentDocSchema = z.discriminatedUnion("kind", [
  BoundaryIntentSchema,
  PrdSchema,
]);

export type IntentDoc = z.infer<typeof IntentDocSchema>;
export type BoundaryIntent = z.infer<typeof BoundaryIntentSchema>;
export type Prd = z.infer<typeof PrdSchema>;
export type PrdScenario = z.infer<typeof PrdScenarioSchema>;
export type BoundaryTransition = z.infer<typeof BoundaryTransitionSchema>;
export type RestBoundary = z.infer<typeof RestBoundarySchema>;
export type BodyShape = z.infer<typeof BodyShapeSchema>;
export type PrimitiveTypeName = z.infer<typeof PrimitiveTypeName>;

// Back-compat re-exports for the previous v0.1 type names. The reader's
// public API still uses `IntentSpec` until callers migrate; treating
// `IntentSpec` as the boundary-kind variant keeps the existing test surface
// compiling without touching call sites that pre-dated the discriminator.
export type IntentSpec = BoundaryIntent;
export type RestTransition = BoundaryTransition;
export const IntentSpecSchema = BoundaryIntentSchema;
