// schema.ts — Zod schema for the v0 intent-spec file format.
//
// An intent spec is a team-authored declaration of what a boundary
// should do, in the same shape suss derives from code. The schema
// here is the surface authors interact with (YAML / JSON); the
// summary builder maps it into the IR's BehavioralSummary shape.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Type aliases — the spec uses user-friendly names ("string") that map onto
// the IR's TypeShape names ("text"). Keeping the alias here means authors
// don't have to learn the IR vocabulary to write a spec.
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
// shape for HTTP responses. Nested objects, arrays, and unions are deferred
// to v1; they're additive once the v0 reader is in production use.
const BodyShapeSchema = z
  .object({
    type: z.literal("object").optional(),
    properties: z.record(z.string(), PrimitivePropertySchema).optional(),
    required: z.array(z.string()).optional(),
  })
  .nullable();

// ---------------------------------------------------------------------------
// Boundary — v0 only supports REST (http + status + body). Other semantics
// (graphql-resolver, message-bus, etc.) get their own variants in v1.
// ---------------------------------------------------------------------------

const RestBoundarySchema = z.object({
  transport: z.literal("http"),
  semantics: z.literal("rest"),
  method: z.string().min(1),
  path: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Transitions — one per outcome the boundary can produce.
// ---------------------------------------------------------------------------

const RestTransitionSchema = z.object({
  // Natural-language predicate. Captured as an opaque predicate on the
  // resulting summary; the checker pairs by (kind, statusCode), not by
  // predicate-text equality.
  when: z.string().min(1),
  output: z.object({
    status: z.number().int().min(100).max(599),
    body: BodyShapeSchema.optional(),
  }),
});

// ---------------------------------------------------------------------------
// Top-level intent spec.
// ---------------------------------------------------------------------------

export const IntentSpecSchema = z.object({
  boundary: RestBoundarySchema,
  // `purpose` and `audience` come from the concept-design framing — they're
  // what a well-formed PRD names. v0 enforces both as required so a spec
  // can't slip into shape without an owner / a reason for existing.
  purpose: z.string().min(1),
  audience: z.string().min(1),
  transitions: z.array(RestTransitionSchema).min(1),
});

export type IntentSpec = z.infer<typeof IntentSpecSchema>;
export type RestBoundary = z.infer<typeof RestBoundarySchema>;
export type RestTransition = z.infer<typeof RestTransitionSchema>;
export type BodyShape = z.infer<typeof BodyShapeSchema>;
export type PrimitiveTypeName = z.infer<typeof PrimitiveTypeName>;
