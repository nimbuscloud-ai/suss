// summary-builder.ts: Build BehavioralSummary objects from OpenAPI operations.

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
    metadata: withHttpMetadata(
      {
        openapi: {
          operationId: op.operationId ?? null,
          summary: op.summary ?? null,
          tags: op.tags ?? [],
        },
      },
      {
        // Declared contract from the same operation that drove
        // `transitions[]` above. Provenance is "derived": self-
        // consistency is tautological by construction, so the cross-
        // boundary checker's per-summary contract check skips these.
        // Other sources describing the same boundary (a CFN stub, a
        // handler implementation) can still be compared against this
        // contract via checkContractAgreement.
        declaredContract: buildDeclaredContract(op, ctx),
      },
    ),
  };
}

/**
 * The operation's `responses` block, keeping every form the document
 * may use: a literal code, a range code ("4XX" promises some status
 * between 400 and 499), and `default`, which covers every status the
 * other entries leave out. The README says how the checker reads each.
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
      shape: schemaToShape(p.schema, ctx),
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
      // `default` covers every status the other entries leave out, so it
      // becomes the isDefault transition and the checker reads it as
      // "the provider may return any status". The README says why.
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

    // A range code has no literal for the IR's statusCode field, so it
    // is recorded on the transition as http.statusRange, which the
    // coverage pass reads. Not isDefault: it is one bucket.
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
 * The schema for the media type a client is most likely to send or
 * read. An operation that offers several used to give whichever one
 * the document happened to list first, so a spec writing
 * application/xml above application/json handed back the XML schema
 * and every JSON caller was compared against it. JSON wins when it is
 * offered; otherwise the media types are taken in sorted order, so two
 * runs over one document agree. Comparing the media type itself is
 * #387.
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
  if (response === undefined || response.content === undefined) {
    return null;
  }
  const firstContent = chosenContent(response.content);
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
