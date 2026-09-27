import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { EffectSchema } from "@suss/behavioral-ir/schemas";
import { createTestProject } from "@suss/test-project";

import nodeRuntimePack from "./index.js";
import { streamWriteRecognizer } from "./streamWrites.js";

import type { Effect } from "@suss/behavioral-ir";

type StreamWrite = Extract<Effect, { type: "interaction" }> & {
  interaction: { class: "stream-write" };
};

function storeFor(file: SourceFile): ResolutionStore {
  const store = ResolutionStore.forPacks([nodeRuntimePack()]);
  const files = file
    .getProject()
    .getSourceFiles()
    .filter((one) => !one.isInNodeModules());
  store.extractFiles(files);
  store.notePossibleCallers(files);
  return store;
}

function writesIn(source: string): StreamWrite[] {
  const file = createTestProject().createSourceFile("cli.ts", source);
  const store = storeFor(file);
  const found: StreamWrite[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = invocationContextFor(node as CallExpression, store);
    for (const effect of streamWriteRecognizer(node, ctx) ?? []) {
      found.push(effect as StreamWrite);
    }
  });
  return found;
}

function targetsOf(writes: StreamWrite[]): Array<string | null> {
  return writes.map((write) =>
    write.binding.semantics.name === "io"
      ? write.binding.semantics.target
      : "not io",
  );
}

describe("writes to the process's streams", () => {
  it("sends console output to the stream Node sends it to", () => {
    const writes = writesIn(`
      export function report(id: string) {
        console.log("order received", id);
        console.info("still going");
        console.error("failed");
        console.warn("careful");
      }
    `);
    expect(targetsOf(writes)).toEqual(["stdout", "stdout", "stderr", "stderr"]);
    expect(writes[0]?.callee).toBe("console.log");
  });

  it("reads a JSON report as the shape of what was serialized", () => {
    const [write] = writesIn(`
      export function print() {
        const report = { run: [{ kind: "nothingPaired" }] };
        process.stdout.write(\`\${JSON.stringify(report, null, 2)}\\n\`);
      }
    `);
    expect(write?.interaction.serialized).toBe("json");
    expect(write?.interaction.payload).toMatchObject({
      type: "record",
      properties: { run: { type: "array" } },
    });
    expect(write?.binding.semantics).toEqual({ name: "io", target: "stdout" });
  });

  it("keeps a text write as text, and says where each write is", () => {
    const writes = writesIn(`
      export function fail() {
        process.stderr.write("no summaries\\n");
        process.stderr.write("try again\\n");
      }
    `);
    expect(writes.map((write) => write.interaction.serialized)).toEqual([
      "text",
      "text",
    ]);
    expect(writes.map((write) => write.groupId)).toEqual(["3:9", "4:9"]);
    for (const write of writes) {
      expect(EffectSchema.safeParse(write).success).toBe(true);
    }
  });

  it("keys several arguments by position", () => {
    const [write] = writesIn(`
      export function say(id: number) {
        console.log("order", id);
      }
    `);
    expect(write?.interaction.payload).toEqual({
      type: "record",
      properties: {
        "0": { type: "literal", value: "order" },
        "1": { type: "number" },
      },
    });
  });

  it("follows a stream a caller passes into a helper", () => {
    const writes = writesIn(`
      function say(out: NodeJS.WritableStream, line: string) {
        out.write(line);
      }
      export function run() {
        say(process.stderr, "done");
      }
    `);
    expect(targetsOf(writes)).toEqual(["stderr"]);
  });

  it("writes to no stream in particular when two callers pass different ones", () => {
    const writes = writesIn(`
      function say(out, line: string) {
        out.write(line);
      }
      export function run() {
        say(process.stdout, "ok");
        say(process.stderr, "not ok");
      }
    `);
    expect(targetsOf(writes)).toEqual([null]);
  });

  it("takes an annotated stream parameter nobody calls as a write to an unknown stream", () => {
    const writes = writesIn(`
      export function say(out: NodeJS.WriteStream, line: string) {
        out.write(line);
      }
    `);
    expect(targetsOf(writes)).toEqual([null]);
  });

  it("leaves a write to anything else alone", () => {
    const writes = writesIn(`
      import * as fs from "node:fs";
      export function save(file: fs.WriteStream, logger: { info(m: string): void }) {
        file.write("row");
        logger.info("saved");
        [1].map((n) => n);
      }
    `);
    expect(writes).toEqual([]);
  });
});
