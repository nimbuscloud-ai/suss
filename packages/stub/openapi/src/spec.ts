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
 * mirror JSON Schema with the OpenAPI extensions we care about (`nullable`,
 * `oneOf`, `anyOf`, `enum`).
 */
export interface OpenApiSchema {
  $ref?: string;
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  nullable?: boolean;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  format?: string;
  description?: string;
  example?: unknown;
}

export function isHttpMethod(s: string): s is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(s);
}
