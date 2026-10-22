/**
 * The span model the oracle reads, and the reader for OTLP JSON.
 *
 * A file is either one OTLP `ExportTraceServiceRequest` in JSON, or one
 * such request per line, which is what the Collector's file exporter and
 * this tool's recorder write. Every reader turns what it reads into
 * `Span`, so the edge mapping never sees where a span came from.
 */

import fs from "node:fs";

import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpTraceRequest,
} from "./otlpProtobuf.js";

export type SpanKind =
  | "unspecified"
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

export type AttributeValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  /** The instrumentation scope that wrote the span, such as `@opentelemetry/instrumentation-knex`. */
  scope: string;
  attributes: Record<string, AttributeValue>;
  /** The resource the span came from: service name, process arguments. */
  resource: Record<string, AttributeValue>;
}

/** OTLP JSON writes the kind as the enum's number or its name. */
const KIND_BY_NUMBER: Record<number, SpanKind> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

function kindOf(kind: number | string | undefined): SpanKind {
  if (typeof kind === "number") {
    return KIND_BY_NUMBER[kind] ?? "unspecified";
  }
  const name = (kind ?? "").replace(/^SPAN_KIND_/, "").toLowerCase();
  return (Object.values(KIND_BY_NUMBER) as string[]).includes(name)
    ? (name as SpanKind)
    : "unspecified";
}

function attributeValue(value: OtlpAnyValue): AttributeValue | undefined {
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  if (value.doubleValue !== undefined) {
    return value.doubleValue;
  }
  // An array such as process.command_args is only ever matched as text.
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values
      .map((item) => attributeValue(item))
      .filter((item) => item !== undefined)
      .join(" ");
  }
  return undefined;
}

export function attributesOf(
  pairs: readonly OtlpKeyValue[] | undefined,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const pair of pairs ?? []) {
    const value = attributeValue(pair.value);
    if (value !== undefined) {
      attributes[pair.key] = value;
    }
  }
  return attributes;
}

export function spansFromRequest(request: OtlpTraceRequest): Span[] {
  const spans: Span[] = [];
  for (const resourceSpans of request.resourceSpans ?? []) {
    const resource = attributesOf(resourceSpans.resource?.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scope = scopeSpans.scope?.name ?? "";
      for (const span of scopeSpans.spans ?? []) {
        spans.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId:
            span.parentSpanId === undefined || span.parentSpanId === ""
              ? null
              : span.parentSpanId,
          name: span.name,
          kind: kindOf(span.kind),
          scope,
          attributes: attributesOf(span.attributes),
          resource,
        });
      }
    }
  }
  return spans;
}

const NEWLINE = 0x0a;

/**
 * Every span in a file of OTLP JSON, whether it contains one request or
 * one per line. Lines are decoded one at a time, since a test run's file
 * can be larger than the longest string V8 allows. A single request
 * written across several lines is read whole.
 */
export function readSpanFile(file: string): Span[] {
  const bytes = fs.readFileSync(file);
  const lines: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(NEWLINE, start);
    const stop = end === -1 ? bytes.length : end;
    const line = bytes.toString("utf8", start, stop).trim();
    if (line !== "") {
      lines.push(line);
    }
    start = stop + 1;
  }
  try {
    return lines.flatMap((line) =>
      spansFromRequest(JSON.parse(line) as OtlpTraceRequest),
    );
  } catch {
    return spansFromRequest(JSON.parse(lines.join("\n")) as OtlpTraceRequest);
  }
}

/** A text attribute, or undefined when the span has none or has a number there. */
export function textAttribute(
  attributes: Record<string, AttributeValue>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = attributes[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}
