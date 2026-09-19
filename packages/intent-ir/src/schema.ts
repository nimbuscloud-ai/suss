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
  type EffectRelation,
  EffectRelationSchema,
  MessageBusSemanticsSchema,
  StorageSemanticsSchema,
  UnitInvocationSemanticsSchema,
} from "@suss/ir-core";

// ---------------------------------------------------------------------------
// Provenance: how this intent doc came to exist. Findings against
// `inferred` (not-yet-curated) intent are downgraded; curation moves it
// to `inferred, curated` and findings fire at full severity.
// ---------------------------------------------------------------------------

export const IntentSourceSchema = z
  .enum(["author", "inferred", "inferred, curated"])
  .default("author")
  .describe(
    "Where the document came from: somebody wrote it, suss inferred it, or suss inferred it and somebody has since curated it.",
  );

/** The provenance of a doc `suss infer` wrote and nobody has curated. */
const UNCURATED_SOURCE = "inferred";

/**
 * The fields somebody supplies while curating, which the code cannot.
 * A boundary document leaves the first three; a PRD leaves those and
 * the words of every scenario.
 */
const CURATED_FIELDS = ["title", "purpose", "audience", "when", "expect"];

/** A scenario's blank arrives as `scenarios.0.when`, so read the last part. */
function blankIn(field: string): string {
  return field.slice(field.lastIndexOf(".") + 1);
}

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
  const blanks = failedFields.map(blankIn);
  if (
    blanks.length === 0 ||
    !blanks.every((field) => CURATED_FIELDS.includes(field))
  ) {
    return [];
  }
  return CURATED_FIELDS.filter((blank) => blanks.includes(blank));
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
// receives: the fields of the value the boundary is handed. See DESIGN.md.
// ---------------------------------------------------------------------------

/**
 * One declared field. Naming it is a complete declaration on its own,
 * so `{}` and `{ required: true }` are both valid; the shape keys say
 * more about it when the author wants to.
 *
 * `required` here is the boolean "the boundary needs this field", not
 * the list of property names an object shape takes under the same word.
 * Nested properties go through ShapeSchema, where that list still works.
 */
const REQUIRED = {
  required: z
    .boolean()
    .default(false)
    .describe("Whether the boundary needs this field."),
};

const InputFieldSchema = z.union([
  z.strictObject({ ...REQUIRED, type: PrimitiveTypeName }),
  z.strictObject({
    ...REQUIRED,
    type: z.literal("array"),
    items: ShapeSchema.optional(),
  }),
  z.strictObject({
    ...REQUIRED,
    type: z.literal("object"),
    properties: z.record(z.string(), ShapeSchema).optional(),
  }),
  z.strictObject(REQUIRED),
]);

const ReceivesSchema = z
  .record(z.string().min(1), InputFieldSchema)
  .describe(
    "The fields the boundary is handed, by field name. On a function-call boundary a name is a parameter, on a message bus it is a field of the message body.",
  )
  .optional();

/**
 * A request comes in four parts the sender fills separately, so the
 * REST spelling has a section per part. `body` is a shape rather than a
 * map of fields, because a body is one value with properties under it.
 */
const RestReceivesSchema = z
  .strictObject({
    headers: z
      .record(z.string().min(1), InputFieldSchema)
      .describe("The request headers the boundary depends on, by name.")
      .optional(),
    query: z
      .record(z.string().min(1), InputFieldSchema)
      .describe("The query-string parameters the boundary depends on, by name.")
      .optional(),
    params: z
      .record(z.string().min(1), InputFieldSchema)
      .describe("The path parameters the boundary depends on, by name.")
      .optional(),
    body: BodyShapeSchema.describe(
      "The shape of the request body the boundary depends on.",
    ).optional(),
  })
  .describe("The parts of the request the boundary depends on.")
  .optional();

// ---------------------------------------------------------------------------
// Boundary: REST or function-call, in @suss/ir-core's vocabulary.
// ---------------------------------------------------------------------------

