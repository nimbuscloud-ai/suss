// summary-builder.ts — Build BehavioralSummary objects from OpenAPI operations.

import { newContext, schemaToShape } from "./schema-to-shape.js";
import { isHttpMethod } from "./spec.js";

import type {
  BehavioralSummary,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  HttpMethod,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSpec,
  PathItem,
} from "./spec.js";

export interface BuildOptions {
  /**
   * Logical source location to record on each summary. Used as the `file`
   * field on `SourceLocation`. Defaults to "openapi:<info.title>" or just
   * "openapi" when no title is set.
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
      summaries.push(buildSummary(spec, path, verb, op, item, sourceFile));
    }
  }

  return summaries;
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

  // Path-level parameters apply to every operation; operation-level overrides
  // by (name, in) take precedence.
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
      boundaryBinding: {
        protocol: "http",
        method: upper,
        path,
        framework: "openapi",
      },
    },
    inputs,
    transitions,
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      openapi: {
        operationId: op.operationId ?? null,
        summary: op.summary ?? null,
        tags: op.tags ?? [],
      },
    },
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
      shape: schemaToShape(p.schema, ctx),
    });
  }

  // requestBody → single input with role "requestBody". Pick the first
  // content type's schema (typically application/json); the shape is what
  // matters for cross-boundary checking, not the media type.
  const body = op.requestBody;
  if (body !== undefined) {
    const firstContent = Object.values(body.content ?? {})[0];
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
    if (code === "default") {
      // Default response — emit as the default transition with no status
      // literal. The checker can match it against any unhandled status.
      transitions.push({
        id: stubTransitionId(op, "default"),
        conditions: [],
        output: {
          type: "response",
          statusCode: null,
          body: bodyShape(response, ctx),
          headers: {},
        },
        effects: [],
        location: { start: 0, end: 0 },
        isDefault: true,
      });
      continue;
    }

    const statusValue = parseStatusCode(code);
    if (statusValue === null) {
      continue;
    }

    transitions.push({
      id: stubTransitionId(op, code),
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: statusValue },
        body: bodyShape(response, ctx),
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
    });
  }

  return transitions;
}

function bodyShape(
  response: NonNullable<OpenApiOperation["responses"]>[string],
  ctx: ReturnType<typeof newContext>,
): TypeShape | null {
  if (response === undefined || response.content === undefined) {
    return null;
  }
  const firstContent = Object.values(response.content)[0];
  if (firstContent?.schema === undefined) {
    return null;
  }
  return schemaToShape(firstContent.schema, ctx);
}

function parseStatusCode(code: string): number | null {
  // Accept numeric codes ("200") and keep range codes ("2XX") as null;
  // range codes can't be checked against a specific provider response and
  // the consumer side won't see them either. Documented as a v0 limitation.
  if (/^\d{3}$/.test(code)) {
    return Number.parseInt(code, 10);
  }
  return null;
}

function stubTransitionId(op: OpenApiOperation, codeOrTag: string): string {
  const opName = op.operationId ?? "anonymous";
  return `${opName}:response:${codeOrTag}:stub`;
}
