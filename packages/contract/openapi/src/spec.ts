// spec.ts — Minimal OpenAPI 3.x type subset that suss consumes.
//
// We deliberately do not model the full spec — only the operation,
// parameter, requestBody, response, and schema fields that map onto
// BehavioralSummary. Anything else is ignored at parse time.

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "delete"
  | "patch"
  | "head"
  | "options"
  | "trace";

export const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, PathItem | undefined>;
  components?: {
    schemas?: Record<string, OpenApiSchema | undefined>;
    parameters?: Record<string, OpenApiParameter | undefined>;
    requestBodies?: Record<string, OpenApiRequestBody | undefined>;
    responses?: Record<string, OpenApiResponse | undefined>;
  };
}

export type PathItem = {
  parameters?: OpenApiParameter[];
} & Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse | undefined>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: OpenApiSchema;
  description?: string;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
  description?: string;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
  headers?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
}

/**
 * OpenAPI Schema Object (subset).
 *
 * Carries either an inline shape or a `$ref` to a component. Inline shapes
 * mirror JSON Schema with the OpenAPI extensions we care about.
 *
 * Supports both OpenAPI 3.0 and 3.1:
 *  - 3.0 uses `nullable: true` to mark a schema as nullable.
 *  - 3.1 aligns with JSON Schema 2020-12 and uses `type: ["string", "null"]`
 *    instead. 3.1 also adds `const` (a single-value shorthand for enum)
 *    and makes `discriminator` a top-level schema concept.
 *
 * We accept both forms. `schemaToShape` normalizes them into the same
 * TypeShape output.
 */
export type SchemaTypeName =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null";

export interface OpenApiDiscriminator {
  propertyName: string;
  /**
   * Mapping from discriminator value to `$ref` string. When present, the
   * variant with a matching `$ref` in `oneOf`/`anyOf` has its
   * `propertyName` narrowed to the exact literal value.
   */
  mapping?: Record<string, string>;
}

export interface OpenApiSchema {
  $ref?: string;
  /**
   * OpenAPI 3.0: a single type name.
   * OpenAPI 3.1 / JSON Schema 2020-12: either a single name or an array
   *   of names. When the array includes `"null"`, the schema is nullable.
   */
  type?: SchemaTypeName | SchemaTypeName[];
  /** 3.0 only — 3.1 encodes nullability via `type: [..., "null"]`. */
  nullable?: boolean;
  /** 3.1 / JSON Schema 2020-12 — a single-valued enum shorthand. */
  const?: string | number | boolean | null;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  discriminator?: OpenApiDiscriminator;
  format?: string;
  description?: string;
  example?: unknown;
}

export function isHttpMethod(s: string): s is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(s);
}
