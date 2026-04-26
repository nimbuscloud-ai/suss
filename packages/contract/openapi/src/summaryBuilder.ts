// summary-builder.ts — Build BehavioralSummary objects from OpenAPI operations.

import { restBinding } from "@suss/behavioral-ir";

import { newContext, schemaToShape } from "./schemaToShape.js";
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
    metadata: {
      openapi: {
        operationId: op.operationId ?? null,
        summary: op.summary ?? null,
        tags: op.tags ?? [],
      },
      http: {
        // Declared contract from the same operation that drove
        // `transitions[]` above. Provenance is "derived" —
        // self-consistency is tautological by construction, so the
        // cross-boundary checker's per-summary contract check skips
        // these. Other sources describing the same boundary (a CFN
        // stub, a handler implementation) can still be compared
        // against this contract via checkContractAgreement.
        declaredContract: buildDeclaredContract(op, ctx),
      },
    },
  };
}

function buildDeclaredContract(
  op: OpenApiOperation,
  ctx: ReturnType<typeof newContext>,
): {
  framework: string;
  provenance: "derived";
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
} {
  const responses: Array<{ statusCode: number; body: TypeShape | null }> = [];
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (response === undefined || code === "default") {
      continue;
    }
    if (!/^\d{3}$/.test(code)) {
      // Range codes (1XX-5XX) can't be represented as a single
      // statusCode in the declared-contract shape — skip. The
      // transition carries the range via metadata.http.statusRange
      // and downstream checks can still reason about it there.
      continue;
    }
    responses.push({
      statusCode: Number.parseInt(code, 10),
      body: bodyShape(response, ctx),
    });
  }
  return { framework: "openapi", provenance: "derived", responses };
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

    const body = bodyShape(response, ctx);

    if (code === "default") {
      // Default response — emit as the default transition with no status
      // literal. The checker can match it against any unhandled status.
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

    // Range code ("2XX", "4XX", …). The IR statusCode field is either a
    // literal ValueRef or null; there's no first-class "range" variant.
    // Emit a transition with statusCode: null and attach the range as
    // per-transition metadata under http.statusRange so consumers that
    // care (inspect, a future range-aware checker pass) can reason
    // about it. The transition stays isDefault: false — it's a specific
    // bucket, not the catch-all "default" response.
    transitions.push({
      id: stubTransitionId(op, code),
      conditions: [],
      output: { type: "response", statusCode: null, body, headers: {} },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      metadata: {
        http: {
          statusRange: { min: parsed.min, max: parsed.max, spec: code },
        },
      },
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
