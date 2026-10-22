/**
 * Runs a command with an OTLP receiver on localhost and writes every
 * span the command exports to a file, one OTLP JSON request per line.
 *
 * The receiver accepts OTLP over HTTP as JSON or protobuf, gzipped or
 * not, so each language keeps its stock exporter: the Node SDK, Python's
 * `opentelemetry-instrument` and Ruby's OTLP exporter gem all point at
 * it through `OTEL_EXPORTER_OTLP_ENDPOINT`. Instrumenting the command is
 * the caller's job; this only receives.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";

import { decodeTraceRequest } from "./otlpProtobuf.js";

import type { AddressInfo } from "node:net";
import type { OtlpTraceRequest } from "./otlpProtobuf.js";

export interface RecordOptions {
  out: string;
  command: readonly string[];
  /** How long to keep receiving after the command exits, for exports still in flight. */
  drainMs?: number;
}

export interface RecordResult {
  exitCode: number;
  requests: number;
  spans: number;
}

function bodyOf(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function decoded(
  body: Buffer,
  encoding: string | undefined,
  type: string | undefined,
): OtlpTraceRequest {
  const raw = encoding === "gzip" ? zlib.gunzipSync(body) : body;
  if ((type ?? "").includes("json")) {
    return JSON.parse(raw.toString("utf8")) as OtlpTraceRequest;
  }
  return decodeTraceRequest(raw);
}

function spanCount(request: OtlpTraceRequest): number {
  let count = 0;
  for (const resource of request.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      count += scope.spans?.length ?? 0;
    }
  }
  return count;
}

export async function record(options: RecordOptions): Promise<RecordResult> {
  fs.writeFileSync(options.out, "");
  const totals = { requests: 0, spans: 0 };
  const server = http.createServer(async (request, response) => {
    const body = await bodyOf(request);
    const type = request.headers["content-type"];
    // Metrics and logs are acknowledged and dropped; only traces matter here.
    if (request.method === "POST" && request.url?.startsWith("/v1/traces")) {
      const traces = decoded(body, request.headers["content-encoding"], type);
      fs.appendFileSync(options.out, `${JSON.stringify(traces)}\n`);
      totals.requests += 1;
      totals.spans += spanCount(traces);
    }
    const json = (type ?? "").includes("json");
    response.writeHead(200, {
      "content-type": json ? "application/json" : "application/x-protobuf",
    });
    response.end(json ? "{}" : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const [program, ...args] = options.command;
  if (program === undefined) {
    throw new Error("record needs a command to run after --");
  }
  const child = spawn(program, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      // The cloud detectors ask metadata servers off this machine.
      OTEL_NODE_RESOURCE_DETECTORS: "env,host,os,process",
      // A test run makes spans faster than the default queue drains.
      OTEL_BSP_MAX_QUEUE_SIZE: "100000",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "2048",
      OTEL_BSP_SCHEDULE_DELAY: "1000",
    },
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
  await new Promise((resolve) => setTimeout(resolve, options.drainMs ?? 3000));
  await new Promise((resolve) => server.close(resolve));
  return { exitCode, ...totals };
}
