// @suss/intent-ir schema — the team-authored intent file format.
//
// Two top-level shapes, discriminated by `kind`:
//
//   kind: boundary  — system intent. What a single boundary (a REST
//                     endpoint, or a function / package export) should
//                     do: its outcomes, named by id.
//   kind: prd       — outcome intent. Human scenarios (when / then)
//                     that reference system-intent outcomes by id.
//
// This is the *authoring* surface (what someone writes, or what a
// reader / inference step produces). `./summary.ts` normalises it into
// the shape the checker compares against derived behavioural summaries.
//
// Design notes:
//   - Boundaries reuse @suss/ir-core's transport/semantics vocabulary,
//     so intent and behaviour describe the same boundary the same way.
//   - A transition's outcome is one of `response` (REST: status + body),
//     `returns` (a function/handler return value), or `throws` (an
//     error outcome). REST endpoints use `response`; function-call
//     boundaries (suss's own surface, and anything non-HTTP) use
//     `returns` / `throws`. This is what lets suss dogfood itself.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Provenance — how this intent doc came to exist. Findings against
// `inferred` (not-yet-curated) intent are downgraded; curation moves it
// to `inferred, curated` and findings fire at full severity.
// ---------------------------------------------------------------------------

export const IntentSourceSchema = z
  .enum(["author", "inferred", "inferred, curated"])
  .default("author");

// ---------------------------------------------------------------------------
// Body shapes — friendly authoring form (object with primitive-typed
// properties). Maps onto @suss/ir-core's TypeShape in ./summary.ts.
// Nested objects / arrays / unions are deferred; they're additive.
// ---------------------------------------------------------------------------

const PrimitiveTypeName = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "unknown",
]);

const PropertySchema = z.object({ type: PrimitiveTypeName });

export const BodyShapeSchema = z.object({
  properties: z.record(z.string(), PropertySchema).optional(),
  required: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Boundary — REST or function-call, in @suss/ir-core's vocabulary.
// ---------------------------------------------------------------------------

const RestBoundarySchema = z.object({
  transport: z.literal("http").default("http"),
  semantics: z.literal("rest"),
  method: z.string().min(1),
  path: z.string().min(1),
});

const FunctionCallBoundarySchema = z.object({
  transport: z.string().default("in-process"),
  semantics: z.literal("function-call"),
  /** Repo-relative module path, when the boundary is an intra-repo unit. */
  module: z.string().optional(),
  /** Named export within the module / package. */
  exportName: z.string().optional(),
  /** Package name when the boundary is a public package export. */
  package: z.string().optional(),
  /** Path to the export within the package (sub-path + nested names). */
  exportPath: z.array(z.string()).optional(),
});

export const BoundarySchema = z.discriminatedUnion("semantics", [
  RestBoundarySchema,
  FunctionCallBoundarySchema,
]);

// ---------------------------------------------------------------------------
// Transition outcomes — exactly one of response / returns / throws.
// ---------------------------------------------------------------------------

const ResponseOutcomeSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: BodyShapeSchema.optional(),
});

const ReturnsOutcomeSchema = z.object({
  body: BodyShapeSchema.optional(),
});

const ThrowsOutcomeSchema = z.object({
  errorType: z.string().optional(),
});

const BoundaryTransitionSchema = z
  .object({
    id: z.string().min(1),
    when: z.string().min(1),
    response: ResponseOutcomeSchema.optional(),
    returns: ReturnsOutcomeSchema.optional(),
    throws: ThrowsOutcomeSchema.optional(),
  })
  .refine(
    (t) =>
      [t.response, t.returns, t.throws].filter((o) => o !== undefined)
        .length === 1,
    {
      message:
        "each transition must declare exactly one outcome: response, returns, or throws",
    },
  );

// ---------------------------------------------------------------------------
// kind: boundary — system intent for one boundary.
// ---------------------------------------------------------------------------

const BoundaryIntentSchema = z.object({
  kind: z.literal("boundary"),
  /** Name PRDs reference outcomes through: `<name>.<transition-id>`. */
  name: z.string().min(1),
  purpose: z.string().min(1),
  audience: z.string().min(1),
  source: IntentSourceSchema,
  boundary: BoundarySchema,
  transitions: z.array(BoundaryTransitionSchema).min(1),
});

// ---------------------------------------------------------------------------
// kind: prd — outcome intent (human scenarios).
// ---------------------------------------------------------------------------

const PrdScenarioSchema = z.object({
  title: z.string().min(1).optional(),
  /** The condition, in the author's terms. */
  when: z.string().min(1),
  /** The expected outcome, in the author's terms. Always present. */
  expect: z.string().min(1),
  /**
   * Optional structured link(s) to system-intent outcomes
   * (`<intent-name>.<outcome-id>`). A scenario without `link` is a
   * valid pending-link state: fully human-readable, not yet machine-
   * linked. The link is filled in later by a facilitator (a person, a
   * platform, or an LLM at authoring time) — never required to author.
   *
   * (The human-readable parts are `when` / `expect`; the field is named
   * `link`, not `then`, because a data object with a `then` property is
   * treated as a thenable by Promise resolution — a latent footgun.)
   */
  link: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
});

const PrdSchema = z.object({
  kind: z.literal("prd"),
  title: z.string().min(1),
  purpose: z.string().min(1),
  audience: z.string().min(1),
  source: IntentSourceSchema,
  scenarios: z.array(PrdScenarioSchema).min(1),
});

// ---------------------------------------------------------------------------
// Top-level discriminated union.
// ---------------------------------------------------------------------------

export const IntentDocSchema = z.discriminatedUnion("kind", [
  BoundaryIntentSchema,
  PrdSchema,
]);

export type IntentDoc = z.infer<typeof IntentDocSchema>;
export type BoundaryIntent = z.infer<typeof BoundaryIntentSchema>;
export type Prd = z.infer<typeof PrdSchema>;
export type PrdScenario = z.infer<typeof PrdScenarioSchema>;
export type Boundary = z.infer<typeof BoundarySchema>;
export type BoundaryTransition = z.infer<typeof BoundaryTransitionSchema>;
export type BodyShape = z.infer<typeof BodyShapeSchema>;
export type IntentSource = z.infer<typeof IntentSourceSchema>;
export type PrimitiveTypeName = z.infer<typeof PrimitiveTypeName>;
