// @suss/intent-ir schema: the team-authored intent file format.
//
// Two top-level shapes, discriminated by `kind`:
//
//   kind: boundary: system intent. What a single boundary (a REST
//                     endpoint, or a function / package export) should
//                     do: its outcomes, named by id.
//   kind: prd: outcome intent. Human scenarios (when / then)
//                     that reference system-intent outcomes by id.
//
// This is the *authoring* surface (what someone writes, or what a
// reader / inference step produces). `./summary.ts` normalises it into
// the shape the checker compares against derived behavioural summaries.
//
// Design notes:
//   - Boundaries reuse @suss/ir-core's transport/semantics vocabulary,
//     so intent and behaviour describe the same boundary the same way.
//   - A transition says how it ends (`response`, `returns` or `throws`)
//     and what it did (`results`). The README beside this file works
//     through both halves and why a queue consumer needs the second.

import { z } from "zod";

import {
  EffectRelationSchema,
  MessageBusSemanticsSchema,
  StorageSemanticsSchema,
} from "@suss/ir-core";

// ---------------------------------------------------------------------------
// Provenance: how this intent doc came to exist. Findings against
// `inferred` (not-yet-curated) intent are downgraded; curation moves it
// to `inferred, curated` and findings fire at full severity.
// ---------------------------------------------------------------------------

export const IntentSourceSchema = z
  .enum(["author", "inferred", "inferred, curated"])
  .default("author");

/** The provenance of a doc `suss infer` wrote and nobody has curated. */
const UNCURATED_SOURCE = "inferred";

/** The fields somebody supplies while curating, which the code cannot. */
const CURATED_FIELDS = ["purpose", "audience"];

/**
 * The blanks a draft is still waiting on, given which fields its schema
 * failures landed on. Empty for a doc that failed some other way, so a
 * reader can tell an uncurated draft from a broken file.
 *
 * `suss infer intent` writes those fields empty, which the schema
 * rejects on purpose: an uncurated draft is not something to check yet,
 * and a placeholder that validated would read as finished.
 */
export function blanksLeftEmpty(
  doc: unknown,
  failedFields: string[],
): string[] {
  if ((doc as { source?: unknown }).source !== UNCURATED_SOURCE) {
    return [];
  }
  if (
    failedFields.length === 0 ||
    !failedFields.every((field) => CURATED_FIELDS.includes(field))
  ) {
    return [];
  }
  return CURATED_FIELDS.filter((blank) => failedFields.includes(blank));
}

// ---------------------------------------------------------------------------
// Body shapes: friendly authoring form (object with primitive-typed
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

export interface AuthoredShape {
  type: z.infer<typeof PrimitiveTypeName> | "array" | "object";
  items?: AuthoredShape | undefined;
  properties?: Record<string, AuthoredShape> | undefined;
  required?: string[] | undefined;
}

// Recursive: a property can itself be an array or a nested object, so
// a declared body can commit to `Finding[]`-style returns and nested
// records, not only flat objects of primitives.
const ShapeSchema: z.ZodType<AuthoredShape> = z.lazy(() =>
  z.union([
    z.object({ type: PrimitiveTypeName }),
    z.object({ type: z.literal("array"), items: ShapeSchema.optional() }),
    z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), ShapeSchema).optional(),
      required: z.array(z.string()).optional(),
    }),
  ]),
);

