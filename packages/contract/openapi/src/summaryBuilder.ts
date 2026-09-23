// Builds one handler summary per OpenAPI operation, with one transition
// per declared response status.

import { restBinding, withHttpMetadata } from "@suss/behavioral-ir";

import { newContext, schemaToShape } from "./schemaToShape.js";
import { isHttpMethod } from "./spec.js";

import type {
  BehavioralSummary,
  HttpDeclaredContract,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  HttpMethod,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSpec,
  PathItem,
} from "./spec.js";

export interface BuildOptions {
  /**
   * Recorded as each summary's `location.file`. Defaults to
   * `openapi:<info.title>`, or `openapi` when the document has no title.
   */
  source?: string;
}

export function specToSummaries(
  spec: OpenApiSpec,
  options: BuildOptions = {},
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const sourceFile =
    options.source ??
    (spec.info?.title !== undefined ? `openapi:${spec.info.title}` : "openapi");

  const paths = spec.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (item === undefined) {
      continue;
    }
    for (const verb of Object.keys(item)) {
      if (!isHttpMethod(verb)) {
        continue;
      }
      const op = item[verb as HttpMethod];
      if (op === undefined) {
        continue;
      }
      summaries.push(
        buildSummary(spec, servedPath(spec, path), verb, op, item, sourceFile),
      );
    }
  }

  return summaries;
}

/**
 * Swagger 2.0's `basePath`, or the path of OpenAPI 3's first server URL,
 * goes in front of the route. A server URL's host is dropped, because it
 * picks a deployment and leaves the route the same.
 */
function servedPath(spec: OpenApiSpec, path: string): string {
  const prefix = statedPrefix(spec).replace(/\/+$/, "");
  return prefix === "" ? path : `${prefix}${path}`;
}

function statedPrefix(spec: OpenApiSpec): string {
  if (spec.basePath !== undefined) {
    return spec.basePath;
  }
  const url = spec.servers?.[0]?.url;
  if (url === undefined) {
    return "";
  }
  try {
    return new URL(url).pathname;
  } catch {
    // A server URL may be written relative, and then it is already a path.
    return url;
  }
}

function buildSummary(
  spec: OpenApiSpec,
  path: string,
  method: HttpMethod,
  op: OpenApiOperation,
  pathItem: PathItem,
  sourceFile: string,
): BehavioralSummary {
  const ctx = newContext(spec);
  const upper = method.toUpperCase();
  const name = op.operationId ?? `${upper} ${path}`;

  // Path-level parameters apply to every operation. An operation's own
  // parameter with the same name and location replaces the path's.
  const params = mergeParameters(pathItem.parameters, op.parameters);

  const inputs = buildInputs(params, op, ctx);
  const transitions = buildTransitions(op, ctx);

  return {
    kind: "handler",
    location: {
      file: sourceFile,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: upper,
        path,
        recognition: "openapi",
      }),
    },
    inputs,
    transitions,
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: withHttpMetadata(
      {
        openapi: {
          operationId: op.operationId ?? null,
          summary: op.summary ?? null,
          tags: op.tags ?? [],
        },
      },
      {
        // "derived" because the transitions come from the same operation,
        // so the per-summary contract check skips it. checkContractAgreement
        // still compares it with other sources for the same route.
        declaredContract: buildDeclaredContract(op, ctx),
      },
    ),
  };
}

/**
 * Keeps every form a `responses` key can take: a literal code, a range
 * such as `4XX`, and `default`. The README describes how the checker
 * reads each one.
 */
function buildDeclaredContract(
  op: OpenApiOperation,
  ctx: ReturnType<typeof newContext>,
): HttpDeclaredContract & { provenance: "derived" } {
  const responses: Array<{ statusCode: number; body: TypeShape | null }> = [];
  const responseRanges: Array<{
    min: number;
    max: number;
    spec: string;
    body: TypeShape | null;
  }> = [];
  let defaultResponse: { body: TypeShape | null } | undefined;

  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (response === undefined) {
      continue;
    }

    if (code === "default") {
      defaultResponse = { body: bodyShape(response, ctx) };
      continue;
    }

    const parsed = parseStatusCode(code);
    if (parsed === null) {
      continue;
    }

    if (parsed.kind === "literal") {
      responses.push({
        statusCode: parsed.value,
        body: bodyShape(response, ctx),
      });
      continue;
    }

    responseRanges.push({
      min: parsed.min,
      max: parsed.max,
      spec: code,
      body: bodyShape(response, ctx),
    });
  }

  return {
    framework: "openapi",
    provenance: "derived",
    responses,
    ...(responseRanges.length > 0 ? { responseRanges } : {}),
    ...(defaultResponse !== undefined ? { defaultResponse } : {}),
  };
}

