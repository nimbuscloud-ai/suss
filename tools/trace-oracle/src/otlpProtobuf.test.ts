import { describe, expect, it } from "vitest";

import { decodeTraceRequest } from "./otlpProtobuf.js";

// A minimal protobuf writer, enough to build the request an exporter sends.
function varint(value: number | bigint): number[] {
  let rest = BigInt(value);
  const bytes: number[] = [];
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest > 0n ? low | 0x80 : low);
  } while (rest > 0n);
  return bytes;
}

function bytesField(number: number, payload: number[]): number[] {
  return [...varint((number << 3) | 2), ...varint(payload.length), ...payload];
}

function textField(number: number, text: string): number[] {
  return bytesField(number, [...Buffer.from(text, "utf8")]);
}

function varintField(number: number, value: number | bigint): number[] {
  return [...varint(number << 3), ...varint(value)];
}

function fixed64Field(number: number, value: bigint): number[] {
  const bytes: number[] = [];
  for (let index = 0n; index < 8n; index += 1n) {
    bytes.push(Number((value >> (8n * index)) & 0xffn));
  }
  return [...varint((number << 3) | 1), ...bytes];
}

function keyValue(key: string, value: number[]): number[] {
  return [...textField(1, key), ...bytesField(2, value)];
}

const traceId = Array.from({ length: 16 }, (_, index) => index);
const spanId = [1, 2, 3, 4, 5, 6, 7, 8];
const parentId = [8, 7, 6, 5, 4, 3, 2, 1];

const span = [
  ...bytesField(1, traceId),
  ...bytesField(2, spanId),
  ...bytesField(4, parentId),
  ...textField(5, "select users"),
  ...varintField(6, 3),
  ...fixed64Field(7, 1_700_000_000_000_000_000n),
  ...bytesField(9, keyValue("db.system.name", textField(1, "postgresql"))),
  ...bytesField(9, keyValue("db.response.returned_rows", varintField(3, 42))),
  ...bytesField(9, keyValue("retry", varintField(2, 1))),
  ...bytesField(
    9,
    keyValue(
      "process.command_args",
      bytesField(5, [
        ...bytesField(1, textField(1, "node")),
        ...bytesField(1, textField(1, "app.js")),
      ]),
    ),
  ),
];
const scopeSpans = [
  ...bytesField(1, textField(1, "@opentelemetry/instrumentation-pg")),
  ...bytesField(2, span),
];
const resourceSpans = [
  ...bytesField(
    1,
    bytesField(1, keyValue("service.name", textField(1, "api"))),
  ),
  ...bytesField(2, scopeSpans),
];
const request = Uint8Array.from(bytesField(1, resourceSpans));

describe("decodeTraceRequest", () => {
  it("reads ids, name, kind, times and attributes the way OTLP JSON writes them", () => {
    const decoded = decodeTraceRequest(request);
    const resource = decoded.resourceSpans?.[0];
    const scope = resource?.scopeSpans?.[0];
    const one = scope?.spans?.[0];

    expect(resource?.resource?.attributes).toEqual([
      { key: "service.name", value: { stringValue: "api" } },
    ]);
    expect(scope?.scope?.name).toBe("@opentelemetry/instrumentation-pg");
    expect(one).toMatchObject({
      traceId: "000102030405060708090a0b0c0d0e0f",
      spanId: "0102030405060708",
      parentSpanId: "0807060504030201",
      name: "select users",
      kind: 3,
      startTimeUnixNano: "1700000000000000000",
    });
    expect(one?.attributes).toEqual([
      { key: "db.system.name", value: { stringValue: "postgresql" } },
      { key: "db.response.returned_rows", value: { intValue: "42" } },
      { key: "retry", value: { boolValue: true } },
      {
        key: "process.command_args",
        value: {
          arrayValue: {
            values: [{ stringValue: "node" }, { stringValue: "app.js" }],
          },
        },
      },
    ]);
  });

  it("leaves a root span without a parent id", () => {
    const root = Uint8Array.from(
      bytesField(
        1,
        bytesField(
          2,
          bytesField(2, [
            ...bytesField(1, traceId),
            ...bytesField(2, spanId),
            ...textField(5, "GET /"),
          ]),
        ),
      ),
    );
    const one =
      decodeTraceRequest(root).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];

    expect(one?.parentSpanId).toBeUndefined();
  });
});