// Top level accepts either a full shape (`type: array`, `type: object`,
// a bare primitive) or the record shorthand, `properties:` with no
// `type:`: which existing docs use.
export const BodyShapeSchema = z.union([
  ShapeSchema,
  z.object({
    properties: z.record(z.string(), ShapeSchema).optional(),
    required: z.array(z.string()).optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Boundary: REST or function-call, in @suss/ir-core's vocabulary.
// ---------------------------------------------------------------------------

const RestBoundarySchema = z.object({
  transport: z.literal("http").default("http"),
  semantics: z.literal("rest"),
  method: z.string().min(1),
  path: z.string().min(1),
});

// Deliberately permissive: a function-call boundary is pairable today
// only when `package` + `exportPath` are set (see @suss/ir-core
// boundaryKey), but module-level boundaries stay authorable, declared-
// ahead-of-capability intent is a valid pending state, same as an
// unlinked PRD scenario. The checker reports such intent as unchecked
// (unkeyableBoundary) rather than this schema rejecting it; don't
// tighten this without also shipping module-level keying.
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

// Both fields come off the ir-core schema, so a bus added there is
// authorable here with no edit. A doc that leaves the channel out is
// authorable and unpairable, and the checker is what says so.
const MessageBusBoundarySchema = z.object({
  semantics: z.literal("message-bus"),
  messageBus: MessageBusSemanticsSchema.shape.messageBus,
  channel: MessageBusSemanticsSchema.shape.channel.default(null),
});

// Same reuse, and the same pending state for a different reason: a
// store has no identity key at all, so every storage boundary intent
// is authorable and unpairable. See the README.
const StorageBoundarySchema = z.object({
  semantics: z.literal("storage"),
  storageSystem: StorageSemanticsSchema.shape.storageSystem,
  scope: StorageSemanticsSchema.shape.scope.default("default"),
  container: StorageSemanticsSchema.shape.container.default(null),
  accessPath: StorageSemanticsSchema.shape.accessPath.default(null),
});

export const BoundarySchema = z.discriminatedUnion("semantics", [
  RestBoundarySchema,
  FunctionCallBoundarySchema,
  MessageBusBoundarySchema,
  StorageBoundarySchema,
]);

// ---------------------------------------------------------------------------
// Transition outcomes: exactly one of response / returns / throws.
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

// A key written with no value (`returns:` on its own line) parses to
// null in YAML. Treat a null outcome as the empty outcome so `returns:`
// and `returns: {}` mean the same body-less thing, instead of failing
// with "expected object, received null".
function emptyIfNull<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === null ? {} : v), schema);
}

// One effect the outcome has, written the way `suss ask` asks about
// it: "results in a write to postgresql:invoices". The verbs and the
// boundary both come from schemas something else already owns.
const EffectOutcomeSchema = z.object({
  does: EffectRelationSchema,
  at: BoundarySchema,
});

const BoundaryTransitionSchema = z
  .object({
    id: z.string().min(1),
    when: z.string().min(1),
    response: emptyIfNull(ResponseOutcomeSchema).optional(),
    returns: emptyIfNull(ReturnsOutcomeSchema).optional(),
    throws: emptyIfNull(ThrowsOutcomeSchema).optional(),
    results: z.array(EffectOutcomeSchema).min(1).optional(),
  })
  .refine((t) => endingsOf(t).length <= 1, {
    message:
      "a transition ends one way: give it at most one of response, returns, or throws",
  })
  .refine((t) => endingsOf(t).length === 1 || t.results !== undefined, {
    message:
      "each transition must declare an outcome: response, returns, throws, or the effects it results in",
  });

function endingsOf(t: {
  response?: unknown;
  returns?: unknown;
  throws?: unknown;
}): unknown[] {
  return [t.response, t.returns, t.throws].filter((o) => o !== undefined);
}

// ---------------------------------------------------------------------------
// kind: boundary: system intent for one boundary.
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
// kind: prd: outcome intent (human scenarios).
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
   * platform, or an LLM at authoring time), never required to author.
   *
   * (The human-readable parts are `when` / `expect`; the field is named
   * `link`, not `then`, because a data object with a `then` property is
   * treated as a thenable by Promise resolution, a latent footgun.)
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
export type EffectOutcome = z.infer<typeof EffectOutcomeSchema>;
export type BodyShape = z.infer<typeof BodyShapeSchema>;
export type IntentSource = z.infer<typeof IntentSourceSchema>;
export type PrimitiveTypeName = z.infer<typeof PrimitiveTypeName>;