function mergeParameters(
  pathLevel: OpenApiParameter[] | undefined,
  opLevel: OpenApiParameter[] | undefined,
): OpenApiParameter[] {
  const seen = new Set<string>();
  const merged: OpenApiParameter[] = [];
  // Operation-level wins, so add them first.
  for (const p of opLevel ?? []) {
    seen.add(`${p.in}:${p.name}`);
    merged.push(p);
  }
  for (const p of pathLevel ?? []) {
    const key = `${p.in}:${p.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }
  return merged;
}

function buildInputs(
  params: OpenApiParameter[],
  op: OpenApiOperation,
  ctx: ReturnType<typeof newContext>,
): Input[] {
  const inputs: Input[] = [];

  for (const p of params) {
    inputs.push({
      type: "parameter",
      name: p.name,
      position: 0,
      role: locationToRole(p.in),
      shape: schemaToShape(parameterSchema(p), ctx),
    });
  }

  // requestBody becomes one input with role "requestBody", carrying
  // the schema of the media type a caller is most likely to send.
  const body = op.requestBody;
  if (body !== undefined) {
    const firstContent = chosenContent(body.content);
    inputs.push({
      type: "parameter",
      name: "body",
      position: 0,
      role: "requestBody",
      shape:
        firstContent?.schema !== undefined
          ? schemaToShape(firstContent.schema, ctx)
          : { type: "unknown" },
    });
  }

  return inputs;
}

/** Swagger 2.0 writes a scalar parameter's schema on the parameter itself. */
function parameterSchema(p: OpenApiParameter): OpenApiSchema | undefined {
  if (p.schema !== undefined) {
    return p.schema;
  }
  if (p.type === undefined) {
    return undefined;
  }
  return {
    type: p.type,
    ...(p.format !== undefined ? { format: p.format } : {}),
    ...(p.items !== undefined ? { items: p.items } : {}),
    ...(p.enum !== undefined ? { enum: p.enum } : {}),
  };
}

/**
 * Swagger 2.0's `body` and `formData` parameters get the role OpenAPI 3's
 * `requestBody` gets, so both versions pair with the same handler input.
 */
function locationToRole(loc: OpenApiParameter["in"]): string {
  switch (loc) {
    case "path":
      return "pathParams";
    case "query":
      return "queryParams";
    case "header":
      return "headers";
    case "cookie":
      return "cookies";
    case "body":
      return "requestBody";
    case "formData":
      return "requestBody";
  }
}

function buildTransitions(
  op: OpenApiOperation,
  ctx: ReturnType<typeof newContext>,
): Transition[] {
  const responses = op.responses ?? {};
  const transitions: Transition[] = [];

  for (const [code, response] of Object.entries(responses)) {
    if (response === undefined) {
      continue;
    }

    const body = bodyShape(response, ctx);

    if (code === "default") {
      // `default` covers every status the other entries leave out, so it
      // is the isDefault transition. The README describes how the checker
      // reads it.
      transitions.push({
        id: stubTransitionId(op, "default"),
        conditions: [],
        output: { type: "response", statusCode: null, body, headers: {} },
        effects: [],
        location: { start: 0, end: 0 },
        isDefault: true,
      });
      continue;
    }

    const parsed = parseStatusCode(code);
    if (parsed === null) {
      continue;
    }

    if (parsed.kind === "literal") {
      transitions.push({
        id: stubTransitionId(op, code),
        conditions: [],
        output: {
          type: "response",
          statusCode: { type: "literal", value: parsed.value },
          body,
          headers: {},
        },
        effects: [],
        location: { start: 0, end: 0 },
        isDefault: false,
      });
      continue;
    }

    // A range has no single status code, so it goes in `http.statusRange`
    // for the coverage pass. It covers one class of statuses, so it is
    // not the default transition.
    transitions.push({
      id: stubTransitionId(op, code),
      conditions: [],
      output: { type: "response", statusCode: null, body, headers: {} },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      metadata: withHttpMetadata(undefined, {
        statusRange: { min: parsed.min, max: parsed.max, spec: code },
      }),
    });
  }

  return transitions;
}

/**
 * A JSON media type wins, so a JSON caller is never compared against an
 * XML schema listed first. Otherwise the first in sorted order wins, so
 * two runs agree. #387 tracks comparing the media type itself.
 */
function chosenContent<T extends { schema?: unknown }>(
  content: Record<string, T> | undefined,
): T | undefined {
  if (content === undefined) {
    return undefined;
  }
  const mediaTypes = Object.keys(content);
  const json = mediaTypes.find(
    (type) => type === "application/json" || type.endsWith("+json"),
  );
  const chosen = json ?? [...mediaTypes].sort()[0];
  return chosen === undefined ? undefined : content[chosen];
}

function bodyShape(
  response: NonNullable<OpenApiOperation["responses"]>[string],
  ctx: ReturnType<typeof newContext>,
): TypeShape | null {
  if (response === undefined) {
    return null;
  }
  // Swagger 2.0 writes the schema on the response, 3.x inside a media type.
  const schema =
    response.content === undefined
      ? response.schema
      : chosenContent(response.content)?.schema;
  return schema === undefined ? null : schemaToShape(schema, ctx);
}

type ParsedStatus =
  | { kind: "literal"; value: number }
  | { kind: "range"; min: number; max: number };

function parseStatusCode(code: string): ParsedStatus | null {
  // Exact numeric code: "200", "404", "418".
  if (/^\d{3}$/.test(code)) {
    return { kind: "literal", value: Number.parseInt(code, 10) };
  }
  // Range code: "1XX" through "5XX", case-insensitive.
  const range = /^([1-5])[xX][xX]$/.exec(code);
  if (range !== null) {
    const hundreds = Number.parseInt(range[1], 10);
    return { kind: "range", min: hundreds * 100, max: hundreds * 100 + 99 };
  }
  return null;
}

function stubTransitionId(op: OpenApiOperation, codeOrTag: string): string {
  const opName = op.operationId ?? "anonymous";
  return `${opName}:response:${codeOrTag}:stub`;
}