// Strict, so a misspelt key stops the run instead of vanishing. That
// rejects unknown keys only; the optional fields below stay optional.
const RestBoundarySchema = z.strictObject({
  transport: z.literal("http").default("http"),
  semantics: z.literal("rest"),
  method: z.string().min(1).describe("The HTTP method the route handles."),
  path: z
    .string()
    .min(1)
    .describe("The route path, written the way the framework declares it."),
  receives: RestReceivesSchema,
});

// Deliberately permissive: a function-call boundary is pairable today
// only when `package` + `exportPath` are set (see @suss/ir-core
// boundaryKey), but module-level boundaries stay authorable, declared-
// ahead-of-capability intent is a valid pending state, same as an
// unlinked PRD scenario. The checker reports such intent as unchecked
// (unkeyableBoundary) rather than this schema rejecting it; don't
// tighten this without also shipping module-level keying.
const FunctionCallBoundarySchema = z.strictObject({
  transport: z.string().default("in-process"),
  semantics: z.literal("function-call"),
  module: z
    .string()
    .describe(
      "The repo-relative module path, when the boundary is a unit inside this repository.",
    )
    .optional(),
  exportName: z
    .string()
    .describe("The name the module or package exports the function under.")
    .optional(),
  package: z
    .string()
    .describe(
      "The package name, when the boundary is something a package publishes.",
    )
    .optional(),
  exportPath: z
    .array(z.string())
    .describe(
      "The path to the export inside the package: the sub-path, then any nested names.",
    )
    .optional(),
  receives: ReceivesSchema,
});

// Both fields come off the ir-core schema, so a bus added there is
// authorable here with no edit. A doc that leaves the channel out is
// authorable and unpairable, and the checker is what says so.
const MessageBusBoundarySchema = z.strictObject({
  semantics: z.literal("message-bus"),
  messageBus: MessageBusSemanticsSchema.shape.messageBus.describe(
    "Which bus carries the message, in the name suss gives that bus.",
  ),
  channel: MessageBusSemanticsSchema.shape.channel
    .default(null)
    .describe(
      "The queue or topic the message travels on. Null when the document does not name one.",
    ),
  receives: ReceivesSchema,
});

// Same reuse, and the same pending state for a different reason: a
// store has no identity key at all, so every storage boundary intent
// is authorable and unpairable. See the README.
const StorageBoundarySchema = z.strictObject({
  semantics: z.literal("storage"),
  storageSystem: StorageSemanticsSchema.shape.storageSystem.describe(
    "Which store this is: postgresql, aws.dynamodb, s3, and so on.",
  ),
  scope: StorageSemanticsSchema.shape.scope
    .default("default")
    .describe(
      "The ORM, schema or deployment scope the container is in. A setup with one database uses default.",
    ),
  container: StorageSemanticsSchema.shape.container
    .default(null)
    .describe(
      "The table, bucket, collection or index. Null when the document does not name one.",
    ),
  accessPath: StorageSemanticsSchema.shape.accessPath
    .default(null)
    .describe(
      "A secondary way into the container, such as a DynamoDB index or an Elasticsearch alias. Null means the container's own primary way in.",
    ),
  receives: ReceivesSchema,
});

// Both fields come off the ir-core schema, the same reuse the bus and
// the store get. A doc that leaves the name out is authorable and
// unpairable, and the checker is what says so.
const UnitInvocationBoundarySchema = z.strictObject({
  semantics: z.literal("unit-invocation"),
  deploymentTarget:
    UnitInvocationSemanticsSchema.shape.deploymentTarget.describe(
      "What sort of deployed thing this is: a Lambda function, an ECS task's container, a plain container, a k8s deployment or an edge worker.",
    ),
  instanceName: UnitInvocationSemanticsSchema.shape.instanceName
    .default(null)
    .describe(
      "The name the deployment medium knows the unit by, such as a CloudFormation logical id. Null when the document does not name one.",
    ),
  receives: ReceivesSchema,
});

export const BoundarySchema = z.discriminatedUnion("semantics", [
  RestBoundarySchema,
  FunctionCallBoundarySchema,
  MessageBusBoundarySchema,
  StorageBoundarySchema,
  UnitInvocationBoundarySchema,
]);

// ---------------------------------------------------------------------------
// Transition outcomes: exactly one of response / returns / throws.
// ---------------------------------------------------------------------------

