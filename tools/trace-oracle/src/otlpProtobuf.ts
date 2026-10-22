/**
 * Decodes an OTLP `ExportTraceServiceRequest` from protobuf into the
 * JSON form the OpenTelemetry Collector's file exporter writes.
 *
 * Python and Ruby send traces over OTLP only as protobuf, so the
 * recorder has to read it to keep one file format for every language.
 * Only the fields a span reader uses are decoded: resource and scope
 * attributes, and each span's ids, name, kind, times and attributes.
 * Events, links and status are skipped. Field numbers follow
 * `opentelemetry/proto/trace/v1/trace.proto` and `common/v1/common.proto`.
 */

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  bytesValue?: string;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number | string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

/** One field read off the wire: its number and its raw value. */
interface Field {
  number: number;
  /** Varints and fixed-width integers, as bigints so 64-bit times survive. */
  integer?: bigint;
  bytes?: Uint8Array;
}

/** Wire type 0 is a varint, 1 is 64 bits, 2 is length-delimited, 5 is 32 bits. */
function readFields(buffer: Uint8Array): Field[] {
  const fields: Field[] = [];
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[at];
      if (byte === undefined) {
        throw new Error("protobuf varint runs past the end of the message");
      }
      at += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
  };
  const fixed = (width: number): bigint => {
    let result = 0n;
    for (let index = width - 1; index >= 0; index -= 1) {
      result = (result << 8n) | BigInt(buffer[at + index] ?? 0);
    }
    at += width;
    return result;
  };
  while (at < buffer.length) {
    const tag = Number(varint());
    const number = tag >>> 3;
    const wire = tag & 7;
    const read = WIRE_READERS[wire];
    if (read === undefined) {
      throw new Error(`protobuf wire type ${wire} is not one OTLP uses`);
    }
    fields.push({ number, ...read({ varint, fixed, slice }) });
  }
  return fields;

  function slice(): Uint8Array {
    const length = Number(varint());
    const bytes = buffer.subarray(at, at + length);
    at += length;
    return bytes;
  }
}

interface WireCursor {
  varint(): bigint;
  fixed(width: number): bigint;
  slice(): Uint8Array;
}

const WIRE_READERS: Record<
  number,
  (cursor: WireCursor) => Omit<Field, "number">
> = {
  0: (cursor) => ({ integer: cursor.varint() }),
  1: (cursor) => ({ integer: cursor.fixed(8) }),
  2: (cursor) => ({ bytes: cursor.slice() }),
  5: (cursor) => ({ integer: cursor.fixed(4) }),
};

const TEXT = new TextDecoder();

function text(field: Field): string {
  return field.bytes === undefined ? "" : TEXT.decode(field.bytes);
}

function hex(field: Field): string {
  return field.bytes === undefined
    ? ""
    : Buffer.from(field.bytes).toString("hex");
}

function messages(fields: Field[], number: number): Uint8Array[] {
  return fields
    .filter((field) => field.number === number && field.bytes !== undefined)
    .map((field) => field.bytes as Uint8Array);
}

function first(fields: Field[], number: number): Field | undefined {
  return fields.find((field) => field.number === number);
}

/** The AnyValue oneof: 1 string, 2 bool, 3 int, 4 double, 5 array, 6 kvlist, 7 bytes. */
function anyValue(buffer: Uint8Array): OtlpAnyValue {
  const fields = readFields(buffer);
  const value: OtlpAnyValue = {};
  for (const field of fields) {
    ANY_VALUE_READERS[field.number]?.(field, value);
  }
  return value;
}

const ANY_VALUE_READERS: Record<
  number,
  (field: Field, value: OtlpAnyValue) => void
> = {
  1: (field, value) => {
    value.stringValue = text(field);
  },
  2: (field, value) => {
    value.boolValue = field.integer === 1n;
  },
  3: (field, value) => {
    value.intValue = BigInt.asIntN(64, field.integer ?? 0n).toString();
  },
  4: (field, value) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, field.integer ?? 0n, true);
    value.doubleValue = view.getFloat64(0, true);
  },
  5: (field, value) => {
    const items =
      field.bytes === undefined ? [] : messages(readFields(field.bytes), 1);
    value.arrayValue = { values: items.map(anyValue) };
  },
  6: (field, value) => {
    const items =
      field.bytes === undefined ? [] : messages(readFields(field.bytes), 1);
    value.kvlistValue = { values: items.map(keyValue) };
  },
  7: (field, value) => {
    value.bytesValue = Buffer.from(field.bytes ?? []).toString("base64");
  },
};

function keyValue(buffer: Uint8Array): OtlpKeyValue {
  const fields = readFields(buffer);
  const key = first(fields, 1);
  const value = first(fields, 2);
  return {
    key: key === undefined ? "" : text(key),
    value: value?.bytes === undefined ? {} : anyValue(value.bytes),
  };
}

function span(buffer: Uint8Array): OtlpSpan {
  const fields = readFields(buffer);
  const parent = first(fields, 4);
  const parentId = parent === undefined ? "" : hex(parent);
  return {
    traceId: hex(first(fields, 1) ?? { number: 1 }),
    spanId: hex(first(fields, 2) ?? { number: 2 }),
    ...(parentId === "" ? {} : { parentSpanId: parentId }),
    name: text(first(fields, 5) ?? { number: 5 }),
    kind: Number(first(fields, 6)?.integer ?? 0n),
    startTimeUnixNano: String(first(fields, 7)?.integer ?? 0n),
    endTimeUnixNano: String(first(fields, 8)?.integer ?? 0n),
    attributes: messages(fields, 9).map(keyValue),
  };
}

function scopeSpans(buffer: Uint8Array): OtlpScopeSpans {
  const fields = readFields(buffer);
  const scope = first(fields, 1);
  const scopeFields = scope?.bytes === undefined ? [] : readFields(scope.bytes);
  const name = first(scopeFields, 1);
  const version = first(scopeFields, 2);
  return {
    scope: {
      name: name === undefined ? "" : text(name),
      ...(version === undefined ? {} : { version: text(version) }),
    },
    spans: messages(fields, 2).map(span),
  };
}

function resourceSpans(buffer: Uint8Array): OtlpResourceSpans {
  const fields = readFields(buffer);
  const resource = first(fields, 1);
  const attributes =
    resource?.bytes === undefined
      ? []
      : messages(readFields(resource.bytes), 1).map(keyValue);
  return {
    resource: { attributes },
    scopeSpans: messages(fields, 2).map(scopeSpans),
  };
}

export function decodeTraceRequest(buffer: Uint8Array): OtlpTraceRequest {
  return { resourceSpans: messages(readFields(buffer), 1).map(resourceSpans) };
}
