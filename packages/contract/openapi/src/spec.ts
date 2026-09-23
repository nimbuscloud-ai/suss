// The part of OpenAPI 3.x and Swagger 2.0 that maps onto a summary. Any
// other field in a document is ignored when it is read.

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
  /** Swagger 2.0 puts the prefix for every path here. */
  basePath?: string;
  /** OpenAPI 3 puts the prefix in the first server's URL instead. */
  servers?: Array<{ url?: string }>;
  paths?: Record<string, PathItem | undefined>;
  /** Swagger 2.0 keeps its named schemas here, where 3.x uses `components.schemas`. */
  definitions?: Record<string, OpenApiSchema | undefined>;
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
  /**
   * Swagger 2.0 also writes a request body and a form field as parameters,
   * `body` and `formData`. OpenAPI 3 moved both into `requestBody`.
   */
  in: "path" | "query" | "header" | "cookie" | "body" | "formData";
  required?: boolean;
  schema?: OpenApiSchema;
  /**
   * Swagger 2.0 puts a scalar parameter's type and other schema keywords
   * on the parameter itself, where 3.x wraps them in `schema`.
   */
  type?: OpenApiSchema["type"];
  format?: OpenApiSchema["format"];
  items?: OpenApiSchema["items"];
  enum?: OpenApiSchema["enum"];
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
  /** Swagger 2.0 writes the body's schema here, with no media type around it. */
  schema?: OpenApiSchema;
  headers?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
}

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
   * Discriminator value to `$ref`. The `oneOf` or `anyOf` variant with a
   * matching `$ref` has its `propertyName` narrowed to that value.
   */
  mapping?: Record<string, string>;
}

/**
 * Covers both OpenAPI 3.0 and 3.1. 3.0 marks a nullable schema with
 * `nullable: true`, and 3.1 follows JSON Schema 2020-12 and lists `"null"`
 * in `type` instead. `schemaToShape` gives the same TypeShape for both.
 */
export interface OpenApiSchema {
  $ref?: string;
  /** 3.1 allows an array of type names, and `"null"` in it means nullable. */
  type?: SchemaTypeName | SchemaTypeName[];
  /** 3.0 only. */
  nullable?: boolean;
  /** 3.1 shorthand for a one-value enum. */
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