const ResponseOutcomeSchema = z.object({
  status: z
    .number()
    .int()
    .min(100)
    .max(599)
    .describe("The HTTP status code the response carries."),
  body: BodyShapeSchema.describe("The shape of the response body.").optional(),
});

const ReturnsOutcomeSchema = z.object({
  body: BodyShapeSchema.describe("The shape of the returned value.").optional(),
});

const ThrowsOutcomeSchema = z.object({
  errorType: z
    .string()
    .describe("The name of the error class this outcome raises.")
    .optional(),
});

// A key written with no value (`returns:` on its own line) parses to
// null in YAML. Treat a null outcome as the empty outcome so `returns:`
// and `returns: {}` mean the same body-less thing, instead of failing
// with "expected object, received null".
function emptyIfNull<T extends z.ZodTypeAny>(schema: T) {
  return z
    .preprocess((v) => (v === null ? {} : v), schema)
    .meta({ [ACCEPTS_NULL]: true });
}

/**
 * The meta key `emptyIfNull` leaves on a field for the JSON Schema
 * generator, which rewrites the field to accept null and takes the key
 * back out. JSON Schema has no word for a preprocess, so without this
 * the published schema would reject a bare `returns:` that suss takes.
 */
export const ACCEPTS_NULL = "x-suss-accepts-null";

/** One effect, written `- writes: postgresql:invoices`. */
export type DeclaredEffect = Partial<Record<EffectRelation, string>> & {
  /** The columns it touches, when the outcome turns on which ones. */
  fields?: string[];
  /** What it picks the item out by. */
  by?: string | string[];
};

/** One field, or several, so a single one is written on the line. */
const ONE_OR_MORE = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

// The verb is the key and the boundary is the string `suss ask` takes.
// The members come off ir-core's verbs, so one added there is
// authorable here with no edit.
const EFFECT_BY_VERB = EffectRelationSchema.options.map((verb) =>
  z.strictObject({
    [verb]: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1).optional(),
    by: ONE_OR_MORE.optional(),
  }),
) as unknown as [
  z.ZodType<DeclaredEffect>,
  ...Array<z.ZodType<DeclaredEffect>>,
];

const EffectOutcomeSchema = z.union(EFFECT_BY_VERB);

// ---------------------------------------------------------------------------
// when: what the branch turned on, in the same verbs `results` takes.
// ---------------------------------------------------------------------------

/** The words a clause has for what was true of its subject. */
const CHECKS = {
  /** What a lookup came back with. */
  finds: z.enum(["nothing", "something"]),
  /** What state the value was in: `set`, `missing`, `null`, `a string`. */
  is: z.string().min(1),
  /** The value it was equal to. */
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  /** A property it had. */
  has: z.string().min(1),
} as const;

/** Which value the clause is about: a boundary, or something the caller sent. */
const SUBJECT_KEYS: ReadonlyArray<EffectRelation | "input"> = [
  ...EffectRelationSchema.options,
  "input",
];

/**
 * A clause says which subject, says at most one thing about it, and can
 * narrow that with `where`. A guard that maps to none of this stays the
 * sentence the drafter wrote.
 */
const WHEN_CLAUSE_BY_SUBJECT = SUBJECT_KEYS.map((key) =>
  z
    .strictObject({
      [key]: z.string().min(1),
      where: z.string().min(1).optional(),
      ...Object.fromEntries(
        Object.entries(CHECKS).map(([check, schema]) => [
          check,
          schema.optional(),
        ]),
      ),
    })
    .refine(
      (clause) =>
        Object.keys(CHECKS).filter(
          (check) => (clause as Record<string, unknown>)[check] !== undefined,
        ).length <= 1,
      {
        message: `a when clause says at most one of ${Object.keys(CHECKS).join(", ")} about its subject`,
      },
    ),
) as unknown as [z.ZodType<WhenClause>, ...Array<z.ZodType<WhenClause>>];

/** One clause of a structured `when`, or the sentence for a guard that maps to none. */
export type WhenClause =
  | string
  | ({ where?: string } & Partial<Record<EffectRelation | "input", string>> & {
        finds?: "nothing" | "something";
        is?: string;
        equals?: string | number | boolean | null;
        has?: string;
      });

const WhenSchema = z.union([
  z.string().min(1),
  z.array(z.union([z.string().min(1), ...WHEN_CLAUSE_BY_SUBJECT])).min(1),
]);

const BoundaryTransitionSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .describe(
        "The outcome's name. A PRD scenario links to it as <intent-name>.<id>.",
      ),
    when: WhenSchema.describe(
      "What has to hold for this outcome, either as a list of clauses or as one sentence.",
    ),
    response: emptyIfNull(ResponseOutcomeSchema)
      .describe("This outcome sends an HTTP response.")
      .optional(),
    returns: emptyIfNull(ReturnsOutcomeSchema)
      .describe("This outcome returns a value to its caller.")
      .optional(),
    throws: emptyIfNull(ThrowsOutcomeSchema)
      .describe("This outcome raises an error.")
      .optional(),
    results: z
      .array(EffectOutcomeSchema)
      .min(1)
      .describe(
        "The effects this outcome has, written in the same verbs suss ask uses: reads, writes, invokes.",
      )
      .optional(),
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

// Strict for the same reason the boundary blocks are: suss reports
// `scenario:` written for `scenarios:` and stops.
const BoundaryIntentSchema = z.strictObject({
  kind: z
    .literal("boundary")
    .describe("Makes this document boundary intent for one boundary."),
  name: z
    .string()
    .min(1)
    .describe(
      "What this document is called. A PRD scenario links to an outcome of it as <name>.<outcome-id>.",
    ),
  purpose: z
    .string()
    .min(1)
    .describe("What the boundary is for, in the author's own words."),
  audience: z
    .string()
    .min(1)
    .describe("Who calls this boundary and depends on what it does."),
  source: IntentSourceSchema,
  boundary: BoundarySchema.describe(
    "Which boundary in the code the document is about.",
  ),
  transitions: z
    .array(BoundaryTransitionSchema)
    .min(1)
    .describe("Every outcome the boundary can produce, one entry each."),
});

// ---------------------------------------------------------------------------
// kind: prd: outcome intent (human scenarios).
// ---------------------------------------------------------------------------

const PrdScenarioSchema = z.strictObject({
  title: z
    .string()
    .min(1)
    .describe("A short name for the scenario.")
    .optional(),
  when: z
    .string()
    .min(1)
    .describe("The condition the scenario covers, in the author's own words."),
  expect: z
    .string()
    .min(1)
    .describe("What should happen then, in the author's own words."),
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
    .describe(
      "The boundary-intent outcomes this scenario is about, each written <intent-name>.<outcome-id>.",
    )
    .optional(),
});

const PrdSchema = z.strictObject({
  kind: z
    .literal("prd")
    .describe("Makes this document a PRD, a set of scenarios for a feature."),
  title: z.string().min(1).describe("What this document is called."),
  purpose: z
    .string()
    .min(1)
    .describe("What the feature is for, in the author's own words."),
  audience: z.string().min(1).describe("Who the feature is for."),
  source: IntentSourceSchema,
  scenarios: z
    .array(PrdScenarioSchema)
    .min(1)
    .describe("The situations the feature covers, one entry each."),
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
export type When = z.infer<typeof WhenSchema>;
export type Boundary = z.infer<typeof BoundarySchema>;
/** A boundary block as somebody writes it, before defaults are put in. */
export type AuthoredBoundary = z.input<typeof BoundarySchema>;
export type BoundaryTransition = z.infer<typeof BoundaryTransitionSchema>;
export type EffectOutcome = z.infer<typeof EffectOutcomeSchema>;
export type BodyShape = z.infer<typeof BodyShapeSchema>;
export type AuthoredInputField = z.infer<typeof InputFieldSchema>;
/** One `receives` block as somebody writes it, before defaults are put in. */
export type AuthoredReceives = Record<string, z.input<typeof InputFieldSchema>>;
/** The same, in the four sections a REST boundary writes it under. */
export type AuthoredRestReceives = NonNullable<
  z.input<typeof RestReceivesSchema>
>;
export type IntentSource = z.infer<typeof IntentSourceSchema>;
export type PrimitiveTypeName = z.infer<typeof PrimitiveTypeName>;
